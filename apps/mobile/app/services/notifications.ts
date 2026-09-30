import { Platform } from "react-native"
import * as Application from "expo-application"
import Constants from "expo-constants"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import * as TaskManager from "expo-task-manager"
import { DEFAULTS, type ServerInfo } from "@hearth/shared"

import { endpoints } from "@/services/api"
import { logTracker } from "@/services/location/log"
import {
  BACKGROUND_LOCATION_TASK,
  enterWatched,
  reassertService,
  wakeFix,
} from "@/services/location/tracker"

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
    const urgent = type === "sos_started" || type === "nudge_requested"
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
    // No sound key on purpose. Leaving it out is what selects the system
    // default. A string names a sound file bundled with the app, so "default"
    // was looked up as a file, logged as missing, and left the channel silent.
  })
  // The location service's own channel is created by the native service in
  // modules/hearth-motion, at the lowest importance, the first time it
  // runs. The channel expo-location's service used is gone with it; an
  // install that had one would otherwise keep showing it in settings.
  await Notifications.deleteNotificationChannelAsync(
    `${Application.applicationId}:${BACKGROUND_LOCATION_TASK}`,
  ).catch(() => {})
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
        "Expo push needs an EAS project id. Run `npx eas-cli@latest init` in apps/mobile, or switch the server to PUSH_PROVIDER=ntfy.",
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

export const NOTIFICATION_WAKE_TASK = "hearth-notification-wake"

/**
 * The type a push carries, from whichever shape the platform hands the
 * background task. Android delivers the data fields as strings, iOS as a
 * JSON string under dataString, and Expo's own envelope puts the payload in
 * body. Any of them may carry the type.
 */
export function pushType(payload: unknown): string | null {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data
  if (!data) return null
  if (typeof data.type === "string") return data.type
  const nested = parseNested(data)
  return typeof nested?.type === "string" ? nested.type : null
}

/** The payload as Android hands it to a background task: JSON in a string. */
function parseNested(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null
  for (const key of ["dataString", "body"]) {
    const raw = data[key]
    if (typeof raw !== "string") continue
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      // Not JSON, not ours.
    }
  }
  return null
}

const WAKE_TYPES = new Set(["wake", "nudge_requested"])
const WATCH_TYPE = "watch"

// Runs for a data-only push with the app in the background or not running
// at all. The server sends one when it wants a fix and the phone's control
// channel is closed: a phone gone quiet, the map or a member's page opened,
// or Live. The answer is a fix, or the live tier for a watch. Defined at
// module scope: the OS can hand this over before any React code has mounted.
TaskManager.defineTask(NOTIFICATION_WAKE_TASK, async ({ data, error }) => {
  if (error) return
  const type = pushType(data)
  logTracker("push", { type })
  if (type === WATCH_TYPE) {
    await enterWatched(watchSeconds(data))
    return
  }
  if (!type || !WAKE_TYPES.has(type)) return
  // A high priority push is one of the moments Android lets the location
  // service start from the background. A phone whose journey began at a
  // moment Android refused has been on throttled fixes since, and this is
  // where the service comes back. The service first, while the moment lasts.
  await reassertService({ exempt: true })
  await wakeFix()
})

function watchSeconds(payload: unknown): number {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data
  const raw = data?.seconds ?? parseNested(data)?.seconds
  const seconds = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, DEFAULTS.watchWindowSeconds)
    : DEFAULTS.watchWindowSeconds
}

/**
 * Safe to call on every launch. Without this the task above is defined but
 * never receives anything.
 */
export async function registerWakeTask(): Promise<void> {
  if (Platform.OS === "web") return
  try {
    await Notifications.registerTaskAsync(NOTIFICATION_WAKE_TASK)
  } catch {
    // No push in this build, or a simulator. The heartbeat still runs.
  }
}

export function attachNotificationListeners(
  onOpen: (target: NotificationTarget) => void,
): () => void {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    // The app is open, so the fix is the heartbeat's kind: no service needed
    // and nothing to bring back. A watch still goes live, since the family
    // member watching is not the one holding this phone.
    const data = notification.request.content.data as
      (NotificationTarget & { seconds?: number }) | undefined
    if (!data?.type) return
    if (data.type === WATCH_TYPE) void enterWatched(watchSeconds({ data }))
    else if (WAKE_TYPES.has(data.type)) void wakeFix()
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
