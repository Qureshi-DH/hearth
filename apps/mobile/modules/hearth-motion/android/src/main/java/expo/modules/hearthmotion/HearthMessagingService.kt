package expo.modules.hearthmotion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import android.util.Log
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Sits in front of expo-notifications' own service (the manifest gives it
 * the higher priority) so a ping or a watch is answered inside the message
 * handler, the one moment a background app is allowed to start a service
 * on Android 12 and later. With an upload key the service answers on its
 * own, and the push goes no further: expo would start JavaScript for it,
 * every few minutes all day, to learn what the service already did.
 * Without a key the service comes up brief and JavaScript takes the fix.
 * Every other message goes on to expo-notifications as before. Expo packs
 * the push's data as a JSON string under "body".
 */
class HearthMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    HearthDiagnostics.onProcessStart(this)
    val answered = ask(remoteMessage)?.let { answer(it, remoteMessage) } ?: false
    if (!answered) super.onMessageReceived(remoteMessage)
  }

  private data class Ask(val type: String, val seconds: Long, val ping: Boolean)

  private fun ask(remoteMessage: RemoteMessage): Ask? {
    val body = remoteMessage.data["body"] ?: return null
    return try {
      val json = JSONObject(body)
      when (val type = json.optString("type")) {
        "wake", "watch", "nudge_requested" ->
          Ask(type, json.optLong("seconds", 0L), json.optBoolean("ping", false))
        else -> null
      }
    } catch (error: Exception) {
      null
    }
  }

  /**
   * True when the push was answered here and JavaScript need not hear of it.
   * A nudge is a notification somebody sent, and goes on to be shown
   * whatever was done with it here.
   */
  private fun answer(ask: Ask, message: RemoteMessage): Boolean {
    HearthDiagnostics.push(this, ask.type, message)
    val shown = ask.type == "nudge_requested"
    // Sharing off or signed out, the tracker takes no fix for the push, and
    // the service would only put "Updating your location" on the shade.
    val prefs = TrackerPrefs(this)
    if (!prefs.enabled || prefs.mode == "off") return !shown
    if (!NativeUploader.ready(this)) {
      HearthTrackingService.brief(this)
      return false
    }
    if (ask.type == "watch" && ask.seconds <= 0) {
      HearthTrackingService.unwatch(this)
      return !shown
    }
    // The server's ping, to a phone the motion sensor has had lying still
    // since its last fix: that fix is where it is, and it goes again from
    // here without location or the service. An ask somebody made, a page
    // opened, always gets a fresh one.
    if (ask.type == "wake" && ask.ping && !HearthTrackingService.foreground && answerStill(prefs)) {
      return true
    }
    // A push FCM demoted cannot start a service, unless the person took
    // Hearth out of battery optimisation, so it is not tried.
    val started =
      startAllowed(message) &&
        if (ask.type == "watch") {
          HearthTrackingService.watch(this, ask.seconds, "push")
        } else {
          HearthTrackingService.ping(this, "push")
        }
    if (!started) answerWithoutService()
    return !shown
  }

  private fun startAllowed(message: RemoteMessage): Boolean {
    if (message.priority == RemoteMessage.PRIORITY_HIGH) return true
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    return power?.isIgnoringBatteryOptimizations(packageName) == true
  }

  private fun answerStill(prefs: TrackerPrefs): Boolean {
    // The classifier's word holds only while it is listening, and a repeat
    // goes on reporting a place: neither without its permission.
    if (!prefs.motionWanted || !granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !granted(Manifest.permission.ACTIVITY_RECOGNITION)) {
      prefs.forgetActivity()
      return false
    }
    val last = prefs.lastFix ?: return false
    val lastAt = runCatching { last.getLong("timestamp") }.getOrNull()
    if (!Departure.stillSinceLastFix(prefs.activity, prefs.activitySince, lastAt, System.currentTimeMillis())) {
      return false
    }
    NativeUploader.sendStill(this, last)
    val sent = NativeUploader.sendNow(this, SEND_TIMEOUT_MS)
    TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true).put("still", true).put("sent", sent))
    // Somebody opened Live and its push never came: the reply says so, and
    // this handler is still inside the moment Android allows the start.
    val reply = NativeUploader.lastReply
    val remaining =
      if (reply?.watchedUntil != null && reply.serverTime != null) reply.watchedUntil - reply.serverTime else 0L
    if (sent && remaining > 0) HearthTrackingService.watch(this, remaining / 1000, "reply")
    return true
  }

  private fun granted(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

  /**
   * Android refused the service, most often because FCM no longer called
   * the push urgent. A phone allowed its location all the time may still
   * take one fix in the background, so it does, on this thread, and sends
   * it before the handler's time is up. Live gets one dot rather than none,
   * and the server asks again.
   */
  private fun answerWithoutService() {
    val location =
      try {
        val request =
          CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
            .setMaxUpdateAgeMillis(FIX_MAX_AGE_MS)
            .setDurationMillis(FIX_TIMEOUT_MS)
            .build()
        Tasks.await(
          LocationServices.getFusedLocationProviderClient(this).getCurrentLocation(request, null),
          FIX_TIMEOUT_MS + 1_000,
          TimeUnit.MILLISECONDS,
        )
      } catch (error: Exception) {
        Log.i(TAG, "no fix without the service: ${error.message}")
        null
      }
    if (location == null) {
      TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true).put("service", false).put("fix", false))
      return
    }
    NativeUploader.send(this, location, "nudge")
    val sent = NativeUploader.sendNow(this, SEND_TIMEOUT_MS)
    TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true).put("service", false).put("sent", sent))
  }

  companion object {
    private const val TAG = "HearthMessaging"
    /**
     * The handler thread is the one every push waits on, and the next one's
     * moment to start the service runs out while this one holds it, so the
     * fallback is kept short.
     */
    private const val FIX_TIMEOUT_MS = 5_000L
    private const val SEND_TIMEOUT_MS = 4_000L
    private const val FIX_MAX_AGE_MS = 60_000L
  }
}
