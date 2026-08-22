package expo.modules.hearthmotion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The foreground service that carries one location fix and its notification,
 * "Updating your location", then goes. A high priority push starts it from
 * the message handler, which is the moment Android allows a service to start
 * from the background, and the JavaScript that takes the fix runs under it
 * and stops it; if nothing does, it stops itself after the fix's own
 * deadline, so the notification never stays.
 */
class HearthWakeService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val stop = Runnable { stopSelfGracefully() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelfGracefully()
      return START_NOT_STICKY
    }
    val notification = buildNotification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    running = true
    handler.removeCallbacks(stop)
    handler.postDelayed(stop, MAX_LIFETIME_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(stop)
    running = false
    super.onDestroy()
  }

  private fun stopSelfGracefully() {
    handler.removeCallbacks(stop)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    running = false
    stopSelf()
  }

  companion object {
    const val ACTION_STOP = "expo.modules.hearthmotion.WAKE_STOP"
    const val CHANNEL_ID = "hearth-wake"
    private const val NOTIFICATION_ID = 7421
    /** The fix's own deadline, so the notification never outlives it. */
    private const val MAX_LIFETIME_MS = 30_000L

    @Volatile
    var running = false
      private set

    /**
     * True when the start was accepted. Android 12 and later refuse a start
     * from the background outside the allowed moments, and the refusal is an
     * exception on the caller rather than a state.
     */
    fun start(context: Context): Boolean {
      val intent = Intent(context, HearthWakeService::class.java)
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (error: Exception) {
        false
      }
    }

    fun stop(context: Context) {
      if (!running) return
      val intent = Intent(context, HearthWakeService::class.java).setAction(ACTION_STOP)
      try {
        context.startService(intent)
      } catch (error: Exception) {
        // Already gone.
      }
    }

    private fun buildNotification(context: Context): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        // The lowest importance: no sound, no status bar icon on most
        // launchers, collapsed in the silent part of the shade for the
        // second it shows.
        val channel = NotificationChannel(CHANNEL_ID, "Location updates", NotificationManager.IMPORTANCE_MIN)
        channel.description = "Shown for a moment while Hearth updates your location."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val icon = context.applicationInfo.icon
      val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(context)
      return builder
        .setContentTitle("Hearth")
        .setContentText("Updating your location")
        .setSmallIcon(icon)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build()
    }
  }
}
