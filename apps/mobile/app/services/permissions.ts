import { Linking, Platform } from "react-native"
import * as BackgroundTask from "expo-background-task"
import Constants from "expo-constants"
import * as IntentLauncher from "expo-intent-launcher"
import * as Location from "expo-location"
import * as Notifications from "expo-notifications"

import { useTrackingStore, type PermissionLevel } from "@/stores/tracking"

export type SimpleStatus = "granted" | "denied" | "undetermined" | "n/a"

export interface PermissionSnapshot {
  location: PermissionLevel
  /** The device-wide switch. Granted access is worth nothing while this is off. */
  servicesEnabled: boolean
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
 * Hearth asks for location, notifications, and (only where this phone has the
 * motion toggle on, or a circle has asked for incident alerts) activity
 * recognition, which is what lets the GPS sleep while the phone is not moving.
 * The photo picker is reached through the OS picker for a profile picture,
 * which grants access to the one chosen file rather than the library. Nothing
 * here asks for contacts, Bluetooth, or the advertising identifier. Invites are
 * codes and QR, and there are no hardware tags.
 */
export async function getPermissionSnapshot(): Promise<PermissionSnapshot> {
  const [foreground, background, notifications, servicesEnabled, taskStatus] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
    // Unknown reads as on: a false alarm about the GPS being off is worse than
    // staying quiet, because the banner it raises cannot be acted on.
    Location.hasServicesEnabledAsync().catch(() => true),
    BackgroundTask.getStatusAsync().catch(() => null),
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

  // Background App Refresh, not Location Services. Reading the second and
  // labelling it the first told people to go and fix the wrong switch.
  const backgroundRefresh: PermissionSnapshot["backgroundRefresh"] =
    Platform.OS !== "ios"
      ? "n/a"
      : taskStatus === BackgroundTask.BackgroundTaskStatus.Restricted
        ? "restricted"
        : taskStatus === BackgroundTask.BackgroundTaskStatus.Available
          ? "available"
          : "n/a"

  return {
    location,
    servicesEnabled,
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
  const packageName = Constants.expoConfig?.android?.package ?? "com.binary.rewind.hearth"
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

/**
 * The device-wide Location Services switch, which on Android does not live in
 * this app's settings page at all. iOS has no supported deep link to it, so the
 * app's own page is as close as it gets.
 */
export async function openLocationSettings(): Promise<void> {
  if (Platform.OS === "android") {
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.LOCATION_SOURCE_SETTINGS,
      )
      return
    } catch {
      // Some OEM builds have no such activity. The app page is better than
      // nothing happening when someone taps the only button offered.
    }
  }
  await openAppSettings()
}
