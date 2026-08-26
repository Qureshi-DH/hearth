import { AppState, Platform } from "react-native"
import * as Notifications from "expo-notifications"

import { translate } from "@/i18n/translate"
import { stopTracking } from "@/services/location/tracker"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { useTrackingStore } from "@/stores/tracking"

/**
 * The server has refused this phone's refresh token, so the session is
 * over. The tracker stops, since the next account to sign in on this phone
 * must not upload the previous account's queued breadcrumbs, and the phone
 * says so on the shade when nobody is looking at it: a phone that signs
 * itself out in a pocket and goes quiet is exactly the thing the family
 * cannot tell from a phone that is fine.
 */
export async function sessionExpired(): Promise<void> {
  void stopTracking()
  useTrackingStore.getState().reset()
  useAuthStore.getState().signedOut()
  queryClient.clear()
  if (AppState.currentState === "active") return
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: translate("session:signedOutTitle"),
        body: translate("session:signedOutBody"),
        data: { type: "signed_out" },
        ...(Platform.OS === "android" ? { channelId: "alerts" } : {}),
      },
      trigger: null,
    })
  } catch {
    // No notification permission. The sign-in screen says it next time.
  }
}
