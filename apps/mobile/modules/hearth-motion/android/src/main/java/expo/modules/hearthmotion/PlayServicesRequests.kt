package expo.modules.hearthmotion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity

/**
 * Play Services fills the intent it fires with the result, so every one of
 * these has to stay mutable, and each names its receiver outright so that
 * a process with nothing registered is started to take it.
 */
private fun broadcast(context: Context, requestCode: Int, receiver: Class<*>): PendingIntent {
  val flags =
    PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
  return PendingIntent.getBroadcast(context, requestCode, Intent(context, receiver), flags)
}

/**
 * The classifier's transitions, aimed at the manifest receiver. Play
 * Services debounces them, so they say a phone is still, on foot or in a
 * vehicle once it is, and they cost no location at all. They are the only
 * request: builds before 1.3.4 also asked for a verdict every half minute,
 * which started the process all day for a phone lying in a drawer.
 */
internal object MotionUpdates {
  private const val TAG = "HearthMotion"
  private const val TRANSITION_REQUEST_CODE = 8022

  /** True when the request took. A missing permission is the usual reason it does not. */
  fun register(context: Context): Boolean {
    val client = ActivityRecognition.getClient(context)
    return try {
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
      client.requestActivityTransitionUpdates(
        ActivityTransitionRequest(entering),
        broadcast(context, TRANSITION_REQUEST_CODE, HearthTransitionReceiver::class.java),
      )
      TrackerPrefs(context).motionWanted = true
      true
    } catch (error: SecurityException) {
      Log.w(TAG, "Activity recognition refused: ${error.message}")
      false
    }
  }

  fun unregister(context: Context) {
    val client = ActivityRecognition.getClient(context)
    val transitions = broadcast(context, TRANSITION_REQUEST_CODE, HearthTransitionReceiver::class.java)
    runCatching { client.removeActivityTransitionUpdates(transitions) }
    transitions.cancel()
    val prefs = TrackerPrefs(context)
    prefs.motionWanted = false
    prefs.forgetActivity()
  }
}
