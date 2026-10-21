package expo.modules.hearthmotion

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.ApplicationStartInfo
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * What the phone says about why Hearth went quiet, put in the tracker log
 * where a family member can share it. Without it a phone a vendor's battery
 * manager stopped looked the same as one with no signal.
 */
internal object HearthDiagnostics {
  @Volatile private var started = false

  /** Once a process, from whichever part of it Android starts first. */
  fun onProcessStart(context: Context) {
    if (started) return
    started = true
    val app = context.applicationContext
    runCatching { exits(app) }
    runCatching { start(app) }
    runCatching { power(app) }
  }

  /** A wake or a watch as it arrived, whether FCM still called it urgent, and how late it was. */
  fun push(context: Context, kind: String, message: RemoteMessage) {
    TrackerQueue.event(
      context,
      JSONObject()
        .put("type", "push")
        .put("kind", kind)
        .put("priority", priorityName(message.priority))
        .put("original", priorityName(message.originalPriority))
        .put("lateMs", if (message.sentTime > 0) System.currentTimeMillis() - message.sentTime else JSONObject.NULL),
    )
  }

  private fun exits(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
    val prefs = TrackerPrefs(context)
    val seen = prefs.exitSeenAt
    val fresh = manager.getHistoricalProcessExitReasons(context.packageName, 0, 5).filter { it.timestamp > seen }
    for (exit in fresh.sortedBy { it.timestamp }) {
      TrackerQueue.event(
        context,
        JSONObject()
          .put("type", "exit")
          .put("at", exit.timestamp)
          .put("reason", exitReason(exit.reason))
          .put("description", exit.description ?: JSONObject.NULL)
          .put("importance", exit.importance),
      )
    }
    fresh.maxOfOrNull { it.timestamp }?.let { prefs.exitSeenAt = it }
  }

  private fun start(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
    val info = manager.getHistoricalProcessStartReasons(1).firstOrNull() ?: return
    TrackerQueue.event(
      context,
      JSONObject()
        .put("type", "start")
        .put("reason", startReason(info.reason))
        // A force stop cancels every location request and geofence the
        // app had, and FCM delivers nothing until it is opened again.
        .put("forceStopped", info.wasForceStopped()),
    )
  }

  private fun power(context: Context) {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val event =
      JSONObject()
        .put("type", "power")
        .put("exempt", power?.isIgnoringBatteryOptimizations(context.packageName) ?: JSONObject.NULL)
        .put("saver", power?.isPowerSaveMode ?: JSONObject.NULL)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
      event.put("bucket", usage?.appStandbyBucket?.let(::bucketName) ?: JSONObject.NULL)
      event.put("restricted", activity?.isBackgroundRestricted ?: JSONObject.NULL)
    }
    TrackerQueue.event(context, event)
  }

  private fun priorityName(priority: Int): String =
    when (priority) {
      RemoteMessage.PRIORITY_HIGH -> "high"
      RemoteMessage.PRIORITY_NORMAL -> "normal"
      else -> "unknown"
    }

  private fun bucketName(bucket: Int): String =
    when (bucket) {
      UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
      UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working_set"
      UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
      UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
      UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "restricted"
      else -> bucket.toString()
    }

  private fun exitReason(reason: Int): String =
    when (reason) {
      ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
      ApplicationExitInfo.REASON_SIGNALED -> "signaled"
      ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
      ApplicationExitInfo.REASON_CRASH -> "crash"
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
      ApplicationExitInfo.REASON_ANR -> "anr"
      ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization_failure"
      ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
      ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
      ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
      ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
      ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
      ApplicationExitInfo.REASON_OTHER -> "other"
      ApplicationExitInfo.REASON_FREEZER -> "freezer"
      ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package_state_change"
      ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package_updated"
      else -> reason.toString()
    }

  private fun startReason(reason: Int): String =
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      reason.toString()
    } else {
      when (reason) {
        ApplicationStartInfo.START_REASON_ALARM -> "alarm"
        ApplicationStartInfo.START_REASON_BACKUP -> "backup"
        ApplicationStartInfo.START_REASON_BOOT_COMPLETE -> "boot"
        ApplicationStartInfo.START_REASON_BROADCAST -> "broadcast"
        ApplicationStartInfo.START_REASON_CONTENT_PROVIDER -> "provider"
        ApplicationStartInfo.START_REASON_JOB -> "job"
        ApplicationStartInfo.START_REASON_LAUNCHER -> "launcher"
        ApplicationStartInfo.START_REASON_PUSH -> "push"
        ApplicationStartInfo.START_REASON_SERVICE -> "service"
        ApplicationStartInfo.START_REASON_START_ACTIVITY -> "activity"
        else -> reason.toString()
      }
    }
}
