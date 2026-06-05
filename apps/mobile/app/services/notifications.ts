import { Platform } from "react-native"
import Constants from "expo-constants"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import type { ServerInfo } from "@hearth/shared"

import { endpoints } from "@/services/api"
import { reportNow } from "@/services/location/tracker"

export type PushSetupResult =
  | { kind: "registered"; provider: "expo" }
  | { kind: "ntfy"; topic: string; baseUrl: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "denied" }
  | { kind: "none" }

/**
 * Routine arrivals still show a banner, but stay silent. The user is already
 * looking at the map, so only an SOS or a nudge is worth a sound.
 */
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const type = (notification.request.content.data as { type?: string } | undefined)?.type
    const urgent = type === "sos_started" || type === "nudge"
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: urgent,
      shouldSetBadge: false,
    }
  },
})

/** Android channels map to the server's notification classes. */
export async function setupChannels(): Promise<void> {
  if (Platform.OS !== "android") return
  await Notifications.setNotificationChannelAsync("default", {
    name: "Arrivals and updates",
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: "#FF7A45",
  })
  await Notifications.setNotificationChannelAsync("alerts", {
    name: "Alerts",
    description: "Low battery, phone offline, location requests.",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 120, 200],
    lightColor: "#FFC470",
  })
  await Notifications.setNotificationChannelAsync("sos", {
    name: "SOS",
    description: "Emergency alerts from your circle. Bypasses Do Not Disturb.",
    importance: Notifications.AndroidImportance.MAX,
    bypassDnd: true,
    vibrationPattern: [0, 400, 200, 400, 200, 400],
    lightColor: "#FF5C7A",
    sound: "default",
  })
}

/** Safe to call on every launch. Registration is idempotent on the server. */
export async function setupPush(serverInfo: ServerInfo): Promise<PushSetupResult> {
  if (serverInfo.pushProvider === "none") return { kind: "none" }
  if (!Device.isDevice) return { kind: "unsupported", reason: "Push is unavailable on simulators." }

  if (serverInfo.pushProvider === "ntfy") {
    // The server derives an unguessable per-device topic, so there is no token to send.
    const result = await endpoints.push.register({ provider: "ntfy" })
    if (!result.ntfyTopic || !result.ntfyBaseUrl) {
      return { kind: "unsupported", reason: "Server did not return an ntfy topic." }
    }
    return { kind: "ntfy", topic: result.ntfyTopic, baseUrl: result.ntfyBaseUrl }
  }

  if (serverInfo.pushProvider === "webpush") {
    return {
      kind: "unsupported",
      reason: "Web Push is for browsers. Use the app's built-in transport instead.",
    }
  }

  const existing = await Notifications.getPermissionsAsync()
  let status = existing.status
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status
  }
  if (status !== "granted") return { kind: "denied" }

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    Constants.easConfig?.projectId
  if (!projectId) {
    return {
      kind: "unsupported",
      reason:
        "Expo push needs an EAS project id. Run `eas init` in apps/mobile, or switch the server to PUSH_PROVIDER=ntfy.",
    }
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId })
  await endpoints.push.register({ provider: "expo", token: token.data })
  return { kind: "registered", provider: "expo" }
}

export async function disablePush(): Promise<void> {
  try {
    await endpoints.push.unregister()
  } catch {
    // Best effort. Signing out revokes the session and its token anyway.
  }
}

export interface NotificationTarget {
  type: string
  circleId?: string
  userId?: string
  placeId?: string
  alertId?: string
}

export function attachNotificationListeners(
  onOpen: (target: NotificationTarget) => void,
): () => void {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request.content.data as NotificationTarget | undefined
    if (data?.type === "nudge") void reportNow("nudge")
  })

  const responded = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as NotificationTarget | undefined
    if (data?.type) onOpen(data)
  })

  // The listeners above never fire for a notification that launched the app cold.
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const data = response?.notification.request.content.data as NotificationTarget | undefined
    if (data?.type) onOpen(data)
  })

  return () => {
    received.remove()
    responded.remove()
  }
}

/** Local alert used when the socket delivers an SOS while the app is open. */
export async function presentLocalSos(name: string, note: string | null): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `🚨 SOS from ${name}`,
      body: note ?? "Tap to see their location.",
      sound: "default",
      data: { type: "sos_started" },
      interruptionLevel: "timeSensitive",
      ...(Platform.OS === "android" ? { channelId: "sos" } : {}),
    },
    trigger: null,
  })
}
