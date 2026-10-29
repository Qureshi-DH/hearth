import { Platform } from "react-native"
import type { DeviceHealth } from "@hearth/shared"
import * as Application from "expo-application"
import * as Device from "expo-device"

import { endpoints } from "@/services/api"
import { motionPermission } from "@/services/location/motion"
import { addPowerStateListener, getPermissionSnapshot } from "@/services/permissions"
import { useAuthStore } from "@/stores/auth"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore } from "@/stores/tracking"
import { load, save } from "@/utils/storage"

/**
 * What stands between this phone and reporting, told to the server so the
 * family sees "location permission is off" under a name instead of a phone
 * that went quiet for no reason, and so the server does not call a phone
 * offline that has said why it cannot report. Sent whenever any of it changes
 * and at most once a day otherwise, since the server keeps the last word.
 */
const LAST_KEY = "hearth.health.v1"
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000
/**
 * What the tracker notices in the background can flap, Location off and on
 * again in a car park, and every change would be a request. The app opening
 * always sends.
 */
const BACKGROUND_GAP_MS = 10 * 60 * 1000

interface Sent {
  body: string
  at: number
  /** Whose it was. The next account on this phone has told the server nothing yet. */
  user?: string | null
}

let watchingPower = false

/**
 * Low Power Mode and Battery Saver are the one thing here that flips without
 * the app being opened, and the server only ever learns of it from us. The
 * listener lives for the process, installed on the first report so that no
 * caller has to remember to.
 */
function watchPowerState(): void {
  if (watchingPower) return
  watchingPower = true
  addPowerStateListener(() => {
    void reportHealth()
  })
}

/**
 * A process the OS started for the tracker never derives the session's
 * status, which stays "booting" there, so the stored session is asked.
 */
async function hasSession(): Promise<boolean> {
  const { status, serverUrl, user } = useAuthStore.getState()
  if (status === "signed_in") return true
  if (status !== "booting" || !serverUrl || !user) return false
  return (await tokenVault.hydrate()) != null
}

export async function reportHealth({ background = false }: { background?: boolean } = {}) {
  if (!(await hasSession())) return
  watchPowerState()
  const [snapshot, motion] = await Promise.all([getPermissionSnapshot(), motionPermission()])
  const android = Platform.OS === "android"
  const health: DeviceHealth & { appVersion?: string; osVersion?: string } = {
    locationPermission: snapshot.location,
    locationServices: snapshot.servicesEnabled,
    preciseLocation: snapshot.preciseLocation,
    ...(motion !== "unavailable" ? { motionPermission: motion } : {}),
    sharingEnabled: useTrackingStore.getState().enabled,
    ...(Platform.OS === "ios" && snapshot.backgroundRefresh !== "n/a"
      ? { backgroundRefresh: snapshot.backgroundRefresh }
      : {}),
    ...(android && snapshot.batteryOptimization !== "n/a"
      ? { batteryOptimised: snapshot.batteryOptimization === "optimized" }
      : {}),
    ...(android ? { backgroundRestricted: snapshot.backgroundRestricted } : {}),
    lowPowerMode: snapshot.lowPowerMode,
    ...(snapshot.manufacturer ? { manufacturer: snapshot.manufacturer } : {}),
    // The session keeps what the phone signed in with, and an update since
    // would never reach it otherwise.
    ...(Application.nativeApplicationVersion
      ? { appVersion: Application.nativeApplicationVersion }
      : {}),
    ...(Device.osVersion ? { osVersion: Device.osVersion } : {}),
  }
  const body = JSON.stringify(health)
  const user = useAuthStore.getState().user?.id ?? null
  const stored = load<Sent>(LAST_KEY)
  const last = stored && (stored.user ?? null) === user ? stored : null
  if (last && last.body === body && Date.now() - last.at < RESEND_AFTER_MS) return
  if (background && last && Date.now() - last.at < BACKGROUND_GAP_MS) return
  try {
    await endpoints.auth.health(health)
    save(LAST_KEY, { body, at: Date.now(), user } satisfies Sent)
  } catch {
    // Offline, or a server without the route. It is sent again next time.
  }
}
