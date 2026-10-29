package expo.modules.hearthmotion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityTransitionResult
import org.json.JSONObject

/**
 * Declared in the manifest, so Play Services starts the process to deliver
 * to it. A transition is written down where the push handler and the
 * service read it, and goes on the queue for JavaScript. It starts no
 * location, with one exception: a vehicle, where a circle asked for crash
 * alerts, starts the drive, inside the moment Android allows the start.
 */
class HearthTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    HearthDiagnostics.onProcessStart(context)
    // The half-minute verdicts builds before 1.3.4 asked for land here
    // until Play Services lets them go, and say nothing a transition does not.
    if (!ActivityTransitionResult.hasResult(intent)) return
    val last = ActivityTransitionResult.extractResult(intent)?.transitionEvents?.lastOrNull() ?: return
    val activity = Departure.activityName(last.activityType)
    val prefs = TrackerPrefs(context)
    prefs.noteActivity(activity, System.currentTimeMillis())
    TrackerQueue.event(context, JSONObject().put("type", "transition").put("activity", activity))
    when (Departure.onTransition(prefs.enabled, prefs.mode, prefs.crashDetection, activity)) {
      Departure.Action.DRIVE -> HearthTrackingService.drive(context)
      Departure.Action.END_DRIVE -> HearthTrackingService.endDrive(context)
      Departure.Action.STILL_IN_DRIVE -> HearthTrackingService.stillDuringDrive(context)
      Departure.Action.NONE -> Unit
    }
    TrackerQueue.poke()
  }
}

/**
 * A reboot drops every request Play Services held, and an update may. The
 * classifier's transitions are asked for again, and the update is also
 * when the requests older builds left behind are taken back.
 */
class HearthBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    HearthDiagnostics.onProcessStart(context)
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val reboot = action == Intent.ACTION_BOOT_COMPLETED
    TrackerQueue.event(context, JSONObject().put("type", "boot").put("reboot", reboot))
    LegacyRequests.forget(context)
    val prefs = TrackerPrefs(context)
    // Switched off and carried somewhere, a phone the classifier last saw
    // still is no longer known to be. It says again soon enough.
    if (reboot) prefs.forgetActivity()
    if (prefs.enabled && prefs.mode != "off" && prefs.motionWanted) MotionUpdates.register(context)
  }
}
