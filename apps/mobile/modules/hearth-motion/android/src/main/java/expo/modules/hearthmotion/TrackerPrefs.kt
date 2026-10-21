package expo.modules.hearthmotion

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * What the receivers need to act without JavaScript: whether sharing is
 * on, which tier the tracker believes it is in, the request to run when
 * the service is started at a departure, the fence that is armed, and
 * whether the classifier is wanted. Written through, not deferred: a
 * receiver's process can be gone within the second.
 */
internal class TrackerPrefs(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

  var enabled: Boolean
    get() = prefs.getBoolean(KEY_ENABLED, false)
    set(value) = write { putBoolean(KEY_ENABLED, value) }

  /** "off", "moving" or "stationary", as the JavaScript tracker last said. */
  var mode: String
    get() = prefs.getString(KEY_MODE, "off") ?: "off"
    set(value) = write { putString(KEY_MODE, value) }

  var movingRequest: ServiceRequest
    get() = json(KEY_MOVING_REQUEST)?.let(ServiceRequest::fromJson) ?: ServiceRequest.DEFAULT_MOVING
    set(value) = write { putString(KEY_MOVING_REQUEST, value.toJson().toString()) }

  /** The request the service is running, for a sticky restart to pick up. */
  var serviceRequest: ServiceRequest?
    get() = json(KEY_SERVICE_REQUEST)?.let(ServiceRequest::fromJson)
    set(value) = write { putString(KEY_SERVICE_REQUEST, value?.toJson()?.toString()) }

  /** Whether the tracking service should be running: true from a start until a stop that was asked for. */
  var serviceWanted: Boolean
    get() = prefs.getBoolean(KEY_SERVICE_WANTED, false)
    set(value) = write { putBoolean(KEY_SERVICE_WANTED, value) }

  var fence: Fence?
    get() =
      json(KEY_FENCE)?.let {
        Fence(it.getDouble("lat"), it.getDouble("lon"), it.getDouble("radius").toFloat())
      }
    set(value) =
      write {
        putString(
          KEY_FENCE,
          value?.let {
            JSONObject().put("lat", it.lat).put("lon", it.lon).put("radius", it.radius.toDouble()).toString()
          },
        )
      }

  var motionWanted: Boolean
    get() = prefs.getBoolean(KEY_MOTION_WANTED, false)
    set(value) = write { putBoolean(KEY_MOTION_WANTED, value) }

  /** What JavaScript calls the phone's activity, so a fix sent from here is labelled as it would have been. */
  var activity: String
    get() = prefs.getString(KEY_ACTIVITY, "unknown") ?: "unknown"
    set(value) = write { putString(KEY_ACTIVITY, value) }

  /** Where the native uploader posts, and the session key it posts with. Both or neither. */
  var uploadUrl: String?
    get() = prefs.getString(KEY_UPLOAD_URL, null)
    set(value) = write { putString(KEY_UPLOAD_URL, value) }

  var uploadKey: String?
    get() = prefs.getString(KEY_UPLOAD_KEY, null)
    set(value) = write { putString(KEY_UPLOAD_KEY, value) }

  /** The last process exit already put in the log, so each is told once. */
  var exitSeenAt: Long
    get() = prefs.getLong(KEY_EXIT_SEEN, 0L)
    set(value) = write { putLong(KEY_EXIT_SEEN, value) }

  /** When the brief service was last brought up to confirm a walk, so a fidgeting phone does not flash it every transition. */
  var lastConfirmAt: Long
    get() = prefs.getLong(KEY_LAST_CONFIRM, 0L)
    set(value) = write { putLong(KEY_LAST_CONFIRM, value) }

  private fun json(key: String): JSONObject? =
    prefs.getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

  private fun write(edit: SharedPreferences.Editor.() -> Unit) {
    prefs.edit().apply(edit).commit()
  }

  internal data class Fence(val lat: Double, val lon: Double, val radius: Float)

  companion object {
    private const val NAME = "hearth-tracker"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_MODE = "mode"
    private const val KEY_MOVING_REQUEST = "movingRequest"
    private const val KEY_SERVICE_REQUEST = "serviceRequest"
    private const val KEY_SERVICE_WANTED = "serviceWanted"
    private const val KEY_FENCE = "fence"
    private const val KEY_MOTION_WANTED = "motionWanted"
    private const val KEY_LAST_CONFIRM = "lastConfirmAt"
    private const val KEY_ACTIVITY = "activity"
    private const val KEY_UPLOAD_URL = "uploadUrl"
    private const val KEY_UPLOAD_KEY = "uploadKey"
    private const val KEY_EXIT_SEEN = "exitSeenAt"
  }
}
