package expo.modules.hearthmotion

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.LocationServices

/**
 * Builds before 1.3.4 asked Play Services for a classifier verdict every half
 * minute and a fence around the parking spot. Play Services keeps such
 * requests across an update, so they are taken back once, by the same
 * request codes and components. The transitions stay: MotionUpdates asks for
 * them again under the same code. A PendingIntent matches on its component,
 * so naming the fence receiver by its class name finds it without the class.
 */
internal object LegacyRequests {
  private const val PACKAGE = "expo.modules.hearthmotion"
  private const val TRANSITION_RECEIVER = "$PACKAGE.HearthTransitionReceiver"
  private const val FENCE_RECEIVER = "$PACKAGE.HearthFenceReceiver"
  private const val SAMPLE_REQUEST_CODE = 8021
  private const val LEGACY_TRANSITION_REQUEST_CODE = 8022
  private const val FENCE_REQUEST_CODE = 8023
  private const val FENCE_ID = "stationary"

  fun forget(context: Context) {
    val prefs = TrackerPrefs(context)
    if (prefs.legacyForgotten) return
    val activity = ActivityRecognition.getClient(context)
    existing(context, SAMPLE_REQUEST_CODE, component(context, TRANSITION_RECEIVER))?.let {
      runCatching { activity.removeActivityUpdates(it) }
      it.cancel()
    }
    // Older still, aimed at a receiver registered at runtime.
    for ((code, action) in listOf(SAMPLE_REQUEST_CODE to "$PACKAGE.ACTIVITY", LEGACY_TRANSITION_REQUEST_CODE to "$PACKAGE.TRANSITION")) {
      existing(context, code, Intent(action).setPackage(context.packageName))?.let {
        runCatching { activity.removeActivityUpdates(it) }
        runCatching { activity.removeActivityTransitionUpdates(it) }
        it.cancel()
      }
    }
    val fences = LocationServices.getGeofencingClient(context)
    runCatching { fences.removeGeofences(listOf(FENCE_ID)) }
    existing(context, FENCE_REQUEST_CODE, component(context, FENCE_RECEIVER))?.let {
      runCatching { fences.removeGeofences(it) }
      it.cancel()
    }
    prefs.forgetLegacyKeys()
    prefs.legacyForgotten = true
  }

  private fun component(context: Context, name: String): Intent =
    Intent().setComponent(ComponentName(context.packageName, name))

  private fun existing(context: Context, requestCode: Int, intent: Intent): PendingIntent? {
    val flags =
      PendingIntent.FLAG_NO_CREATE or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    return PendingIntent.getBroadcast(context, requestCode, intent, flags)
  }
}
