package expo.modules.hearthmotion

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JavaScript tracker's headless task in a process the OS woke with
 * no screen: for the one fix a session without an upload key takes there,
 * and for the length of a drive, where crash detection reads the sensors.
 * Only ever started while the tracking service holds the foreground: a
 * plain service start from a background app is refused, and the tracking
 * service is what makes this app foreground.
 */
class HearthHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    val reason = intent?.getStringExtra(EXTRA_REASON) ?: "unknown"
    val data = Arguments.createMap()
    data.putString("reason", reason)
    return HeadlessJsTaskConfig(TASK, data, if (reason == AWAKE) AWAKE_TIMEOUT_MS else TIMEOUT_MS, true)
  }

  companion object {
    private const val TAG = "HearthHeadless"
    /** Registered under this name in index.tsx. */
    private const val TASK = "HearthTracker"
    private const val EXTRA_REASON = "reason"
    /** A fix's deadline and an upload, with room to spare. */
    private const val TIMEOUT_MS = 90_000L

    /**
     * React Native runs no JavaScript timer while the app is in the
     * background and no headless task is open. For as long as a drive runs,
     * one task stays open, and JavaScript holds it until the drive is over.
     */
    private const val AWAKE = "awake"
    /** A task the timeout ended is opened again by the drive's next fix. */
    private const val AWAKE_TIMEOUT_MS = 2 * 60 * 60 * 1000L
    /** Let go of early, it is not asked for again on the very next fix. */
    private const val AWAKE_COOLDOWN_MS = 60_000L

    @Volatile private var awakeSince = 0L
    @Volatile private var releasedAt = 0L

    fun keepAwake(context: Context) {
      val now = SystemClock.elapsedRealtime()
      if (awakeSince != 0L && now - awakeSince < AWAKE_TIMEOUT_MS) return
      if (releasedAt != 0L && now - releasedAt < AWAKE_COOLDOWN_MS) return
      awakeSince = now
      if (!start(context, AWAKE)) awakeSince = 0L
    }

    /** JavaScript let go of the task, the drive being over. */
    fun released() {
      awakeSince = 0L
      releasedAt = SystemClock.elapsedRealtime()
    }

    fun start(context: Context, reason: String): Boolean {
      val intent = Intent(context, HearthHeadlessService::class.java).putExtra(EXTRA_REASON, reason)
      return try {
        context.startService(intent)
        true
      } catch (error: Exception) {
        // Background, with no foreground service to lean on. The server
        // asks again.
        Log.w(TAG, "Headless start refused ($reason): ${error.message}")
        false
      }
    }
  }
}
