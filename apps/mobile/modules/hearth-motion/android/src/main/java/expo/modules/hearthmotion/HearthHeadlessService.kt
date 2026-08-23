package expo.modules.hearthmotion

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JavaScript tracker's headless task, which drains the native
 * queue, in a process the OS woke with no screen. Only ever started while
 * the tracking service holds the foreground: a plain service start from
 * a background app is refused, and the tracking service is what makes
 * this app foreground.
 */
class HearthHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    val data = Arguments.createMap()
    data.putString("reason", intent?.getStringExtra(EXTRA_REASON) ?: "unknown")
    return HeadlessJsTaskConfig(TASK, data, TIMEOUT_MS, true)
  }

  companion object {
    private const val TAG = "HearthHeadless"
    /** Registered under this name in index.tsx. */
    private const val TASK = "HearthTracker"
    private const val EXTRA_REASON = "reason"
    /** A fix's deadline and an upload, with room to spare. */
    private const val TIMEOUT_MS = 90_000L

    fun start(context: Context, reason: String) {
      val intent = Intent(context, HearthHeadlessService::class.java).putExtra(EXTRA_REASON, reason)
      try {
        context.startService(intent)
      } catch (error: Exception) {
        // Background, with no foreground service to lean on. The queue
        // keeps what it has for the next launch.
        Log.w(TAG, "Headless start refused ($reason): ${error.message}")
      }
    }
  }
}
