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
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject

/**
 * The only place Hearth asks for the phone's location in the background,
 * and only for as long as one of three things lasts. A ping is the server's
 * heartbeat: one Wi-Fi grade fix, sent, and the service goes. Live is
 * somebody watching: a GPS fix a second, each sent as it comes, for as long
 * as the server's answers say they are looking. A drive is crash detection,
 * where a circle asked for it: from the motion sensor saying the phone is in
 * a vehicle until it says it is not, the GPS reads the speed the detector
 * judges a jolt by, and those fixes stay on the phone. Otherwise nothing
 * runs, so the location indicator and "Updating your location" are off.
 *
 * Both are started by the push handler inside the moment Android allows a
 * start from the background, and both are answered here with the session's
 * upload key, never waiting on JavaScript. Brief is the same service up for
 * one fix that JavaScript takes, for a session the server has not given a
 * key yet. It stops itself after the fix's own deadline.
 */
class HearthTrackingService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val briefStop = Runnable { if (!busy()) stopSelfGracefully("brief") }
  private val watchCheck = Runnable { if (!window.active(SystemClock.elapsedRealtime())) endWatch("over") }
  private val pingDeadline = Runnable { answerPingWithBest() }
  private val idleCap = Runnable { stopNow(stopReason ?: "idle") }
  private var client: FusedLocationProviderClient? = null
  private var callback: LocationCallback? = null
  private var running: Request? = null
  private var inForeground = false
  /** The newest start, so a stop decided before it arrived does not take it down. */
  private var lastStartId = 0

  private val window = WatchWindow()
  private var driving = false
  /** When the drive's GPS last had the car standing, so a parked car ends a drive the classifier forgot. */
  private var driveStoodSince = 0L
  private var pinging = false
  private var pingBest: Location? = null
  /** Set when the service should go as soon as the uploader has sent what it holds. */
  private var stopReason: String? = null
  private var destroyed = false

  private enum class Request { PING, DRIVE, LIVE }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    HearthDiagnostics.onProcessStart(this)
    NativeUploader.listener = uploads
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    pendingStart = false
    // Foreground first, whatever the command and every time: Android wants
    // it after each foreground start, the person may have swiped the
    // notification, and a refusal is only known here.
    if (!ensureForeground()) return START_NOT_STICKY
    when (intent?.action) {
      ACTION_STOP -> stopSelfGracefully("asked")
      ACTION_STOP_BRIEF -> if (!busy()) stopSelfGracefully("brief")
      ACTION_BRIEF -> if (!busy()) brief()
      ACTION_PING -> ping()
      ACTION_WATCH -> watch(intent.getLongExtra(EXTRA_SECONDS, 0L))
      ACTION_UNWATCH -> if (window.until != 0L) endWatch("ended")
      ACTION_DRIVE -> drive()
      ACTION_DRIVE_END -> if (driving) endDrive("motion")
      ACTION_DRIVE_STILL -> stillDuringDrive()
      // A restart Android made on its own. The server asks again when it
      // wants a fix, so there is nothing to pick back up.
      else -> stopSelfGracefully("restart")
    }
    // A command that left nothing to do, an end for a watch already over or
    // one that crossed the last stop, would otherwise leave the service in
    // the foreground with nothing to take it down.
    if (inForeground && !busy() && status != "brief") stopSelfGracefully("idle")
    return START_NOT_STICKY
  }

  private fun busy(): Boolean =
    pinging || driving || window.active(SystemClock.elapsedRealtime()) || stopReason != null

  private fun ensureForeground(): Boolean {
    return try {
      val notification = buildNotification(this, driving)
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
      // Not stopSelf(), which would take down a foreground start already on
      // its way, and Android ends an app whose foreground start never came.
      stopSelfResult(lastStartId)
      false
    }
  }

  private fun brief() {
    status = "brief"
    handler.removeCallbacks(briefStop)
    handler.postDelayed(briefStop, BRIEF_LIFETIME_MS)
    // A process with a foreground service may start the headless task, and
    // the fix is JavaScript's to take. Posted, so the foreground the system
    // was just told about has settled first.
    handler.postDelayed({ HearthHeadlessService.start(this, "brief") }, HEADLESS_START_DELAY_MS)
  }

  /** Swaps the location request. False when the permission has gone, and the service with it. */
  private fun run(next: Request): Boolean {
    if (next == running && callback != null) return true
    val client = client ?: LocationServices.getFusedLocationProviderClient(this).also { client = it }
    callback?.let { client.removeLocationUpdates(it) }
    val listener =
      object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
          for (location in result.locations) onFix(location)
        }
      }
    try {
      client.requestLocationUpdates(request(next), listener, Looper.getMainLooper())
    } catch (error: SecurityException) {
      // The location permission went. There is nothing to run, and
      // JavaScript reads the permission on its own.
      Log.w(TAG, "Location request refused: ${error.message}")
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "refused").put("reason", "permission"))
      stopSelfGracefully("permission")
      return false
    }
    callback = listener
    running = next
    return true
  }

  private fun request(next: Request): LocationRequest =
    when (next) {
      // Wi-Fi and cell, never the GPS: a ping is where the phone is, to the
      // street, every few minutes all day, and the GPS is what costs.
      Request.PING ->
        LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, PING_INTERVAL_MS)
          .setMinUpdateIntervalMillis(PING_INTERVAL_MS)
          .build()
      // The detector reads the speed in the fifteen seconds before a jolt,
      // and a GPS speed is the one that can be believed.
      Request.DRIVE ->
        LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, DRIVE_INTERVAL_MS)
          .setMinUpdateIntervalMillis(DRIVE_INTERVAL_MS / 2)
          .build()
      Request.LIVE ->
        LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LIVE_INTERVAL_MS)
          .setMinUpdateIntervalMillis(LIVE_INTERVAL_MS)
          .setMaxUpdateDelayMillis(LIVE_INTERVAL_MS)
          .build()
    }

  private fun onFix(location: Location) {
    if (window.active(SystemClock.elapsedRealtime())) {
      // The key was refused mid watch. Nothing sent from here would reach the
      // server, and no reply would come back to end the watch.
      if (!NativeUploader.ready(this)) {
        endWatch("refused")
        return
      }
      NativeUploader.send(this, location, "background")
      // A ping that lands inside a watch is answered by the watch's next fix.
      if (pinging) finishPing()
      // The detector reads its speed from here too, whether or not the
      // upload gets through.
      if (driving) feedDetector(location)
      return
    }
    if (driving) {
      // A ping during the drive is answered with the drive's own fix, which
      // is the freshest the phone has.
      feedDetector(location)
      if (pinging) sendPing(location)
      return
    }
    if (!pinging) return
    if (goodEnough(location)) {
      sendPing(location)
      return
    }
    if (fresh(location) && better(location, pingBest)) pingBest = location
  }

  /** For the detector, on the phone, and never uploaded. */
  private fun feedDetector(location: Location) {
    TrackerQueue.appendFix(this, TrackerQueue.fixJson(location).put("local", true))
    TrackerQueue.poke()
    HearthHeadlessService.keepAwake(this)
    noteDriveSpeed(location)
  }

  /** One fix, sent from here. A phone already on Live sends its next one. */
  private fun ping() {
    if (!NativeUploader.ready(this)) {
      // With no key to send with, JavaScript takes the fix.
      if (!busy()) brief()
      return
    }
    TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true))
    if (window.active(SystemClock.elapsedRealtime())) return
    stopReason = null
    handler.removeCallbacks(idleCap)
    handler.removeCallbacks(briefStop)
    pinging = true
    pingBest = null
    handler.removeCallbacks(pingDeadline)
    handler.postDelayed(pingDeadline, PING_FIX_MS)
    // The drive's GPS is already running, and its next fix is the answer.
    if (driving) return
    if (!run(Request.PING)) return
    status = "running"
  }

  /** From the motion sensor's word that the phone is in a vehicle, until it says otherwise. */
  private fun drive() {
    // Sharing or crash alerts may have gone off while this start was on its way.
    val prefs = TrackerPrefs(this)
    if (!prefs.enabled || prefs.mode == "off" || !prefs.crashDetection) {
      if (driving) endDrive("not wanted")
      return
    }
    handler.removeCallbacks(stillInDrive)
    if (!driving) {
      driving = true
      driveStoodSince = 0L
      TrackerQueue.event(this, JSONObject().put("type", "drive"))
      TrackerQueue.poke()
      // The detector runs in JavaScript, which a phone in a pocket does not
      // have running. This one task stays open for the drive.
      HearthHeadlessService.keepAwake(this)
    }
    stopReason = null
    handler.removeCallbacks(idleCap)
    handler.removeCallbacks(briefStop)
    refreshNotification()
    if (window.active(SystemClock.elapsedRealtime())) return
    if (!run(Request.DRIVE)) return
    status = "running"
  }

  /**
   * The classifier says still as readily at a red light as in a car park.
   * A still that holds for a few minutes, with the GPS seeing no speed in
   * them, ends the drive.
   */
  private fun stillDuringDrive() {
    if (!driving) return
    handler.removeCallbacks(stillInDrive)
    handler.postDelayed(stillInDrive, DRIVE_STILL_MS)
  }

  private val stillInDrive = Runnable { if (driving) endDrive("still") }

  private fun endDrive(reason: String) {
    handler.removeCallbacks(stillInDrive)
    driving = false
    driveStoodSince = 0L
    TrackerQueue.event(this, JSONObject().put("type", "drive over").put("reason", reason))
    TrackerQueue.poke()
    refreshNotification()
    when {
      window.active(SystemClock.elapsedRealtime()) -> Unit
      pinging -> run(Request.PING)
      else -> stopWhenSent("drive over")
    }
  }

  /**
   * The classifier can be slow to say a car has parked, or miss it, and a
   * drive left running would be the GPS all evening. Ten minutes of the GPS
   * having the phone standing ends it.
   */
  private fun noteDriveSpeed(location: Location) {
    // A fix with no speed says nothing either way.
    if (!location.hasSpeed()) return
    val now = SystemClock.elapsedRealtime()
    if (location.speed >= DRIVE_STANDING_MPS) {
      driveStoodSince = 0L
      handler.removeCallbacks(stillInDrive)
      return
    }
    if (driveStoodSince == 0L) driveStoodSince = now
    if (now - driveStoodSince >= DRIVE_STANDING_MS) endDrive("standing")
  }

  private fun sendPing(location: Location) {
    val prefs = TrackerPrefs(this)
    val previous = prefs.lastFix?.let { runCatching { UploadWire.fix(it) }.getOrNull() }
    NativeUploader.send(this, location, "nudge")
    // A drive that ended on standing, or one Android would not start, while
    // the classifier still has the phone in a vehicle: a ping that finds it
    // moving brings crash detection back. No new transition would.
    if (!driving && prefs.crashDetection && prefs.activity == "automotive" &&
      UploadWire.movedLikeAVehicle(UploadWire.fix(TrackerQueue.fixJson(location)), previous)
    ) {
      drive()
    }
    finishPing()
  }

  private fun answerPingWithBest() {
    if (!pinging) return
    val best = pingBest
    if (best != null) {
      sendPing(best)
      return
    }
    // Nothing came. The last fix the system holds is better than silence
    // if it is recent, and the server asks again otherwise.
    val client = client ?: LocationServices.getFusedLocationProviderClient(this).also { client = it }
    try {
      client.lastLocation.addOnCompleteListener { task ->
        // The ping may have been answered meanwhile, or the service gone.
        if (!pinging || destroyed) return@addOnCompleteListener
        val last = if (task.isSuccessful) task.result?.takeIf { ageMs(it) < LAST_KNOWN_MAX_AGE_MS } else null
        if (last != null) {
          sendPing(last)
        } else {
          TrackerQueue.event(this, JSONObject().put("type", "wake").put("native", true).put("fix", false))
          finishPing()
        }
      }
    } catch (error: SecurityException) {
      finishPing()
    }
  }

  private fun finishPing() {
    pinging = false
    pingBest = null
    handler.removeCallbacks(pingDeadline)
    if (!window.active(SystemClock.elapsedRealtime()) && !driving) stopWhenSent("wake")
  }

  /** A fix a second, sent as it comes, until the server's answers say nobody is looking. */
  private fun watch(seconds: Long) {
    if (!NativeUploader.ready(this)) {
      // No key, so no Live from here. JavaScript sends the one fix it can.
      if (!busy()) brief()
      return
    }
    if (seconds <= 0) {
      if (window.until != 0L) endWatch("ended")
      return
    }
    val change = window.open(SystemClock.elapsedRealtime(), minOf(seconds, MAX_WATCH_SECONDS))
    goLive(change == WatchWindow.Change.OPENED, "push")
  }

  private fun goLive(announce: Boolean, reason: String) {
    stopReason = null
    handler.removeCallbacks(idleCap)
    handler.removeCallbacks(briefStop)
    if (!run(Request.LIVE)) return
    status = "running"
    handler.removeCallbacks(watchCheck)
    handler.postDelayed(watchCheck, (window.until - SystemClock.elapsedRealtime()).coerceAtLeast(0) + 1_000)
    if (announce) {
      TrackerQueue.event(
        this,
        JSONObject().put("type", "watch").put("until", System.currentTimeMillis() + (window.until - SystemClock.elapsedRealtime())).put("reason", reason),
      )
      TrackerQueue.poke()
    }
  }

  private fun endWatch(reason: String) {
    window.close()
    handler.removeCallbacks(watchCheck)
    TrackerQueue.event(this, JSONObject().put("type", "watch over").put("reason", reason))
    TrackerQueue.poke()
    when {
      driving -> run(Request.DRIVE)
      pinging -> run(Request.PING)
      else -> stopWhenSent("watch over")
    }
  }

  /** Goes once the server has what the uploader holds, or after a cap so a dead network cannot keep it. */
  private fun refreshNotification() {
    if (!inForeground) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    runCatching { manager.notify(NOTIFICATION_ID, buildNotification(this, driving)) }
  }

  private fun stopWhenSent(reason: String) {
    stopReason = reason
    handler.removeCallbacks(idleCap)
    // The fix waits in the uploader. Location is not needed for it.
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    running = null
    if (NativeUploader.idle(this)) {
      stopNow(reason)
      return
    }
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

  private fun stopSelfGracefully(reason: String) {
    handler.removeCallbacks(briefStop)
    handler.removeCallbacks(watchCheck)
    handler.removeCallbacks(pingDeadline)
    handler.removeCallbacks(idleCap)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    val wasLive = window.until != 0L || driving
    // JavaScript holds a drive of its own, and only this ends it.
    if (driving) {
      TrackerQueue.event(this, JSONObject().put("type", "drive over").put("reason", reason))
      TrackerQueue.poke()
    }
    handler.removeCallbacks(stillInDrive)
    running = null
    window.close()
    driving = false
    pinging = false
    stopReason = null
    if (wasLive) {
      TrackerQueue.event(this, JSONObject().put("type", "service").put("status", "stopped").put("reason", reason))
    }
    // A push may have started the service again while this stop was being
    // decided. Then the service stays, in the foreground, for that start to
    // use: one that came by a plain start needs no new allowance from
    // Android only because the foreground was never let go.
    if (!stopSelfResult(lastStartId)) {
      // The start on its way decides what the service does next, and a
      // leftover "brief" must not hold it up.
      status = "none"
      return
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    inForeground = false
    foreground = false
    status = "none"
  }

  override fun onDestroy() {
    destroyed = true
    if (driving) {
      driving = false
      TrackerQueue.event(this, JSONObject().put("type", "drive over").put("reason", "destroyed"))
      TrackerQueue.poke()
    }
    handler.removeCallbacksAndMessages(null)
    callback?.let { client?.removeLocationUpdates(it) }
    callback = null
    running = null
    inForeground = false
    foreground = false
    if (NativeUploader.listener === uploads) NativeUploader.listener = null
    status = "none"
    super.onDestroy()
  }

  private fun goodEnough(location: Location): Boolean =
    fresh(location) && location.hasAccuracy() && location.accuracy <= PING_GOOD_ACCURACY_METERS

  private fun fresh(location: Location): Boolean = ageMs(location) < FRESH_FIX_MS

  private fun better(location: Location, than: Location?): Boolean =
    than == null || (location.hasAccuracy() && (!than.hasAccuracy() || location.accuracy < than.accuracy))

  private fun ageMs(location: Location): Long =
    (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000

  companion object {
    private const val TAG = "HearthTracking"
    // The ping keeps the action name the wake had, so a push handled by
    // an older service on the way through an update still means the same.
    private const val ACTION_PING = "expo.modules.hearthmotion.WAKE"
    private const val ACTION_BRIEF = "expo.modules.hearthmotion.BRIEF"
    private const val ACTION_WATCH = "expo.modules.hearthmotion.WATCH"
    private const val ACTION_UNWATCH = "expo.modules.hearthmotion.UNWATCH"
    private const val ACTION_STOP = "expo.modules.hearthmotion.STOP"
    private const val ACTION_STOP_BRIEF = "expo.modules.hearthmotion.STOP_BRIEF"
    private const val ACTION_DRIVE = "expo.modules.hearthmotion.DRIVE"
    private const val ACTION_DRIVE_END = "expo.modules.hearthmotion.DRIVE_END"
    private const val ACTION_DRIVE_STILL = "expo.modules.hearthmotion.DRIVE_STILL"
    private const val EXTRA_SECONDS = "seconds"
    const val CHANNEL_ID = "hearth-wake"
    private const val NOTIFICATION_ID = 7421
    /** The fix's own deadline, so a brief service never outlives it. */
    private const val BRIEF_LIFETIME_MS = 30_000L
    private const val HEADLESS_START_DELAY_MS = 300L

    /** What Live runs, a fix a second wherever the phone is. */
    private const val LIVE_INTERVAL_MS = 1_000L
    /** Often enough that a jolt always has a GPS speed in the detector's fifteen seconds before it. */
    private const val DRIVE_INTERVAL_MS = 5_000L
    private const val DRIVE_STANDING_MPS = 2f
    private const val DRIVE_STANDING_MS = 10 * 60 * 1000L
    /** Still for this long, with no speed seen in it, is a car that has parked. */
    private const val DRIVE_STILL_MS = 3 * 60 * 1000L
    private const val PING_INTERVAL_MS = 1_000L
    /** A street's worth, which is what a ping is for and what Wi-Fi gives indoors. */
    private const val PING_GOOD_ACCURACY_METERS = 100f
    /** How long a ping waits for a good fix before it sends the best one it has. */
    private const val PING_FIX_MS = 15_000L
    /** Play Services may hand over the last fix it had first, and that is not now. */
    private const val FRESH_FIX_MS = 60_000L
    private const val LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000L
    /** The longest the service stays up for the uploader once it is done otherwise. */
    private const val SEND_CAP_MS = 45_000L
    /** The server's own longest window, so a push cannot ask for an hour. */
    private const val MAX_WATCH_SECONDS = 10 * 60L

    /** "none", "brief", "running" or "refused", as JavaScript reads it. */
    @Volatile
    var status: String = "none"
      private set

    /** Whether the service holds the foreground right now, which is what lets the process start another service. */
    @Volatile
    var foreground: Boolean = false
      private set

    /** The service up for one fix JavaScript takes. True when Android accepted the start. */
    fun brief(context: Context): Boolean =
      deliver(context, Intent(context, HearthTrackingService::class.java).setAction(ACTION_BRIEF), "brief")

    /** One fix, sent from here when the server gave a key. False when Android refused the start. */
    fun ping(context: Context, reason: String): Boolean =
      deliver(context, Intent(context, HearthTrackingService::class.java).setAction(ACTION_PING), reason)

    /** Live for this long, or until the server's answers say nobody is looking. */
    fun watch(context: Context, seconds: Long, reason: String): Boolean =
      deliver(
        context,
        Intent(context, HearthTrackingService::class.java).setAction(ACTION_WATCH).putExtra(EXTRA_SECONDS, seconds),
        reason,
      )

    /** The motion sensor has the phone in a vehicle, and a circle wants crash alerts. */
    fun drive(context: Context): Boolean =
      deliver(context, Intent(context, HearthTrackingService::class.java).setAction(ACTION_DRIVE), "drive")

    fun endDrive(context: Context) {
      if (!running(context)) return
      send(context, ACTION_DRIVE_END)
    }

    /** Still, by the classifier's word, during a drive. */
    fun stillDuringDrive(context: Context) {
      if (!running(context)) return
      send(context, ACTION_DRIVE_STILL)
    }

    /**
     * Whether a command has a service to reach: one in the foreground, or a
     * start on its way, which the command then follows into the queue.
     */
    private fun running(context: Context): Boolean =
      foreground || pendingStart || !(status == "none" || status == "refused")

    fun unwatch(context: Context) {
      if (!running(context)) return
      send(context, ACTION_UNWATCH)
    }

    /** Sharing off or signed out. Whatever the service is doing ends. */
    fun stop(context: Context) {
      if (!running(context)) return
      send(context, ACTION_STOP)
    }

    /** Takes a brief service down; a ping or Live stays. */
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
    /** Set from a foreground start until the service has it, so a stop sent between is not dropped. */
    @Volatile
    private var pendingStart = false

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
        pendingStart = true
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (error: Exception) {
        pendingStart = false
        Log.w(TAG, "Start refused ($reason): ${error.message}")
        TrackerQueue.event(
          context,
          JSONObject().put("type", "service").put("status", "refused").put("reason", reason).put("error", error.javaClass.simpleName),
        )
        false
      }
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

    private fun buildNotification(context: Context, driving: Boolean): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        // The lowest importance: no sound, no status bar icon on most
        // launchers, collapsed in the silent part of the shade.
        val channel = NotificationChannel(CHANNEL_ID, "Location updates", NotificationManager.IMPORTANCE_MIN)
        channel.description =
          "Shown for the seconds Hearth takes your location, while someone watches it live, and on a drive while crash detection is on."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val icon = context.applicationInfo.icon
      val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(context)
      return builder
        .setContentTitle("Hearth")
        .setContentText(if (driving) "Crash detection is on for this drive" else "Updating your location")
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
