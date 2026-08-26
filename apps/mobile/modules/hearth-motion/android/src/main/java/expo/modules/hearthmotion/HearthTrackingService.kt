package expo.modules.hearthmotion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import org.json.JSONObject

/**
 * The foreground service behind every moving tier, and the "Updating your
 * location" line that goes with it. It owns the location request, so the
 * fixes of a journey are taken and kept whether or not JavaScript is up,
 * and it is started natively by the receivers inside the moment Android
 * allows a start from the background: a geofence exit, an activity
 * transition, a high priority push, boot. JavaScript, when it comes,
 * swaps the request for the tier it decides on, and stops the service
 * when the phone parks.
 *
 * Brief is the same service up for one fix: a wake on a parked phone, or
 * a walk being confirmed. It stops itself after the fix's own deadline
 * unless a tracking request has replaced it by then.
 */
class HearthTrackingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val briefStop = Runnable { if (request == null) stopSelfGracefully("brief") }
  private var client: FusedLocationProviderClient? = null
  private var callback: LocationCallback? = null
  private var request: ServiceRequest? = null
  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Foreground first, whatever the command: Android gives a started
    // service seconds to get there, and a refusal is only known here.
    if (!ensureForeground()) return START_NOT_STICKY
    when (intent?.action) {
      ACTION_STOP -> {
        stopSelfGracefully("asked")
        return START_NOT_STICKY
      }
      ACTION_STOP_BRIEF -> {
        if (request == null) stopSelfGracefully("brief")
        return START_NOT_STICKY
      }
      ACTION_BRIEF -> {
        if (request == null) {
          status = "brief"
          handler.removeCallbacks(briefStop)
          handler.postDelayed(briefStop, BRIEF_LIFETIME_MS)
          bootJavaScript("brief")
        }
        return START_NOT_STICKY
      }
      ACTION_TRACK -> {
        // A stop asked for while this start was still on its way: the
        // stop could not be delivered to a service not yet running, so it
        // is honoured here instead.
        if (cancelPendingStart) {
          cancelPendingStart = false
          stopSelfGracefully("cancelled")
          return START_NOT_STICKY
        }
        val next = ServiceRequest.fromIntent(intent) ?: TrackerPrefs(this).movingRequest
        track(next, intent.getStringExtra(EXTRA_REASON) ?: "js")
        return START_STICKY
      }
      else -> {
        // A sticky restart after the OS killed the service mid journey.
        val prefs = TrackerPrefs(this)
        val wanted = prefs.serviceRequest?.takeIf { prefs.serviceWanted }
        if (wanted == null) {
          stopSelfGracefully("restart")
          return START_NOT_STICKY
        }
        track(wanted, "restart")
        return START_STICKY
      }
    }
  }

  private fun ensureForeground(): Boolean {
    if (inForeground) return true
    return try {
      val notification = buildNotification(this)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceCompat.startForeground(
          this,
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      inForeground = true
      foreground = true
      true
    } catch (error: Exception) {
      // Android 12 and later refuse the foreground here as well as at the
      // start call, when the start came from the background outside its
      // allowed moments.
      Log.w(TAG, "Foreground refused: ${error.message}")
      status = "refused"
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "refused").put("reason", "foreground"))
      stopSelf()
      false
    }
  }

  private fun track(next: ServiceRequest, reason: String) {
    val prefs = TrackerPrefs(this)
    prefs.serviceRequest = next
    prefs.serviceWanted = true
    handler.removeCallbacks(briefStop)
    if (next == request && callback != null) {
      status = "running"
      return
    }
    val client = client ?: LocationServices.getFusedLocationProviderClient(this).also { client = it }
    callback?.let { client.removeLocationUpdates(it) }
    val listener =
      object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
          for (location in result.locations) TrackerQueue.fix(this@HearthTrackingService, location)
          if (result.locations.isNotEmpty()) TrackerQueue.poke(this@HearthTrackingService)
        }
      }
    try {
      client.requestLocationUpdates(next.toLocationRequest(), listener, Looper.getMainLooper())
    } catch (error: SecurityException) {
      // The location permission went while the service was wanted. There
      // is nothing to run, and JavaScript reads the permission on its own.
      Log.w(TAG, "Location request refused: ${error.message}")
      stopSelfGracefully("permission")
      return
    }
    callback = listener
    request = next
    status = "running"
    TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "started").put("reason", reason))
    bootJavaScript(reason)
  }

  /**
   * JavaScript is woken once the service is up, not before: a process
   * with a foreground service may start the headless task, and the poke
   * for the queue does the same for every fix after. Posted rather than
   * done here, so the foreground the system was just told about has
   * settled before the process leans on it.
   */
  private fun bootJavaScript(reason: String) {
    if (HearthEvents.emit("onNativeQueue", emptyMap())) return
    handler.postDelayed({ HearthHeadlessService.start(this, reason) }, HEADLESS_START_DELAY_MS)
  }

  private fun stopSelfGracefully(reason: String) {
    handler.removeCallbacks(briefStop)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    val wasTracking = request != null
    request = null
    val prefs = TrackerPrefs(this)
    prefs.serviceWanted = false
    if (wasTracking) {
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "stopped").put("reason", reason))
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    inForeground = false
    foreground = false
    status = "none"
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(briefStop)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    request = null
    inForeground = false
    foreground = false
    // Killed under a journey: serviceWanted stays, and the sticky restart
    // picks the request back up.
    status = "none"
    super.onDestroy()
  }

  companion object {
    private const val TAG = "HearthTracking"
    private const val ACTION_TRACK = "expo.modules.hearthmotion.TRACK"
    private const val ACTION_BRIEF = "expo.modules.hearthmotion.BRIEF"
    private const val ACTION_STOP = "expo.modules.hearthmotion.STOP"
    private const val ACTION_STOP_BRIEF = "expo.modules.hearthmotion.STOP_BRIEF"
    private const val EXTRA_REASON = "reason"
    const val CHANNEL_ID = "hearth-wake"
    private const val NOTIFICATION_ID = 7421
    /** The fix's own deadline, so a brief service never outlives it. */
    private const val BRIEF_LIFETIME_MS = 30_000L
    private const val HEADLESS_START_DELAY_MS = 300L

    /** "none", "brief", "starting", "running" or "refused", as JavaScript reads it. */
    @Volatile
    var status: String = "none"
      private set

    /** Whether the service holds the foreground right now, which is what lets the process start another service. */
    @Volatile
    var foreground: Boolean = false
      private set

    @Volatile
    private var cancelPendingStart = false

    /**
     * Runs the service with this request, or swaps the request on a
     * running one. The answer is what the start came to: Android 12 and
     * later throw at the start call itself when a background app is
     * outside its allowed moments, and that is "refused".
     */
    internal fun start(context: Context, request: ServiceRequest, reason: String): String {
      val intent =
        request.putInto(Intent(context, HearthTrackingService::class.java).setAction(ACTION_TRACK))
          .putExtra(EXTRA_REASON, reason)
      cancelPendingStart = false
      return try {
        ContextCompat.startForegroundService(context, intent)
        if (status != "running") status = "starting"
        status
      } catch (error: Exception) {
        Log.w(TAG, "Start refused ($reason): ${error.message}")
        status = "refused"
        TrackerQueue.event(context, JSONObject().put("type", "service").put("status", "refused").put("reason", reason))
        "refused"
      }
    }

    /** The service up for one fix. True when Android accepted the start, or it was up already. */
    fun brief(context: Context): Boolean {
      if (status == "running" || status == "brief") return true
      val intent = Intent(context, HearthTrackingService::class.java).setAction(ACTION_BRIEF)
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (error: Exception) {
        Log.w(TAG, "Brief start refused: ${error.message}")
        false
      }
    }

    fun stop(context: Context) {
      if (status == "none" || status == "refused") return
      if (status == "starting") {
        cancelPendingStart = true
        return
      }
      send(context, ACTION_STOP)
    }

    /** Takes a brief service down; a tracking one stays. */
    fun stopBrief(context: Context) {
      if (status != "brief") return
      send(context, ACTION_STOP_BRIEF)
    }

    private fun send(context: Context, action: String) {
      val intent = Intent(context, HearthTrackingService::class.java).setAction(action)
      try {
        // A running foreground service makes the app foreground, so a
        // plain start reaches it; one not running has nothing to stop.
        context.startService(intent)
      } catch (error: Exception) {
        // The status was stale: no service is running to take the stop.
        Log.w(TAG, "$action not delivered: ${error.message}")
        status = "none"
        foreground = false
      }
    }

    private fun buildNotification(context: Context): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        // The lowest importance: no sound, no status bar icon on most
        // launchers, collapsed in the silent part of the shade.
        val channel = NotificationChannel(CHANNEL_ID, "Location updates", NotificationManager.IMPORTANCE_MIN)
        channel.description = "Shown while Hearth updates your location on a journey."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val icon = context.applicationInfo.icon
      val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(context)
      return builder
        .setContentTitle("Hearth")
        .setContentText("Updating your location")
        .setSmallIcon(icon)
        // Not ongoing: from Android 13 the person may swipe it away, and
        // the service runs on without it.
        .setOngoing(false)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build()
    }
  }
}
