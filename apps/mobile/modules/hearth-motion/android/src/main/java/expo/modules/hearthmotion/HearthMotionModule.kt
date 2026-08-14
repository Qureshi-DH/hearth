package expo.modules.hearthmotion

import android.Manifest
import android.app.ActivityManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.sqrt

private const val ACTION = "expo.modules.hearthmotion.ACTIVITY"
private const val TRANSITION_ACTION = "expo.modules.hearthmotion.TRANSITION"
private const val REQUEST_CODE = 8021
private const val TRANSITION_REQUEST_CODE = 8022
private const val DETECTION_INTERVAL_MS = 30_000L
private const val PREFS = "expo.modules.hearthmotion"
private const val KEY_ASKED = "activityRecognitionAsked"
private const val SENSOR_THREAD = "hearth-motion-sensors"
private const val TAG = "HearthMotion"

/**
 * Slow enough that a drive costs a handful of bridge crossings a second rather
 * than one per sample, short enough that the verdict clock on the JS side still
 * starts within a couple of samples of the jolt that armed it.
 */
private const val BATCH_INTERVAL_MS = 250L

/**
 * What the sensor hub is asked to hold in its own FIFO before it wakes the
 * application processor. The module already spends this long buffering samples
 * in software, so spending it a layer lower costs nothing that was not being
 * spent already and saves an interrupt per sample for the length of a drive.
 * Hardware with no FIFO ignores it and delivers exactly as it did before.
 *
 * The two waits compose, so a sample can be half a second old by the time the
 * JS side sees it. That side arms its verdict on a sample and then waits a
 * second longer than the aftermath it has to read, which is the room this
 * spends. Lengthening either wait without the other growing too eats it.
 */
private const val MAX_REPORT_LATENCY_US = (BATCH_INTERVAL_MS * 1_000L).toInt()

/**
 * How many readings of the slower sensors to keep. Deep enough that a reading
 * outlives its own delivery by several batches, so it is still there to answer
 * for accelerometer samples that were sitting in another FIFO when it arrived,
 * and deep enough to hold a batch even on a device that reports faster than we
 * asked because another app wanted it sooner.
 */
private const val SLOW_SENSOR_HISTORY = 32

/**
 * What fraction of a shared FIFO to ask for when the sensor reserves us none of
 * it. A reservation is a guarantee and can be spent to the last event. A share
 * of a pool every app on the phone draws from is not, so most of it is left
 * alone rather than counted on.
 */
private const val SHARED_FIFO_DIVISOR = 4

/**
 * Matching iOS. Not SENSOR_DELAY_FASTEST, which is hundreds of hertz on modern
 * hardware, and the stillness the detector looks for is a spread measured over
 * whatever lands in the window. A wider band reads as more vibration, which is
 * the gate every crash has to pass.
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
  private var transitionIntent: PendingIntent? = null
  private var powerReceiver: BroadcastReceiver? = null

  private var sensors: SensorManager? = null
  /** Read by the flush on the main looper, cleared by whichever thread stops us. */
  @Volatile private var sensorListener: SensorEventListener? = null
  private var sensorThread: HandlerThread? = null
  private val batchHandler = Handler(Looper.getMainLooper())
  private val pending = ArrayDeque<Map<String, Any>>()
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

    Events("onMotionChange", "onSensorBatch", "onPowerStateChange")

    AsyncFunction("isAvailableAsync") { playServicesReady() }

    AsyncFunction("getBackgroundRestrictedAsync") { backgroundRestricted() }

    AsyncFunction("isPowerSaveModeAsync") { powerSaveMode() }

    AsyncFunction("requestIgnoreBatteryOptimizationsAsync") { requestIgnoreBatteryOptimizations() }

    AsyncFunction("openVendorPowerManagerAsync") { openVendorPowerManager() }

    OnStartObserving { startObservingPower() }

    OnStopObserving { stopObservingPower() }

    AsyncFunction("getPermissionAsync") { permissionState() }

    AsyncFunction("requestPermissionAsync") { promise: Promise -> requestPermission(promise) }

    AsyncFunction("startUpdatesAsync") { startUpdates() }

    AsyncFunction("stopUpdatesAsync") { stopUpdates() }

    AsyncFunction("startSensorsAsync") { startSensors() }

    AsyncFunction("stopSensorsAsync") { stopSensors() }

    OnDestroy {
      stopUpdates()
      stopSensors()
      stopObservingPower()
    }
  }

  private fun backgroundRestricted(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    return manager?.isBackgroundRestricted ?: false
  }

  private fun powerSaveMode(): Boolean {
    val manager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    return manager?.isPowerSaveMode ?: false
  }

  private fun startObservingPower() {
    if (powerReceiver != null) return
    val listener =
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          if (intent?.action != PowerManager.ACTION_POWER_SAVE_MODE_CHANGED) return
          sendEvent("onPowerStateChange", mapOf("lowPowerMode" to powerSaveMode()))
        }
      }
    // Exported, because the sender is the system and not this app. The action
    // is a protected broadcast, so nothing else can send it anyway.
    ContextCompat.registerReceiver(
      context,
      listener,
      IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
      ContextCompat.RECEIVER_EXPORTED,
    )
    powerReceiver = listener
  }

  private fun stopObservingPower() {
    powerReceiver?.let { registered -> runCatching { context.unregisterReceiver(registered) } }
    powerReceiver = null
  }

  /**
   * The system's own exemption dialog, which Play allows a family safety app
   * to raise directly. Whether it opened is all this can say; the person's
   * answer is read back from PowerManager by the checklist.
   */
  private fun requestIgnoreBatteryOptimizations(): Boolean {
    val intent =
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${context.packageName}"))
    return launch(intent)
  }

  /**
   * Tries each screen the vendor is known to keep its kill switch on, in the
   * order the newer ones come first, and falls back to Hearth's own app
   * settings page, which on every Android has the Battery > Unrestricted
   * toggle. Returns what opened so the log can say which one this phone has.
   */
  private fun openVendorPowerManager(): String? {
    val make = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
    for (target in VENDOR_TARGETS) {
      if (target.makes.none { make.contains(it) }) continue
      val intent = Intent().setComponent(ComponentName(target.pkg, target.cls))
      target.extras(intent, context)
      if (launch(intent)) return "${target.pkg}/${target.cls}"
    }
    val details =
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(Uri.parse("package:${context.packageName}"))
    return if (launch(details)) "app_settings" else null
  }

  /**
   * Started from the Activity where there is one, as a new task otherwise.
   * Nothing is resolved first: on Android 11 and later resolveActivity only
   * sees packages declared in <queries>, and starting an activity needs no
   * such declaration. A vendor screen that is not there throws, and a ROM
   * that has locked its screen away throws SecurityException, so both read
   * as "try the next one".
   */
  private fun launch(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (e: ActivityNotFoundException) {
      false
    } catch (e: SecurityException) {
      Log.i(TAG, "not allowed to open ${intent.component ?: intent.action}: ${e.message}")
      false
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
          intent ?: return
          // A transition is Play Services saying the activity changed, and
          // delivering it is one of the moments Android lets the app start a
          // foreground service from the background. The sampled result is
          // the same verdict on a schedule, which is what the ninety second
          // stillness check counts.
          if (ActivityTransitionResult.hasResult(intent)) {
            val last = ActivityTransitionResult.extractResult(intent)?.transitionEvents?.lastOrNull() ?: return
            sendEvent(
              "onMotionChange",
              mapOf(
                "activity" to activityName(last.activityType),
                "confidence" to 100,
                "source" to "transition",
              ),
            )
            return
          }
          val result = ActivityRecognitionResult.extractResult(intent) ?: return
          val best = result.mostProbableActivity
          sendEvent(
            "onMotionChange",
            mapOf(
              "activity" to activityName(best.type),
              "confidence" to best.confidence,
              "source" to "sample",
            ),
          )
        }
      }
    ContextCompat.registerReceiver(
      context,
      listener,
      IntentFilter().apply {
        addAction(ACTION)
        addAction(TRANSITION_ACTION)
      },
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
    val client = ActivityRecognition.getClient(context)
    client.requestActivityUpdates(DETECTION_INTERVAL_MS, pending)

    val transitions =
      PendingIntent.getBroadcast(
        context,
        TRANSITION_REQUEST_CODE,
        Intent(TRANSITION_ACTION).setPackage(context.packageName),
        flags,
      )
    transitionIntent = transitions
    val entering =
      listOf(
        DetectedActivity.IN_VEHICLE,
        DetectedActivity.ON_BICYCLE,
        DetectedActivity.RUNNING,
        DetectedActivity.WALKING,
        DetectedActivity.STILL,
      ).map { type ->
        ActivityTransition.Builder()
          .setActivityType(type)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
          .build()
      }
    client.requestActivityTransitionUpdates(ActivityTransitionRequest(entering), transitions)
  }

  /** Safe to call when nothing is running, which is the state it wants anyway. */
  private fun stopUpdates() {
    val client = ActivityRecognition.getClient(context)
    pendingIntent?.let { intent ->
      runCatching { client.removeActivityUpdates(intent) }
      intent.cancel()
    }
    pendingIntent = null
    transitionIntent?.let { intent ->
      runCatching { client.removeActivityTransitionUpdates(intent) }
      intent.cancel()
    }
    transitionIntent = null
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
    // Held by the listener rather than by the module, so the drive that owns
    // them is the only thing that can write to them. Unregistering can leave a
    // reading queued behind it, and a stop followed straight away by a start is
    // two sensor threads for that moment. Neither can reach the other's.
    val rotation = SensorHistory(SLOW_SENSOR_HISTORY)
    val pressure = SensorHistory(SLOW_SENSOR_HISTORY)
    val listener =
      object : SensorEventListener {
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

        override fun onSensorChanged(event: SensorEvent?) {
          val reading = event ?: return
          when (reading.sensor.type) {
            // Only the accelerometer produces a sample. The other two are kept
            // with their own timestamps and read back at the instant of the
            // sample they belong to, because the hub is free to flush the three
            // sensors in any order it likes.
            Sensor.TYPE_ACCELEROMETER ->
              collect(
                reading.timestamp,
                magnitude(reading.values) / SensorManager.GRAVITY_EARTH,
                rotation.at(reading.timestamp) ?: 0.0,
                pressure.at(reading.timestamp),
              )
            Sensor.TYPE_GYROSCOPE -> rotation.add(reading.timestamp, magnitude(reading.values))
            Sensor.TYPE_PRESSURE -> pressure.add(reading.timestamp, reading.values[0].toDouble())
          }
        }
      }

    // Delivery goes to a thread of our own. At the fastest rate a device
    // offers this is a callback every few milliseconds, and the main looper is
    // also what draws the map and drains the batches.
    register(manager, listener, accelerometer, ACCELEROMETER_PERIOD_US, handler)
    manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { gyroscope ->
      register(manager, listener, gyroscope, GYROSCOPE_PERIOD_US, handler)
    }
    // Plenty of Android devices have no barometer. Its absence costs one
    // corroborating signal rather than the whole feature.
    manager.getDefaultSensor(Sensor.TYPE_PRESSURE)?.let { barometer ->
      register(manager, listener, barometer, PRESSURE_PERIOD_US, handler)
    }

    sensors = manager
    sensorListener = listener
    sensorThread = thread
    batchHandler.postDelayed(flush, BATCH_INTERVAL_MS)
    return true
  }

  /**
   * Registered through here rather than inline so that what the hardware was
   * asked for is recorded. Whether a handset batches or fell back to an
   * interrupt per sample is invisible from the JS side, which sees the same
   * quarter second of samples either way, and the counts differ enough between
   * devices that the answer is per handset. `adb logcat -s HearthMotion` at the
   * start of a drive is the whole story.
   */
  private fun register(
    manager: SensorManager,
    listener: SensorEventListener,
    sensor: Sensor,
    periodUs: Int,
    handler: Handler,
  ) {
    val latencyUs =
      batchLatencyUs(sensor.fifoMaxEventCount, sensor.fifoReservedEventCount, periodUs)
    Log.i(
      TAG,
      "batching ${sensor.stringType} periodUs=$periodUs fifoMax=${sensor.fifoMaxEventCount} " +
        "fifoReserved=${sensor.fifoReservedEventCount} maxReportLatencyUs=$latencyUs",
    )
    manager.registerListener(listener, sensor, periodUs, latencyUs, handler)
  }

  /** Runs on the sensor thread. */
  private fun collect(
    timestampNanos: Long,
    accelG: Double,
    rotationRps: Double,
    pressureHpa: Double?,
  ) {
    val sample =
      mutableMapOf<String, Any>(
        "t" to bootEpochMs + timestampNanos / 1_000_000L,
        "accelG" to accelG,
        "rotationRps" to rotationRps,
      )
    pressureHpa?.let { hPa -> sample["pressure"] = hPa }
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
  }

  private fun magnitude(values: FloatArray): Double {
    val x = values[0].toDouble()
    val y = values[1].toDouble()
    val z = values[2].toDouble()
    return sqrt(x * x + y * y + z * z)
  }
}

/**
 * One screen where a vendor keeps its background kill switch. `makes` are
 * matched against Build.MANUFACTURER and Build.BRAND, lowercased, because
 * Redmi and POCO report Xiaomi as the manufacturer and only the brand says
 * which they are.
 */
private class VendorTarget(
  val makes: List<String>,
  val pkg: String,
  val cls: String,
  val extras: (Intent, Context) -> Unit = { _, _ -> },
)

private val XIAOMI = listOf("xiaomi", "redmi", "poco")
private val HUAWEI = listOf("huawei", "honor")
private val OPPO = listOf("oppo", "realme", "oneplus")
private val VIVO = listOf("vivo", "iqoo")
private val SAMSUNG = listOf("samsung")
private val TRANSSION = listOf("infinix", "tecno", "itel", "transsion")
private val ASUS = listOf("asus")

/**
 * The component names transistorsoft's DeviceSettings and the AutoStarter
 * library open, current as of 2025. They cannot be verified without each
 * handset in hand, which is why every one is tried in turn and the app's own
 * settings page is the floor.
 */
private val VENDOR_TARGETS =
  listOf(
    VendorTarget(
      XIAOMI,
      "com.miui.securitycenter",
      "com.miui.permcenter.autostart.AutoStartManagementActivity",
    ),
    VendorTarget(
      XIAOMI,
      "com.miui.powerkeeper",
      "com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
    ) { intent, context ->
      // PowerKeeper opens on this app's own page only when told which app.
      intent.putExtra("package_name", context.packageName)
      intent.putExtra(
        "package_label",
        context.applicationInfo.loadLabel(context.packageManager).toString(),
      )
    },
    VendorTarget(
      HUAWEI,
      "com.huawei.systemmanager",
      "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
    ),
    VendorTarget(
      HUAWEI,
      "com.huawei.systemmanager",
      "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
    ),
    VendorTarget(
      HUAWEI,
      "com.huawei.systemmanager",
      "com.huawei.systemmanager.optimize.process.ProtectActivity",
    ),
    VendorTarget(
      HUAWEI,
      "com.hihonor.systemmanager",
      "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
    ),
    VendorTarget(
      HUAWEI,
      "com.hihonor.systemmanager",
      "com.hihonor.systemmanager.appcontrol.activity.StartupAppControlActivity",
    ),
    VendorTarget(
      OPPO,
      "com.coloros.safecenter",
      "com.coloros.safecenter.permission.startup.StartupAppListActivity",
    ),
    VendorTarget(
      OPPO,
      "com.coloros.safecenter",
      "com.coloros.safecenter.startupapp.StartupAppListActivity",
    ),
    VendorTarget(OPPO, "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
    VendorTarget(
      OPPO,
      "com.coloros.oppoguardelf",
      "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
    ),
    VendorTarget(
      OPPO,
      "com.coloros.oppoguardelf",
      "com.coloros.powermanager.fuelgaue.PowerConsumptionActivity",
    ),
    VendorTarget(
      OPPO,
      "com.oneplus.security",
      "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
    ),
    VendorTarget(
      VIVO,
      "com.vivo.permissionmanager",
      "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
    ),
    VendorTarget(VIVO, "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
    VendorTarget(VIVO, "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
    VendorTarget(
      VIVO,
      "com.vivo.abe",
      "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity",
    ),
    VendorTarget(
      SAMSUNG,
      "com.samsung.android.lool",
      "com.samsung.android.sm.battery.ui.usage.CheckableAppListActivity",
    ),
    VendorTarget(
      SAMSUNG,
      "com.samsung.android.lool",
      "com.samsung.android.sm.battery.ui.BatteryActivity",
    ),
    VendorTarget(
      SAMSUNG,
      "com.samsung.android.lool",
      "com.samsung.android.sm.ui.battery.BatteryActivity",
    ),
    VendorTarget(
      SAMSUNG,
      "com.samsung.android.sm_cn",
      "com.samsung.android.sm.ui.battery.BatteryActivity",
    ),
    VendorTarget(
      SAMSUNG,
      "com.samsung.android.sm",
      "com.samsung.android.sm.ui.battery.BatteryActivity",
    ),
    VendorTarget(
      TRANSSION,
      "com.transsion.phonemanager",
      "com.itel.autobootmanager.activity.AutoBootMgrActivity",
    ),
    VendorTarget(
      TRANSSION,
      "com.transsion.phonemaster",
      "com.cyin.himgr.autostart.AutoStartActivity",
    ),
    VendorTarget(ASUS, "com.asus.mobilemanager", "com.asus.mobilemanager.powersaver.PowerSaverSettings"),
    VendorTarget(ASUS, "com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"),
    VendorTarget(ASUS, "com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity") {
      intent,
      _ ->
      intent.putExtra("showNotice", true)
    },
  )

/**
 * How long the hub may sit on a sensor's readings before handing them over.
 *
 * The two FIFO counts hold two different zeroes, and reading them as one costs
 * a whole class of handset the batching. A max of zero is hardware with no
 * FIFO, where there is nothing to ask for. A reserved of zero alongside a
 * non-zero max is hardware that batches perfectly well, out of a pool shared
 * with every other app rather than a slice held for this sensor, and that is a
 * common way for a device to be configured.
 *
 * So the max decides whether to ask at all and the reserved decides how boldly.
 * A reservation is ours and can be spent to the last event. A share of a pool
 * can be taken by somebody else first, and a FIFO that fills before the latency
 * is up drops readings, which on the accelerometer means dropping the crash.
 *
 * Takes the counts rather than the Sensor so the decision can be read, and
 * checked, without a handset.
 */
internal fun batchLatencyUs(
  fifoMaxEventCount: Int,
  fifoReservedEventCount: Int,
  periodUs: Int,
): Int {
  if (fifoMaxEventCount <= 0) return 0
  val events =
    if (fifoReservedEventCount > 0) fifoReservedEventCount
    else fifoMaxEventCount / SHARED_FIFO_DIVISOR
  return minOf(MAX_REPORT_LATENCY_US.toLong(), events.toLong() * periodUs).toInt()
}

/**
 * The recent readings of one slow sensor, so an accelerometer sample can carry
 * what was true at its own instant rather than whatever arrived most recently.
 *
 * Batching is what makes those two different things. The hub hands over a
 * quarter second of accelerometer in one burst and a quarter second of
 * gyroscope in another, in whichever order they happen to fill, so during a
 * burst the newest rotation or pressure reading can be one taken after the
 * sample it would otherwise be attached to. Pressure is where that does damage:
 * an airbag is recognised as a step above the pressure of the second before the
 * impact, and a baseline stamped with pressure from after it is a collision the
 * detector cannot see.
 *
 * Not thread safe and does not need to be. Every callback for every sensor is
 * delivered on the one handler, and a history never outlives the registration
 * that made it.
 */
internal class SensorHistory(capacity: Int) {
  private val times = LongArray(capacity)
  private val values = DoubleArray(capacity)
  private var count = 0
  private var next = 0

  fun add(timestampNanos: Long, value: Double) {
    times[next] = timestampNanos
    values[next] = value
    next = (next + 1) % times.size
    if (count < times.size) count += 1
  }

  /**
   * What the sensor last said at or before that instant, and null when it had
   * said nothing by then. Null rather than the nearest reading in either
   * direction, because a reading from afterwards is the thing this exists to
   * keep out, and a missing pressure costs the detector one signal it never
   * had rather than handing it a wrong one.
   */
  fun at(timestampNanos: Long): Double? {
    var best: Double? = null
    var bestAt = Long.MIN_VALUE
    for (i in 0 until count) {
      val t = times[i]
      if (t <= timestampNanos && (best == null || t > bestAt)) {
        bestAt = t
        best = values[i]
      }
    }
    return best
  }
}
