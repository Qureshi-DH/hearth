package expo.modules.hearthmotion

import com.google.android.gms.location.DetectedActivity

/**
 * What the receivers do about a departure without JavaScript, decided
 * from what the tracker last said it believed. Plain functions, so the
 * rules can be checked outside Android.
 */
internal object Departure {
  enum class Action {
    /** Nothing: sharing is off, the service is already up, or the verdict is not a departure. */
    NONE,
    /** The tracking service with the moving request: a journey has begun, or the service died under one. */
    TRACK,
    /** The brief service for one fix: a walk the tracker confirms against the parking spot. */
    BRIEF,
  }

  /** A fidgeting phone reads walking every transition; the confirming fix is asked for at most this often. */
  const val CONFIRM_INTERVAL_MS = 2 * 60 * 1000L

  fun onTransition(
    enabled: Boolean,
    mode: String,
    serviceUp: Boolean,
    activity: String,
    now: Long,
    lastConfirmAt: Long,
  ): Action {
    if (!enabled || mode == "off") return Action.NONE
    // On the move, the service is wanted whatever the verdict; a transition
    // is a moment Android lets it come back after an OEM took it down.
    if (mode == "moving") return if (serviceUp) Action.NONE else Action.TRACK
    return when (activity) {
      // A vehicle ends a stop: the classifier is sure, and a car pulling
      // away is clear of the parking spot within the minute.
      "automotive" -> Action.TRACK
      // On foot is confirmed first. A phone handled in bed reads as
      // walking, and the full tier for that is a notification for nothing.
      "walking", "running", "cycling" ->
        if (now - lastConfirmAt >= CONFIRM_INTERVAL_MS) Action.BRIEF else Action.NONE
      else -> Action.NONE
    }
  }

  fun onFenceExit(enabled: Boolean, mode: String, serviceUp: Boolean): Action {
    if (!enabled || mode == "off") return Action.NONE
    return if (serviceUp) Action.NONE else Action.TRACK
  }

  fun activityName(type: Int): String =
    when (type) {
      DetectedActivity.STILL -> "still"
      DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> "walking"
      DetectedActivity.RUNNING -> "running"
      DetectedActivity.ON_BICYCLE -> "cycling"
      DetectedActivity.IN_VEHICLE -> "automotive"
      else -> "unknown"
    }
}
