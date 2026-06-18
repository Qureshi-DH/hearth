package expo.modules.hearthmotion

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.sqrt

private const val ACTION = "expo.modules.hearthmotion.ACTIVITY"
private const val REQUEST_CODE = 8021
private const val DETECTION_INTERVAL_MS = 30_000L
private const val PREFS = "expo.modules.hearthmotion"
private const val KEY_ASKED = "activityRecognitionAsked"
private const val SENSOR_THREAD = "hearth-motion-sensors"

/**
 * Slow enough that a drive costs a handful of bridge crossings a second rather
 * than one per sample, short enough that the verdict clock on the JS side still
 * starts within a couple of samples of the jolt that armed it.
 */
private const val BATCH_INTERVAL_MS = 250L

/**
 * Matching iOS. Not SENSOR_DELAY_FASTEST: with the high sampling rate
 * permission granted that is several hundred hertz on modern hardware, and the
 * stillness the detector looks for is a spread measured over whatever lands in
 * the window. A wider band reads as more vibration, which is the gate every
 * crash has to pass.
 */
private const val ACCELEROMETER_PERIOD_US = 20_000

/**
 * Rotation and pressure move on human timescales, so sampling them as hard as
 * the accelerometer would spend battery to learn nothing.
 */
private const val GYROSCOPE_PERIOD_US = 100_000
private const val PRESSURE_PERIOD_US = 200_000

/**
 * Batches are drained on the main looper, and a drive lasts hours. A stall
 * there has to cost the oldest samples rather than grow the buffer for ever.
 */
private const val MAX_PENDING_SAMPLES = 2_000

/**
 * Google Play Services already runs this classifier for the system, so asking
 * it what the phone is doing costs far less than waking the GPS to work it out
 * from position changes.
 *
 * The module also samples the raw sensors crash detection reads. It does that
 * itself rather than through expo-sensors, which drops its SensorManager
 * listener the moment the Activity pauses. A screen going off, a home button,
 * or a map app on top all pause it, which is the state a phone is in for the
 * whole of a drive, so the detector only ever ran while somebody was watching
 * it. Registering from the application context here means the samples keep
 * coming for as long as the process does, which the location foreground
 * service already guarantees while the car is moving.
 *
 * The bodies below are plain methods rather than long lambdas. An AsyncFunction
 * lambda infers its return type from its last expression, which makes an early
 * return inside one a compile error that is easy to write and hard to read.
 */
class HearthMotionModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private var pendingIntent: PendingIntent? = null

  private var sensors: SensorManager? = null
  /** Read by the flush on the main looper, cleared by whichever thread stops us. */
  @Volatile private var sensorListener: SensorEventListener? = null
  private var sensorThread: HandlerThread? = null
  private val batchHandler = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Map<String, Any>>()
  /** Carried onto each accelerometer sample. Written by the sensor thread, cleared by ours. */
  @Volatile private var latestRotation = 0.0
  @Volatile private var latestPressure: Double? = null
  private var bootEpochMs = 0L

  private val flush =
    object : Runnable {
      override fun run() {
        // A stop can land between the drain and the repost below, and a loop
        // that reposted anyway would outlive the drive that started it.
        if (sensorListener == null) return
        val batch = synchronized(pending) { pending.toList().also { pending.clear() } }
        if (batch.isNotEmpty()) sendEvent("onSensorBatch", mapOf("samples" to batch))
        batchHandler.postDelayed(this, BATCH_INTERVAL_MS)
      }
    }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HearthMotion")

    Events("onMotionChange", "onSensorBatch")

    AsyncFunction("isAvailableAsync") { playServicesReady() }

    AsyncFunction("getPermissionAsync") { permissionState() }

    AsyncFunction("requestPermissionAsync") { promise: Promise -> requestPermission(promise) }

    AsyncFunction("startUpdatesAsync") { startUpdates() }

    AsyncFunction("stopUpdatesAsync") { stopUpdates() }

    AsyncFunction("startSensorsAsync") { startSensors() }

    AsyncFunction("stopSensorsAsync") { stopSensors() }

    OnDestroy {
      stopUpdates()
      stopSensors()
    }
  }

  private fun playServicesReady(): Boolean =
    GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
      ConnectionResult.SUCCESS

  /**
   * The permission only exists from Android 10, and is implicit before it.
   *
   * Android cannot tell "refused" from "never asked" by inspection: both read
   * back as not granted. Reporting the first for the second is not a cosmetic
   * difference. Callers treat a refusal as final and stop, so the request is
   * never made and the feature is dead on a device that would have said yes.
   * So the fact that we asked is recorded when we ask.
   */
  private fun permissionState(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted"
    val granted =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
        PackageManager.PERMISSION_GRANTED
    if (granted) return "granted"
    return if (hasBeenAsked()) "denied" else "undetermined"
  }

  private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun hasBeenAsked(): Boolean = prefs().getBoolean(KEY_ASKED, false)

  private fun requestPermission(promise: Promise) {
    val current = permissionState()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || current == "granted") {
      promise.resolve(current)
      return
    }
    val permissions = appContext.permissions
    if (permissions == null) {
      promise.resolve("denied")
      return
    }
    // Written before the dialog, not after: the process can be killed while it
    // is up, and a flag that only lands on the happy path would re-prompt for
    // ever on a device that has already refused once.
    prefs().edit().putBoolean(KEY_ASKED, true).apply()
    permissions.askForPermissions(
      { promise.resolve(permissionState()) },
      Manifest.permission.ACTIVITY_RECOGNITION,
    )
  }

  private fun startUpdates() {
    if (permissionState() != "granted") {
      throw SecurityException("Activity recognition permission not granted")
    }
    // Starting twice would leave the first receiver registered with nothing to
    // unregister it.
    if (receiver != null) return

    val listener =
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          val result = intent?.let(ActivityRecognitionResult::extractResult) ?: return
          val best = result.mostProbableActivity
          sendEvent(
            "onMotionChange",
            mapOf("activity" to activityName(best.type), "confidence" to best.confidence),
          )
        }
      }
    ContextCompat.registerReceiver(
      context,
      listener,
      IntentFilter(ACTION),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    receiver = listener

    // Play Services fills the intent with the result, so it has to stay mutable.
    val flags =
      PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val pending =
      PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        Intent(ACTION).setPackage(context.packageName),
        flags,
      )
    pendingIntent = pending

    ActivityRecognition.getClient(context).requestActivityUpdates(DETECTION_INTERVAL_MS, pending)
  }

  /** Safe to call when nothing is running, which is the state it wants anyway. */
  private fun stopUpdates() {
    pendingIntent?.let { intent ->
      runCatching { ActivityRecognition.getClient(context).removeActivityUpdates(intent) }
      intent.cancel()
    }
    pendingIntent = null
    receiver?.let { registered -> runCatching { context.unregisterReceiver(registered) } }
    receiver = null
  }

  private fun activityName(type: Int): String =
    when (type) {
      DetectedActivity.STILL -> "still"
      DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> "walking"
      DetectedActivity.RUNNING -> "running"
      DetectedActivity.ON_BICYCLE -> "cycling"
      DetectedActivity.IN_VEHICLE -> "automotive"
      else -> "unknown"
    }

  /**
   * False where the device cannot help. That is the caller's cue to fall back
   * to its own sampler rather than sit waiting on a batch that never arrives.
   */
  private fun startSensors(): Boolean {
    // Starting twice would leave the first listener registered with nothing
    // holding a reference to unregister it.
    if (sensorListener != null) return true
    val manager =
      context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        ?: return false
    val accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false

    // A SensorEvent counts from boot, so it needs an offset to read as a wall
    // clock time. The two clocks are read together once here rather than per
    // batch, because re-reading them would let a clock correction mid drive
    // shuffle new samples against the ones already in the detector's window.
    bootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtimeNanos() / 1_000_000L

    // Unregistering can leave a reading or two already queued behind it, and
    // they belong to the drive that ended rather than to this one. Dropped
    // before anything is registered, so nothing fresh goes with them.
    synchronized(pending) { pending.clear() }

    val thread = HandlerThread(SENSOR_THREAD).apply { start() }
    val handler = Handler(thread.looper)
    val listener =
      object : SensorEventListener {
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

        override fun onSensorChanged(event: SensorEvent?) {
          val reading = event ?: return
          when (reading.sensor.type) {
            // Only the accelerometer produces a sample. The other two are read
            // as whatever they last said, because a collision is decided on the
            // timescale of the accelerometer and nothing else moves that fast.
            Sensor.TYPE_ACCELEROMETER ->
              collect(reading.timestamp, magnitude(reading.values) / SensorManager.GRAVITY_EARTH)
            Sensor.TYPE_GYROSCOPE -> latestRotation = magnitude(reading.values)
            Sensor.TYPE_PRESSURE -> latestPressure = reading.values[0].toDouble()
          }
        }
      }

    // Delivery goes to a thread of our own. At the fastest rate a device
    // offers this is a callback every few milliseconds, and the main looper is
    // also what draws the map and drains the batches.
    manager.registerListener(listener, accelerometer, ACCELEROMETER_PERIOD_US, handler)
    manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { gyroscope ->
      manager.registerListener(listener, gyroscope, GYROSCOPE_PERIOD_US, handler)
    }
    // Plenty of Android devices have no barometer. Its absence costs one
    // corroborating signal rather than the whole feature.
    manager.getDefaultSensor(Sensor.TYPE_PRESSURE)?.let { barometer ->
      manager.registerListener(listener, barometer, PRESSURE_PERIOD_US, handler)
    }

    sensors = manager
    sensorListener = listener
    sensorThread = thread
    batchHandler.postDelayed(flush, BATCH_INTERVAL_MS)
    return true
  }

  /** Runs on the sensor thread. */
  private fun collect(timestampNanos: Long, accelG: Double) {
    val sample =
      mutableMapOf<String, Any>(
        "t" to bootEpochMs + timestampNanos / 1_000_000L,
        "accelG" to accelG,
        "rotationRps" to latestRotation,
      )
    latestPressure?.let { hPa -> sample["pressure"] = hPa }
    synchronized(pending) {
      if (pending.size >= MAX_PENDING_SAMPLES) pending.removeFirst()
      pending.addLast(sample)
    }
  }

  /** Safe to call when nothing is running, which is the state it wants anyway. */
  private fun stopSensors() {
    // Cleared first, because it is what tells a flush already running on the
    // main looper not to schedule itself again.
    val registered = sensorListener
    sensorListener = null
    batchHandler.removeCallbacks(flush)
    registered?.let { sensors?.unregisterListener(it) }
    sensors = null
    // Quit only once the listener is gone, so nothing is left posting work to
    // a looper that has stopped.
    sensorThread?.quitSafely()
    sensorThread = null
    synchronized(pending) { pending.clear() }
    latestRotation = 0.0
    latestPressure = null
  }

  private fun magnitude(values: FloatArray): Double {
    val x = values[0].toDouble()
    val y = values[1].toDouble()
    val z = values[2].toDouble()
    return sqrt(x * x + y * y + z * z)
  }
}
