package expo.modules.hearthmotion

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Sits in front of expo-notifications' own service (the manifest gives it
 * the higher priority) so a wake or a watch can start the wake service
 * inside the message handler, the one moment a background app is allowed to
 * start a service on Android 12 and later. Everything else about the message
 * goes on to expo-notifications as before, including the JavaScript task
 * that takes the fix under the service just started. Expo packs the push's
 * data as a JSON string under "body".
 */
class HearthMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (wantsWake(remoteMessage)) HearthWakeService.start(this)
    super.onMessageReceived(remoteMessage)
  }

  private fun wantsWake(remoteMessage: RemoteMessage): Boolean {
    val body = remoteMessage.data["body"] ?: return false
    return try {
      when (JSONObject(body).optString("type")) {
        "wake", "watch", "nudge_requested" -> true
        else -> false
      }
    } catch (error: Exception) {
      false
    }
  }
}
