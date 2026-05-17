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
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val ACTION = "expo.modules.hearthmotion.ACTIVITY"
private const val DETECTION_INTERVAL_MS = 30_000L

/**
 * Google Play Services already runs this classifier for the system, so asking
 * it what the phone is doing costs far less than waking the GPS to work it out
 * from position changes.
 */
class HearthMotionModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private var pendingIntent: PendingIntent? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HearthMotion")

    Events("onMotionChange")

    AsyncFunction("isAvailableAsync") {
      // The classifier is part of Play Services, so a device without it can
      // never answer.
      com.google.android.gms.common.GoogleApiAvailability.getInstance()
        .isGooglePlayServicesAvailable(context) == com.google.android.gms.common.ConnectionResult.SUCCESS
    }

    AsyncFunction("getPermissionAsync") { permissionState() }

    AsyncFunction("requestPermissionAsync") { promise: expo.modules.kotlin.Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || permissionState() == "granted") {
        promise.resolve(permissionState())
        return@AsyncFunction
      }
      appContext.permissions?.askForPermissions(
        { promise.resolve(permissionState()) },
        Manifest.permission.ACTIVITY_RECOGNITION,
      ) ?: promise.resolve("denied")
    }

    AsyncFunction("startUpdatesAsync") {
      if (permissionState() != "granted") throw SecurityException("Activity recognition not granted")
      if (receiver != null) return@AsyncFunction

      val filter = IntentFilter(ACTION)
      val listener = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          val result = intent?.let { ActivityRecognitionResult.extractResult(it) } ?: return
          val best = result.mostProbableActivity
          sendEvent(
            "onMotionChange",
            mapOf("activity" to best.type.toActivityName(), "confidence" to best.confidence),
          )
        }
      }
      ContextCompat.registerReceiver(context, listener, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
      receiver = listener

      val intent = Intent(ACTION).setPackage(context.packageName)
      val flags =
        PendingIntent.FLAG_UPDATE_CURRENT or
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val pending = PendingIntent.getBroadcast(context, 0, intent, flags)
      pendingIntent = pending

      ActivityRecognition.getClient(context)
        .requestActivityUpdates(DETECTION_INTERVAL_MS, pending)
    }

    AsyncFunction("stopUpdatesAsync") {
      pendingIntent?.let { ActivityRecognition.getClient(context).removeActivityUpdates(it) }
      pendingIntent = null
      receiver?.let { runCatching { context.unregisterReceiver(it) } }
      receiver = null
    }

    OnDestroy {
      pendingIntent?.let {
        runCatching { ActivityRecognition.getClient(context).removeActivityUpdates(it) }
      }
      receiver?.let { runCatching { context.unregisterReceiver(it) } }
    }
  }

  private fun permissionState(): String {
    // The permission only exists from Android 10, and is implicit before it.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted"
    val granted =
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) ==
        PackageManager.PERMISSION_GRANTED
    return if (granted) "granted" else "denied"
  }
}

private fun Int.toActivityName(): String =
  when (this) {
    DetectedActivity.STILL -> "still"
    DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> "walking"
    DetectedActivity.RUNNING -> "running"
    DetectedActivity.ON_BICYCLE -> "cycling"
    DetectedActivity.IN_VEHICLE -> "automotive"
    else -> "unknown"
  }
