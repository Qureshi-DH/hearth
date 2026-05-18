package expo.modules.hearthmotion

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
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

private const val ACTION = "expo.modules.hearthmotion.ACTIVITY"
private const val REQUEST_CODE = 8021
private const val DETECTION_INTERVAL_MS = 30_000L

/**
 * Google Play Services already runs this classifier for the system, so asking
 * it what the phone is doing costs far less than waking the GPS to work it out
 * from position changes.
 *
 * The bodies below are plain methods rather than long lambdas. An AsyncFunction
 * lambda infers its return type from its last expression, which makes an early
 * return inside one a compile error that is easy to write and hard to read.
 */
class HearthMotionModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private var pendingIntent: PendingIntent? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HearthMotion")

    Events("onMotionChange")

    AsyncFunction("isAvailableAsync") { playServicesReady() }

    AsyncFunction("getPermissionAsync") { permissionState() }

    AsyncFunction("requestPermissionAsync") { promise: Promise -> requestPermission(promise) }

    AsyncFunction("startUpdatesAsync") { startUpdates() }

    AsyncFunction("stopUpdatesAsync") { stopUpdates() }

    OnDestroy { stopUpdates() }
  }

  private fun playServicesReady(): Boolean =
    GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
      ConnectionResult.SUCCESS

  /** The permission only exists from Android 10, and is implicit before it. */
  private fun permissionState(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted"
    val granted =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
        PackageManager.PERMISSION_GRANTED
    return if (granted) "granted" else "denied"
  }

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
}
