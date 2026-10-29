package expo.modules.hearthmotion

import com.google.android.gms.location.DetectedActivity

/**
 * What the motion sensor's word means for location, decided without
 * JavaScript. Plain functions, so the rules can be checked outside Android.
 *
 * The classifier never starts location for itself. It says whether the
 * phone is moving, which a ping and a fix's label read, and the one thing it
 * starts is a drive, for crash detection, where a circle has asked for it.
 */
internal object Departure {
  enum class Action {
    NONE,
    /** A vehicle, and a circle that wants crash alerts: the drive's GPS and sensors begin. */
    DRIVE,
    /** On foot: the drive ends, if one was running. */
    END_DRIVE,
    /** Still, which a red light is as often as a car park: the drive ends if it holds. */
    STILL_IN_DRIVE,
  }

  /**
   * How long a ping may answer with the last fix while the phone lies still.
   * Past this, one real fix proves the classifier right, so a departure it
   * missed costs the family at most this long.
   */
  const val STILL_REUSE_MS = 60 * 60 * 1000L

  /** Out of a vehicle ends a drive whatever else is so, since one may have outlived sharing. */
  fun onTransition(enabled: Boolean, mode: String, crashDetection: Boolean, activity: String): Action =
    when (activity) {
      "automotive" -> if (enabled && mode != "off" && crashDetection) Action.DRIVE else Action.NONE
      "walking", "running", "cycling" -> Action.END_DRIVE
      "still" -> Action.STILL_IN_DRIVE
      else -> Action.NONE
    }

  /**
   * Whether a ping can be answered with the last fix sent, without asking
   * for location at all. The classifier has to have called the phone still
   * before that fix was taken and said nothing since: one that went still
   * after it moved on from where the fix was taken.
   */
  fun stillSinceLastFix(activity: String, activitySince: Long, lastFixAt: Long?, now: Long): Boolean {
    if (activity != "still" || activitySince <= 0L || lastFixAt == null) return false
    if (activitySince > lastFixAt) return false
    val age = now - lastFixAt
    return age in 0 until STILL_REUSE_MS
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

  /** The classifier's word in the server's terms. */
  fun serverActivity(activity: String): String =
    when (activity) {
      "automotive" -> "driving"
      "still", "walking", "running", "cycling" -> activity
      else -> "unknown"
    }
}
