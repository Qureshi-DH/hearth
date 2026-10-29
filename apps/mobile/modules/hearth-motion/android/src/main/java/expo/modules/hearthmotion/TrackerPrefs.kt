package expo.modules.hearthmotion

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * What the push handler, the receivers and the service need to answer
 * without JavaScript: whether sharing is on, where to send and with which
 * key, what the motion sensor last said and since when, whether a circle
 * wants crash detection, and the last fix sent, which the next one is
 * labelled against. Written through, not deferred: a receiver's process can
 * be gone within the second.
 */
internal class TrackerPrefs(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

  var enabled: Boolean
    get() = prefs.getBoolean(KEY_ENABLED, false)
    set(value) = write { putBoolean(KEY_ENABLED, value) }

  /** "off" or "on", as the JavaScript tracker last said. */
  var mode: String
    get() = prefs.getString(KEY_MODE, "off") ?: "off"
    set(value) = write { putString(KEY_MODE, value) }

  /** What the classifier last said the phone is doing, in its own words, and when it began. */
  var activity: String
    get() = prefs.getString(KEY_ACTIVITY, "unknown") ?: "unknown"
    private set(value) = write { putString(KEY_ACTIVITY, value) }

  var activitySince: Long
    get() = prefs.getLong(KEY_ACTIVITY_SINCE, 0L)
    private set(value) = write { putLong(KEY_ACTIVITY_SINCE, value) }

  /** A transition repeating the verdict in force does not move when it began. */
  fun noteActivity(next: String, at: Long) {
    if (next == activity && activitySince > 0L) return
    write {
      putString(KEY_ACTIVITY, next)
      putLong(KEY_ACTIVITY_SINCE, at)
    }
  }

  /** Nothing is known of what the phone is doing, after a reboot or with the classifier stopped. */
  fun forgetActivity() {
    write {
      putString(KEY_ACTIVITY, "unknown")
      putLong(KEY_ACTIVITY_SINCE, 0L)
    }
  }

  /** Whether the classifier's transitions should be running, so a reboot can ask for them again. */
  var motionWanted: Boolean
    get() = prefs.getBoolean(KEY_MOTION_WANTED, false)
    set(value) = write { putBoolean(KEY_MOTION_WANTED, value) }

  /** Whether any of the owner's circles asked for crash alerts, which is what a drive runs for. */
  var crashDetection: Boolean
    get() = prefs.getBoolean(KEY_CRASH_DETECTION, false)
    set(value) = write { putBoolean(KEY_CRASH_DETECTION, value) }

  /** Where the native uploader posts, and the session key it posts with. Both or neither. */
  var uploadUrl: String?
    get() = prefs.getString(KEY_UPLOAD_URL, null)
    set(value) = write { putString(KEY_UPLOAD_URL, value) }

  var uploadKey: String?
    get() = prefs.getString(KEY_UPLOAD_KEY, null)
    set(value) = write { putString(KEY_UPLOAD_KEY, value) }

  /**
   * The last fix sent from here, in the queue's shape. Written in the
   * background, since on Live it changes every second and losing the last
   * one to a kill costs one label.
   */
  var lastFix: JSONObject?
    get() = prefs.getString(KEY_LAST_FIX, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    set(value) = prefs.edit().putString(KEY_LAST_FIX, value?.toString()).apply()

  /** The last process exit already put in the log, so each is told once. */
  var exitSeenAt: Long
    get() = prefs.getLong(KEY_EXIT_SEEN, 0L)
    set(value) = write { putLong(KEY_EXIT_SEEN, value) }

  /** Whether the requests builds before 1.3.4 left with Play Services have been taken back. */
  var legacyForgotten: Boolean
    get() = prefs.getBoolean(KEY_LEGACY_FORGOTTEN, false)
    set(value) = write { putBoolean(KEY_LEGACY_FORGOTTEN, value) }

  /** What those builds kept here and nothing reads any more. */
  fun forgetLegacyKeys() {
    write { for (key in LEGACY_KEYS) remove(key) }
  }

  private fun write(edit: SharedPreferences.Editor.() -> Unit) {
    prefs.edit().apply(edit).commit()
  }

  companion object {
    private const val NAME = "hearth-tracker"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_MODE = "mode"
    private const val KEY_UPLOAD_URL = "uploadUrl"
    private const val KEY_UPLOAD_KEY = "uploadKey"
    private const val KEY_LAST_FIX = "lastFix"
    private const val KEY_ACTIVITY = "motionActivity"
    private const val KEY_ACTIVITY_SINCE = "motionActivitySince"
    private const val KEY_MOTION_WANTED = "motionWanted"
    private const val KEY_CRASH_DETECTION = "crashDetection"
    private const val KEY_EXIT_SEEN = "exitSeenAt"
    private const val KEY_LEGACY_FORGOTTEN = "legacyForgotten"
    private val LEGACY_KEYS =
      listOf("movingRequest", "serviceRequest", "serviceWanted", "fence", "lastConfirmAt", "activity")
  }
}
