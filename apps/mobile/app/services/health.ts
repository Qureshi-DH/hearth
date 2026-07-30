import { Platform } from "react-native"
import type { DeviceHealth } from "@hearth/shared"

import { endpoints } from "@/services/api"
import { getPermissionSnapshot } from "@/services/permissions"
import { useAuthStore } from "@/stores/auth"
import { load, save } from "@/utils/storage"

/**
 * What stands between this phone and reporting, told to the server so the
 * family sees "location permission is off" under a name instead of a phone
 * that went quiet for no reason, and so the server does not call a phone
 * offline that has said why it cannot report. Sent when it changes and at
 * most once a day otherwise, since the server keeps the last word.
 */
const LAST_KEY = "hearth.health.v1"
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000

interface Sent {
  body: string
  at: number
}

export async function reportHealth(): Promise<void> {
  if (useAuthStore.getState().status !== "signed_in") return
  const snapshot = await getPermissionSnapshot()
  const health: DeviceHealth = {
    locationPermission: snapshot.location,
    locationServices: snapshot.servicesEnabled,
    ...(Platform.OS === "ios" && snapshot.backgroundRefresh !== "n/a"
      ? { backgroundRefresh: snapshot.backgroundRefresh }
      : {}),
    ...(Platform.OS === "android" && snapshot.batteryOptimization !== "n/a"
      ? { batteryOptimised: snapshot.batteryOptimization === "optimized" }
      : {}),
  }
  const body = JSON.stringify(health)
  const last = load<Sent>(LAST_KEY)
  if (last && last.body === body && Date.now() - last.at < RESEND_AFTER_MS) return
  try {
    await endpoints.auth.health(health)
    save(LAST_KEY, { body, at: Date.now() } satisfies Sent)
  } catch {
    // Offline, or a server without the route. It is sent again next time.
  }
}
