import { Linking, Platform } from "react-native"
import Constants from "expo-constants"
import * as IntentLauncher from "expo-intent-launcher"
import * as Location from "expo-location"
import * as Notifications from "expo-notifications"

import { useTrackingStore, type PermissionLevel } from "@/stores/tracking"

export type SimpleStatus = "granted" | "denied" | "undetermined" | "n/a"

export interface PermissionSnapshot {
  location: PermissionLevel
  /** Android can grant coarse only. iOS is always fine at the permission level. */
  preciseLocation: boolean
  notifications: SimpleStatus
  /** Android only. The OS exposes no way to read this, so it is our own record of asking. */
  batteryOptimization: "exempt_requested" | "not_requested" | "n/a"
  backgroundRefresh: "available" | "restricted" | "denied" | "n/a"
}

/**
 * One snapshot, so the onboarding checklist and the settings screen show the
 * same truth.
 *
 * Hearth never asks for contacts, photos, Bluetooth, motion, or the
 * advertising identifier, all of which other family apps ask for. Invites are codes
 * and QR, there is no avatar upload in v1, no hardware tags, and activity is
 * derived from speed on the server.
 */
export async function getPermissionSnapshot(): Promise<PermissionSnapshot> {
  const [foreground, background, notifications] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
  ])

  let location: PermissionLevel = "unknown"
  if (foreground.status === Location.PermissionStatus.GRANTED) {
    location = background?.status === Location.PermissionStatus.GRANTED ? "always" : "foreground"
  } else if (!foreground.canAskAgain) {
    location = "denied"
  }

  const preciseLocation =
    Platform.OS === "android" ? foreground.android?.accuracy !== "coarse" : true

  const notificationStatus: SimpleStatus = !notifications
    ? "n/a"
    : notifications.granted
      ? "granted"
      : notifications.canAskAgain
        ? "undetermined"
        : "denied"

  const backgroundRefresh: PermissionSnapshot["backgroundRefresh"] =
    Platform.OS === "ios"
      ? await Location.hasServicesEnabledAsync()
          .then((enabled) => (enabled ? "available" : "restricted"))
          .catch(() => "n/a")
      : "n/a"

  return {
    location,
    preciseLocation,
    notifications: notificationStatus,
    batteryOptimization:
      Platform.OS === "android"
        ? useTrackingStore.getState().batteryExemptionRequested
          ? "exempt_requested"
          : "not_requested"
        : "n/a",
    backgroundRefresh,
  }
}

/** Needed even without a push provider. SOS banners raised while the app is open are local. */
export async function requestNotifications(): Promise<SimpleStatus> {
  const result = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true, allowCriticalAlerts: false },
  })
  return result.granted ? "granted" : result.canAskAgain ? "undetermined" : "denied"
}

/**
 * Android battery optimisation ("Doze" and vendor variants) is the biggest
 * reason background location silently stops. There is no programmatic grant,
 * so the user has to be sent to the system dialog.
 */
export async function requestBatteryExemption(): Promise<void> {
  if (Platform.OS !== "android") return
  const packageName = Constants.expoConfig?.android?.package ?? "app.hearth.mobile"
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: `package:${packageName}` },
    )
  } catch {
    // Some OEM ROMs hide that dialog, so fall back to the general battery screen.
    await IntentLauncher.startActivityAsync(
      "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
    ).catch(() => {})
  }
  useTrackingStore.getState().setBatteryExemptionRequested(true)
}

export async function openAppSettings(): Promise<void> {
  if (Platform.OS === "ios") await Linking.openURL("app-settings:")
  else await Linking.openSettings()
}
