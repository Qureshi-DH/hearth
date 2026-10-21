package expo.modules.hearthmotion

import android.content.Context
import android.os.PowerManager
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
 * the higher priority) so a wake or a watch is answered inside the message
 * handler, the one moment a background app is allowed to start a service
 * on Android 12 and later. With an upload key the service answers on its
 * own. Without one it comes up brief and JavaScript takes the fix, as it
 * did before servers handed out keys. Everything else about the message
 * goes on to expo-notifications as before. Expo packs the push's data as a
 * JSON string under "body".
 */
class HearthMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    HearthDiagnostics.onProcessStart(this)
    ask(remoteMessage)?.let { answer(it, remoteMessage) }
    super.onMessageReceived(remoteMessage)
  }

  private data class Ask(val type: String, val seconds: Long)

  private fun ask(remoteMessage: RemoteMessage): Ask? {
    val body = remoteMessage.data["body"] ?: return null
    return try {
      val json = JSONObject(body)
      when (val type = json.optString("type")) {
        "wake", "watch", "nudge_requested" -> Ask(type, json.optLong("seconds", 0L))
        else -> null
      }
    } catch (error: Exception) {
      null
    }
  }

  private fun answer(ask: Ask, message: RemoteMessage) {
    HearthDiagnostics.push(this, ask.type, message)
    // Sharing off or signed out, the tracker takes no fix for the push, and
    // the service would only put "Updating your location" on the shade.
    val prefs = TrackerPrefs(this)
    if (!prefs.enabled || prefs.mode == "off") return
    if (!NativeUploader.ready(this)) {
      HearthTrackingService.brief(this)
      return
    }
    if (ask.type == "watch" && ask.seconds <= 0) {
      HearthTrackingService.unwatch(this)
      return
    }
    // A push FCM demoted cannot start a service, unless the person took
    // Hearth out of battery optimisation, so it is not tried.
    val started =
      startAllowed(message) &&
        if (ask.type == "watch") {
          HearthTrackingService.watch(this, ask.seconds, "push")
        } else {
          HearthTrackingService.wake(this, "push")
        }
    if (!started) answerWithoutService()
  }

  private fun startAllowed(message: RemoteMessage): Boolean {
    if (message.priority == RemoteMessage.PRIORITY_HIGH) return true
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    return power?.isIgnoringBatteryOptimizations(packageName) == true
  }

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
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
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
