package expo.modules.hearthmotion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import org.json.JSONObject

/**
 * Declared in the manifest, so Play Services starts the process to
 * deliver to it. Everything a JavaScript tracker would want to know goes
 * on the queue; the one thing that cannot wait for JavaScript, starting
 * the service inside the moment Android allows it, is done here.
 */
class HearthTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (ActivityTransitionResult.hasResult(intent)) {
      val last = ActivityTransitionResult.extractResult(intent)?.transitionEvents?.lastOrNull() ?: return
      onTransition(context, Departure.activityName(last.activityType))
      return
    }
    val result = ActivityRecognitionResult.extractResult(intent) ?: return
    val best = result.mostProbableActivity
    // The sampled verdict is only for a tracker that is up to hear it: it
    // repeats every half minute, and a phone at rest says "still" all day.
    HearthEvents.emit(
      "onMotionChange",
      mapOf(
        "activity" to Departure.activityName(best.type),
        "confidence" to best.confidence,
        "source" to "sample",
      ),
    )
  }

  private fun onTransition(context: Context, activity: String) {
    val prefs = TrackerPrefs(context)
    val now = System.currentTimeMillis()
    TrackerQueue.event(context, JSONObject().put("type", "transition").put("activity", activity))
    when (
      Departure.onTransition(
        prefs.enabled,
        prefs.mode,
        HearthTrackingService.foreground,
        activity,
        now,
        prefs.lastConfirmAt,
      )
    ) {
      Departure.Action.TRACK -> HearthTrackingService.start(context, prefs.movingRequest, "transition")
      Departure.Action.BRIEF -> {
        prefs.lastConfirmAt = now
        HearthTrackingService.brief(context)
      }
      Departure.Action.NONE -> Unit
    }
    TrackerQueue.poke(context)
  }
}

class HearthFenceReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) {
      Log.w(TAG, "Fence event error ${event.errorCode}")
      return
    }
    val transition =
      when (event.geofenceTransition) {
        Geofence.GEOFENCE_TRANSITION_EXIT -> "exit"
        Geofence.GEOFENCE_TRANSITION_ENTER, Geofence.GEOFENCE_TRANSITION_DWELL -> "enter"
        else -> return
      }
    val ids = event.triggeringGeofences?.map { it.requestId } ?: return
    for (id in ids) {
      TrackerQueue.event(context, JSONObject().put("type", "fence").put("id", id).put("transition", transition))
    }
    if (transition == "exit" && Fences.STATIONARY_ID in ids) {
      val prefs = TrackerPrefs(context)
      if (Departure.onFenceExit(prefs.enabled, prefs.mode, HearthTrackingService.foreground) == Departure.Action.TRACK) {
        HearthTrackingService.start(context, prefs.movingRequest, "fence")
      }
    }
    TrackerQueue.poke(context)
  }

  private companion object {
    const val TAG = "HearthFence"
  }
}

/**
 * A reboot drops every request Play Services held, and an update may.
 * Both are moments Android lets a service start from the background, so
 * a phone that was on the move goes straight back to being tracked, and
 * a parked one gets its fence and classifier back. expo-task-manager
 * restores the resting request on its own.
 */
class HearthBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val prefs = TrackerPrefs(context)
    TrackerQueue.event(context, JSONObject().put("type", "boot"))
    if (!prefs.enabled || prefs.mode == "off") return
    if (prefs.motionWanted) MotionUpdates.register(context)
    prefs.fence?.let { Fences.arm(context, it, await = false) }
    if (prefs.mode == "moving") {
      HearthTrackingService.start(context, prefs.serviceRequest ?: prefs.movingRequest, "boot")
    }
  }
}
