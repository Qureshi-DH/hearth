package expo.modules.hearthmotion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import org.json.JSONObject

/**
 * The foreground service behind every moving tier and behind a parked phone
 * somebody is watching live, and the "Updating your location" line that
 * goes with it. It owns the location request, so the
 * fixes of a journey are taken and kept whether or not JavaScript is up,
 * and it is started natively by the receivers inside the moment Android
 * allows a start from the background: a geofence exit, an activity
 * transition, a high priority push, boot. JavaScript, when it comes,
 * swaps the request for the tier it decides on, and stops the service
 * when the phone parks with nobody watching, or the watch ends.
 *
 * A wake and a watch are answered here when the server gave this session
 * an upload key. A wake is one good fix, sent, and the service goes once
 * the server has it. A watch is a fix a second, each sent as it comes, for
 * as long as the server's answers say somebody is looking. JavaScript is
 * told and learns from the fixes, but nothing waits for it.
 *
 * Brief is the same service up for one fix that JavaScript takes, for a
 * wake on a phone with no upload key or a walk being confirmed. It stops itself
 * after the fix's own deadline unless a tracking request has replaced it.
 */
class HearthTrackingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val briefStop = Runnable { if (request == null) stopSelfGracefully("brief") }
  private val watchCheck = Runnable { if (!window.active(SystemClock.elapsedRealtime())) endWatch("over") }
  private val wakeDeadline = Runnable { answerWakeWithBest() }
  private val idleCap = Runnable { stopNow(stopReason ?: "idle") }
  private var client: FusedLocationProviderClient? = null
  private var callback: LocationCallback? = null
  private var request: ServiceRequest? = null
  private var inForeground = false
  /** The newest start, so a stop decided before it arrived does not take it down. */
  private var lastStartId = 0

  /** The tier JavaScript asked for, which a watch sits on top of and goes back to. */
  private var base: ServiceRequest? = null
  private val window = WatchWindow()
  private var waking = false
  private var wakeBest: Location? = null
  /** Set when the service should go as soon as the uploader has sent what it holds. */
  private var stopReason: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    HearthDiagnostics.onProcessStart(this)
    NativeUploader.listener = uploads
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    // Foreground first, whatever the command and every time: Android wants
    // it after each foreground start, the person may have swiped the
    // notification, and a refusal is only known here.
    if (!ensureForeground()) return START_NOT_STICKY
    when (intent?.action) {
      ACTION_STOP -> {
        // A stop JavaScript asks for while the service answers a wake or a
        // watch only ends its tier, and the answer goes on. A stop for
        // signing out or sharing off ends everything.
        val answering = window.active(SystemClock.elapsedRealtime()) || waking || stopReason != null
        if (!intent.getBooleanExtra(EXTRA_FORCE, false) && answering) {
          base = null
          TrackerPrefs(this).serviceWanted = false
          return START_NOT_STICKY
        }
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
        return restartPolicy()
      }
      ACTION_WAKE -> {
        wake()
        return restartPolicy()
      }
      ACTION_WATCH -> {
        watch(intent.getLongExtra(EXTRA_SECONDS, 0L))
        return restartPolicy()
      }
      ACTION_UNWATCH -> {
        if (window.until != 0L) endWatch("ended")
        return restartPolicy()
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
        base = next
        if (window.active(SystemClock.elapsedRealtime()) && next != LIVE) {
          // Somebody is watching. The tier is kept for when they stop.
          remember(next)
          return START_STICKY
        }
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
        base = wanted
        track(wanted, "restart")
        return START_STICKY
      }
    }
  }

  /** Sticky only while JavaScript wants a tier. A wake or a watch alone is asked for again by the server. */
  private fun restartPolicy(): Int = if (base != null) START_STICKY else START_NOT_STICKY

  private fun ensureForeground(): Boolean {
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
      // allowed moments. A service already in the foreground stays there.
      if (inForeground) return true
      Log.w(TAG, "Foreground refused: ${error.message}")
      status = "refused"
      TrackerQueue.event(
        this,
        JSONObject().put("type", "service").put("status", "refused").put("reason", "foreground").put("error", error.javaClass.simpleName),
      )
      stopSelf()
      false
    }
  }

  private fun track(next: ServiceRequest, reason: String) {
    remember(next)
    stopReason = null
    handler.removeCallbacks(briefStop)
    handler.removeCallbacks(idleCap)
    if (next == request && callback != null) {
      status = "running"
      HearthHeadlessService.keepAwake(this)
      return
    }
    if (!run(next)) return
    status = "running"
    TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "started").put("reason", reason))
    bootJavaScript(reason)
    HearthHeadlessService.keepAwake(this)
  }

  private fun remember(next: ServiceRequest) {
    val prefs = TrackerPrefs(this)
    prefs.serviceRequest = next
    prefs.serviceWanted = true
  }

  /** Swaps the location request. False when the permission has gone, and the service with it. */
  private fun run(next: ServiceRequest): Boolean {
    if (next == request && callback != null) return true
    val client = client ?: LocationServices.getFusedLocationProviderClient(this).also { client = it }
    callback?.let { client.removeLocationUpdates(it) }
    val listener =
      object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
          for (location in result.locations) onFix(location)
          if (result.locations.isNotEmpty()) {
            TrackerQueue.poke(this@HearthTrackingService)
            HearthHeadlessService.keepAwake(this@HearthTrackingService)
          }
        }
      }
    try {
      client.requestLocationUpdates(next.toLocationRequest(), listener, Looper.getMainLooper())
    } catch (error: SecurityException) {
      // The location permission went while the service was wanted. There
      // is nothing to run, and JavaScript reads the permission on its own.
      Log.w(TAG, "Location request refused: ${error.message}")
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "refused").put("reason", "permission"))
      stopSelfGracefully("permission")
      return false
    }
    callback = listener
    request = next
    return true
  }

  private fun onFix(location: Location) {
    val now = SystemClock.elapsedRealtime()
    if (window.active(now) && NativeUploader.ready(this)) {
      NativeUploader.send(this, location, "background")
      if (waking) finishWake()
      return
    }
    if (waking) {
      if (goodEnough(location)) {
        sendWake(location)
        return
      }
      if (fresh(location) && better(location, wakeBest)) wakeBest = location
    }
    // Only fixes a tier asked for are JavaScript's to judge. The wake's
    // own request is not one, and its near misses would read as a phone
    // wandering about its stop. A tier's fix is sent from here as well:
    // One UI holds back JavaScript's timers in the background, and a
    // journey waited for the screen to come on.
    if (base == null) return
    if (NativeUploader.ready(this)) NativeUploader.send(this, location, "background")
    else TrackerQueue.fix(this, location)
  }

  /** One good fix, sent from here. A phone already reporting sends its next one. */
  private fun wake() {
    if (!NativeUploader.ready(this)) {
      // With no key to send with, JavaScript takes the fix, as before.
      if (request == null) {
        status = "brief"
        handler.removeCallbacks(briefStop)
        handler.postDelayed(briefStop, BRIEF_LIFETIME_MS)
        bootJavaScript("brief")
      }
      return
    }
    TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true))
    if (window.active(SystemClock.elapsedRealtime())) return
    stopReason = null
    handler.removeCallbacks(idleCap)
    handler.removeCallbacks(briefStop)
    resumeTier()
    waking = true
    wakeBest = null
    handler.removeCallbacks(wakeDeadline)
    handler.postDelayed(wakeDeadline, WAKE_FIX_MS)
    if (request == null) {
      if (!run(WAKE)) return
      status = "brief"
    }
  }

  private fun sendWake(location: Location) {
    NativeUploader.send(this, location, "nudge")
    // The tier's own stream keeps the fix too, so a moving phone's
    // journey is judged from it.
    finishWake()
  }

  private fun answerWakeWithBest() {
    if (!waking) return
    val best = wakeBest
    if (best != null) {
      sendWake(best)
      return
    }
    // Nothing came. The last fix the system holds is better than silence
    // if it is recent, and the server's next wake tries again otherwise.
    val client = client ?: LocationServices.getFusedLocationProviderClient(this).also { client = it }
    try {
      client.lastLocation.addOnCompleteListener { task ->
        val last = if (task.isSuccessful) task.result?.takeIf { ageMs(it) < LAST_KNOWN_MAX_AGE_MS } else null
        if (last != null && waking) {
          sendWake(last)
        } else {
          TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true).put("fix", false))
          finishWake()
        }
      }
    } catch (error: SecurityException) {
      finishWake()
    }
  }

  private fun finishWake() {
    waking = false
    wakeBest = null
    handler.removeCallbacks(wakeDeadline)
    if (base == null && !window.active(SystemClock.elapsedRealtime())) stopWhenSent("wake")
  }

  /** A fix a second, sent as it comes, until the server's answers say nobody is looking. */
  private fun watch(seconds: Long) {
    if (!NativeUploader.ready(this)) {
      // JavaScript upgrades the brief service to the live request, as before.
      if (request == null) {
        status = "brief"
        handler.removeCallbacks(briefStop)
        handler.postDelayed(briefStop, BRIEF_LIFETIME_MS)
        bootJavaScript("brief")
      }
      return
    }
    if (seconds <= 0) {
      if (window.until != 0L) endWatch("ended")
      return
    }
    resumeTier()
    val change = window.open(SystemClock.elapsedRealtime(), minOf(seconds, MAX_WATCH_SECONDS))
    goLive(change == WatchWindow.Change.OPENED, "push")
  }

  /**
   * A push is one of the moments Android allows a start, so a phone on the
   * move whose service was refused or killed gets its tier back with the
   * answer, without waiting for JavaScript to notice.
   */
  private fun resumeTier() {
    if (request != null || base != null) return
    val prefs = TrackerPrefs(this)
    if (!prefs.enabled || prefs.mode != "moving") return
    val tier = prefs.serviceRequest ?: prefs.movingRequest
    base = tier
    track(tier, "push")
  }

  private fun goLive(announce: Boolean, reason: String) {
    stopReason = null
    handler.removeCallbacks(idleCap)
    handler.removeCallbacks(briefStop)
    if (!run(LIVE)) return
    status = "running"
    handler.removeCallbacks(watchCheck)
    handler.postDelayed(watchCheck, (window.until - SystemClock.elapsedRealtime()).coerceAtLeast(0) + 1_000)
    if (announce) {
      TrackerQueue.event(
        this,
        JSONObject().put("type", "watch").put("until", System.currentTimeMillis() + (window.until - SystemClock.elapsedRealtime())).put("reason", reason),
      )
      bootJavaScript("watch")
    }
    HearthHeadlessService.keepAwake(this)
  }

  private fun endWatch(reason: String) {
    window.close()
    handler.removeCallbacks(watchCheck)
    TrackerQueue.event(this, JSONObject().put("type", "watch over").put("reason", reason))
    TrackerQueue.poke(this)
    val tier = base
    when {
      tier != null -> track(tier, "watch over")
      waking -> run(WAKE)
      else -> stopWhenSent("watch over")
    }
  }

  /** Goes once the server has what the uploader holds, or after a cap so a dead network cannot keep it. */
  private fun stopWhenSent(reason: String) {
    stopReason = reason
    handler.removeCallbacks(idleCap)
    if (NativeUploader.idle(this)) {
      stopNow(reason)
      return
    }
    // The fix waits in the uploader. Location is not needed for it.
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    request = null
    handler.postDelayed(idleCap, SEND_CAP_MS)
  }

  private fun stopNow(reason: String) {
    // What could not be sent in time goes to JavaScript to send.
    NativeUploader.handOver(this)
    stopSelfGracefully(reason)
  }

  /** The server's answers move the watch, and the last fix sent lets a service that is done go. */
  private val uploads =
    object : NativeUploader.Listener {
      override fun onReply(reply: UploadWire.Reply, sentAt: Long) {
        handler.post {
          when (window.follow(reply, sentAt, SystemClock.elapsedRealtime())) {
            WatchWindow.Change.ENDED -> endWatch("released")
            WatchWindow.Change.OPENED -> goLive(true, "reply")
            WatchWindow.Change.MOVED -> {
              handler.removeCallbacks(watchCheck)
              handler.postDelayed(watchCheck, (window.until - SystemClock.elapsedRealtime()).coerceAtLeast(0) + 1_000)
            }
            WatchWindow.Change.NONE -> Unit
          }
        }
      }

      override fun onIdle() {
        handler.post { stopReason?.let { if (NativeUploader.idle(this@HearthTrackingService)) stopNow(it) } }
      }
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
    handler.removeCallbacks(watchCheck)
    handler.removeCallbacks(wakeDeadline)
    handler.removeCallbacks(idleCap)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    val wasTracking = request != null || base != null
    request = null
    base = null
    window.close()
    waking = false
    stopReason = null
    val prefs = TrackerPrefs(this)
    prefs.serviceWanted = false
    if (wasTracking) {
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "stopped").put("reason", reason))
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    inForeground = false
    foreground = false
    status = "none"
    // A push may have started the service again while this stop was being
    // decided. Then the service stays for that start, which puts it back in
    // the foreground, rather than Android ending the service under it.
    stopSelfResult(lastStartId)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    request = null
    inForeground = false
    foreground = false
    if (NativeUploader.listener === uploads) NativeUploader.listener = null
    // Killed under a journey: serviceWanted stays, and the sticky restart
    // picks the request back up.
    status = "none"
    super.onDestroy()
  }

  private fun goodEnough(location: Location): Boolean =
    fresh(location) && location.hasAccuracy() && location.accuracy <= WAKE_GOOD_ACCURACY_METERS

  private fun fresh(location: Location): Boolean = ageMs(location) < FRESH_FIX_MS

  private fun better(location: Location, than: Location?): Boolean =
    than == null || (location.hasAccuracy() && (!than.hasAccuracy() || location.accuracy < than.accuracy))

  private fun ageMs(location: Location): Long =
    (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000

  companion object {
    private const val TAG = "HearthTracking"
    private const val ACTION_TRACK = "expo.modules.hearthmotion.TRACK"
    private const val ACTION_BRIEF = "expo.modules.hearthmotion.BRIEF"
    private const val ACTION_WAKE = "expo.modules.hearthmotion.WAKE"
    private const val ACTION_WATCH = "expo.modules.hearthmotion.WATCH"
    private const val ACTION_UNWATCH = "expo.modules.hearthmotion.UNWATCH"
    private const val ACTION_STOP = "expo.modules.hearthmotion.STOP"
    private const val ACTION_STOP_BRIEF = "expo.modules.hearthmotion.STOP_BRIEF"
    private const val EXTRA_REASON = "reason"
    private const val EXTRA_SECONDS = "seconds"
    private const val EXTRA_FORCE = "force"
    const val CHANNEL_ID = "hearth-wake"
    private const val NOTIFICATION_ID = 7421
    /** The fix's own deadline, so a brief service never outlives it. */
    private const val BRIEF_LIFETIME_MS = 30_000L
    private const val HEADLESS_START_DELAY_MS = 300L

    /** What Live runs, a fix a second wherever the phone is. The tracker's own figure. */
    private val LIVE = ServiceRequest("high", 1_000L, 0f)
    /** A wake asks for the best the phone can do, and takes the first fix that is good enough. */
    private val WAKE = ServiceRequest("high", 1_000L, 0f)
    private const val WAKE_GOOD_ACCURACY_METERS = 50f
    /** How long a wake waits for a good fix before it sends the best one it has. */
    private const val WAKE_FIX_MS = 20_000L
    /** Play Services may hand over the last fix it had first, and that is not now. */
    private const val FRESH_FIX_MS = 60_000L
    private const val LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000L
    /** The longest the service stays up for the uploader once it is done otherwise. */
    private const val SEND_CAP_MS = 45_000L
    /** The server's own longest window, so a push cannot ask for an hour. */
    private const val MAX_WATCH_SECONDS = 10 * 60L

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
      return if (deliver(context, intent, reason)) {
        if (status != "running") status = "starting"
        status
      } else {
        status = "refused"
        "refused"
      }
    }

    /** The service up for one fix JavaScript takes. True when Android accepted the start. */
    fun brief(context: Context): Boolean =
      deliver(context, Intent(context, HearthTrackingService::class.java).setAction(ACTION_BRIEF), "brief")

    /** One good fix, sent from here when the server gave a key. False when Android refused the start. */
    fun wake(context: Context, reason: String): Boolean =
      deliver(context, Intent(context, HearthTrackingService::class.java).setAction(ACTION_WAKE), reason)

    /** Live for this long, or until the server's answers say nobody is looking. */
    fun watch(context: Context, seconds: Long, reason: String): Boolean =
      deliver(
        context,
        Intent(context, HearthTrackingService::class.java).setAction(ACTION_WATCH).putExtra(EXTRA_SECONDS, seconds),
        reason,
      )

    fun unwatch(context: Context) {
      if (status == "none" || status == "refused") return
      send(context, ACTION_UNWATCH)
    }

    fun stop(context: Context, force: Boolean = false) {
      if (status == "none" || status == "refused") return
      if (status == "starting") {
        cancelPendingStart = true
        return
      }
      send(context, ACTION_STOP, force)
    }

    /** Takes a brief service down; a tracking one stays. */
    fun stopBrief(context: Context) {
      if (status != "brief") return
      send(context, ACTION_STOP_BRIEF)
    }

    /**
     * A service already in the foreground makes the app foreground, and a
     * plain start reaches it with no exemption needed. Otherwise this is a
     * foreground start, which Android 12 and later allow from the
     * background only at a few moments, and a refusal is put in the log
     * rather than lost to logcat.
     */
    private fun deliver(context: Context, intent: Intent, reason: String): Boolean {
      if (foreground) {
        try {
          context.startService(intent)
          return true
        } catch (error: Exception) {
          // The flag was stale. A foreground start below decides it.
          foreground = false
        }
      }
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (error: Exception) {
        Log.w(TAG, "Start refused ($reason): ${error.message}")
        TrackerQueue.event(
          context,
          JSONObject().put("type", "service").put("status", "refused").put("reason", reason).put("error", error.javaClass.simpleName),
        )
        false
      }
    }

    private fun send(context: Context, action: String, force: Boolean = false) {
      val intent = Intent(context, HearthTrackingService::class.java).setAction(action).putExtra(EXTRA_FORCE, force)
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
        channel.description = "Shown while Hearth updates your location on a journey, or while someone watches it live."
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
