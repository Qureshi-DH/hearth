package expo.modules.hearthmotion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Looper
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

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
 * The classifier's two requests, aimed at the manifest receiver: the
 * sampled verdict on a schedule, and the transitions Play Services
 * debounces, which are the ones that wake a dead process and are the
 * moment Android lets it start the service.
 */
internal object MotionUpdates {
  private const val TAG = "HearthMotion"
  private const val SAMPLE_REQUEST_CODE = 8021
  private const val TRANSITION_REQUEST_CODE = 8022
  private const val DETECTION_INTERVAL_MS = 30_000L

  /** True when both requests took. A missing permission is the usual reason they do not. */
  fun register(context: Context): Boolean {
    val client = ActivityRecognition.getClient(context)
    forgetLegacyRequests(context, client)
    return try {
      client.requestActivityUpdates(
        DETECTION_INTERVAL_MS,
        broadcast(context, SAMPLE_REQUEST_CODE, HearthTransitionReceiver::class.java),
      )
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

  /**
   * Builds that came before aimed these requests at a receiver registered
   * at runtime, with an implicit intent. Play Services still holds them
   * after an update, firing at a receiver that no longer exists, so they
   * are taken back the first time the new ones are made.
   */
  private fun forgetLegacyRequests(context: Context, client: com.google.android.gms.location.ActivityRecognitionClient) {
    val flags =
      PendingIntent.FLAG_NO_CREATE or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val legacy =
      listOf(
        SAMPLE_REQUEST_CODE to "expo.modules.hearthmotion.ACTIVITY",
        TRANSITION_REQUEST_CODE to "expo.modules.hearthmotion.TRANSITION",
      )
    for ((code, action) in legacy) {
      val intent = Intent(action).setPackage(context.packageName)
      val pending = PendingIntent.getBroadcast(context, code, intent, flags) ?: continue
      runCatching { client.removeActivityUpdates(pending) }
      runCatching { client.removeActivityTransitionUpdates(pending) }
      pending.cancel()
    }
  }

  fun unregister(context: Context) {
    val client = ActivityRecognition.getClient(context)
    val samples = broadcast(context, SAMPLE_REQUEST_CODE, HearthTransitionReceiver::class.java)
    val transitions = broadcast(context, TRANSITION_REQUEST_CODE, HearthTransitionReceiver::class.java)
    runCatching { client.removeActivityUpdates(samples) }
    runCatching { client.removeActivityTransitionUpdates(transitions) }
    samples.cancel()
    transitions.cancel()
    TrackerPrefs(context).motionWanted = false
  }
}

/**
 * The fence around the parking spot, kept by Play Services and fired at
 * the manifest receiver, which is how a parked phone whose process is
 * long gone still hears that it left.
 */
internal object Fences {
  private const val TAG = "HearthFence"
  private const val REQUEST_CODE = 8023
  const val STATIONARY_ID = "stationary"
  private const val AWAIT_SECONDS = 10L

  /**
   * Arms the fence and records it. Waits for Play Services' answer when
   * asked to, which a module call can afford and a receiver cannot.
   */
  fun arm(context: Context, fence: TrackerPrefs.Fence, await: Boolean): Boolean {
    val geofence =
      Geofence.Builder()
        .setRequestId(STATIONARY_ID)
        .setCircularRegion(fence.lat, fence.lon, fence.radius)
        .setExpirationDuration(Geofence.NEVER_EXPIRE)
        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
        .build()
    val request =
      GeofencingRequest.Builder()
        .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_EXIT)
        .addGeofence(geofence)
        .build()
    val prefs = TrackerPrefs(context)
    return try {
      val task =
        LocationServices.getGeofencingClient(context)
          .addGeofences(request, broadcast(context, REQUEST_CODE, HearthFenceReceiver::class.java))
      // Tasks.await refuses the main thread outright, and a refusal here
      // would read as a fence that could not be set.
      if (await && Looper.myLooper() != Looper.getMainLooper()) {
        Tasks.await(task, AWAIT_SECONDS, TimeUnit.SECONDS)
      }
      prefs.fence = fence
      true
    } catch (error: Exception) {
      Log.w(TAG, "Fence refused: ${error.message}")
      prefs.fence = null
      false
    }
  }

  fun disarm(context: Context) {
    TrackerPrefs(context).fence = null
    runCatching {
      LocationServices.getGeofencingClient(context).removeGeofences(listOf(STATIONARY_ID))
    }
  }

  fun armed(context: Context): Boolean = TrackerPrefs(context).fence != null
}
