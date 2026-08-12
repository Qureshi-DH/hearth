import { Linking, Platform } from "react-native"
import * as Battery from "expo-battery"
import Constants from "expo-constants"
import * as Device from "expo-device"
import * as IntentLauncher from "expo-intent-launcher"
import * as Location from "expo-location"
import * as Notifications from "expo-notifications"

import { backgroundRefreshStatus } from "@/services/location/motion"
import { serviceDiedUnexpectedly } from "@/services/location/tracker"
import type { PermissionLevel } from "@/stores/tracking"

type MotionModule = typeof import("../../modules/hearth-motion").default

/**
 * The power switches below live in the same native module as motion. It is
 * loaded here a second time rather than through motion.ts because that file
 * belongs to the tracker and this one to the checklist, and an older install
 * without the module has to read as nothing to report rather than crash.
 */
let native: MotionModule | null = null
try {
  native = (require("../../modules/hearth-motion") as { default: MotionModule }).default
} catch {
  native = null
}

export type SimpleStatus = "granted" | "denied" | "undetermined" | "n/a"

export interface PermissionSnapshot {
  location: PermissionLevel
  /** The device-wide switch. Granted access is worth nothing while this is off. */
  servicesEnabled: boolean
  /** Android can grant coarse only. iOS is always fine at the permission level. */
  preciseLocation: boolean
  notifications: SimpleStatus
  /** Android only. "exempt" is the real answer from the OS, not a record of having asked. */
  batteryOptimization: "exempt" | "optimized" | "n/a"
  /**
   * iOS only, and read from UIApplication through the native module, which is
   * the only place that knows. "n/a" is Android, or a build without the module,
   * and the checklist shows those as something to check by hand.
   */
  backgroundRefresh: "available" | "restricted" | "denied" | "n/a"
  /**
   * Android only. The person set Hearth's background usage to Restricted,
   * which stops the location service outright. False everywhere else.
   */
  backgroundRestricted: boolean
  /** iOS Low Power Mode or Android Battery Saver. Both switch background work off. */
  lowPowerMode: boolean
  /** Build.MANUFACTURER, lowercased. Null where the OS does not say. */
  manufacturer: string | null
  /** Android only. The location service died without the tracker asking. */
  serviceStopped: boolean
}

/**
 * One snapshot, so the onboarding checklist and the settings screen show the
 * same truth.
 *
 * Hearth asks for location, notifications, and activity recognition. The last
 * is what lets the GPS sleep while the phone is not moving and what tells
 * crash detection a drive has started, so it is on the checklist for every
 * phone that can classify motion. Its state is read by motionPermission rather
 * than here, because it comes from the native module and the checklist hides
 * the row where the module or the hardware is missing. A phone that refuses it
 * works stops out from position instead.
 * The photo picker is reached through the OS picker for a profile picture,
 * which grants access to the one chosen file rather than the library. Nothing
 * here asks for contacts, Bluetooth, or the advertising identifier. Invites are
 * codes and QR, and there are no hardware tags.
 */
export async function getPermissionSnapshot(): Promise<PermissionSnapshot> {
  const [
    foreground,
    background,
    notifications,
    servicesEnabled,
    refresh,
    backgroundRestricted,
    lowPowerMode,
  ] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Notifications.getPermissionsAsync().catch(() => null),
    // Unknown reads as on: a false alarm about the GPS being off is worse than
    // staying quiet, because the banner it raises cannot be acted on.
    Location.hasServicesEnabledAsync().catch(() => true),
    Platform.OS === "ios" ? backgroundRefreshStatus() : Promise.resolve("unknown" as const),
    readBackgroundRestricted(),
    readLowPowerMode(),
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

  // Background App Refresh, not Location Services, and not the task
  // scheduler's status either: expo-background-task answers "available" on
  // every physical iPhone whatever the switch says.
  const backgroundRefresh: PermissionSnapshot["backgroundRefresh"] =
    refresh === "unknown" ? "n/a" : refresh

  const make = Device.manufacturer?.trim().toLowerCase()

  return {
    location,
    servicesEnabled,
    preciseLocation,
    notifications: notificationStatus,
    batteryOptimization: await readBatteryOptimization(),
    backgroundRefresh,
    backgroundRestricted,
    lowPowerMode,
    manufacturer: make ? make : null,
    serviceStopped: Platform.OS === "android" && serviceDiedUnexpectedly(),
  }
}

/**
 * The checklist used to show "On" after the exemption dialog had merely been
 * shown, with a Review link beside it because nothing could tell whether the
 * user had said yes. The OS does answer, so the row shows what it says.
 */
async function readBatteryOptimization(): Promise<PermissionSnapshot["batteryOptimization"]> {
  if (Platform.OS !== "android") return "n/a"
  try {
    return (await Battery.isBatteryOptimizationEnabledAsync()) ? "optimized" : "exempt"
  } catch {
    return "optimized"
  }
}

async function readBackgroundRestricted(): Promise<boolean> {
  if (Platform.OS !== "android" || !native) return false
  try {
    return await native.getBackgroundRestrictedAsync()
  } catch {
    // An install carrying an older copy of the module has no such function,
    // and nothing known is better than a restriction invented.
    return false
  }
}

async function readLowPowerMode(): Promise<boolean> {
  if (native) {
    try {
      return Platform.OS === "android"
        ? await native.isPowerSaveModeAsync()
        : await native.isLowPowerModeAsync()
    } catch {
      // Older copy of the module. expo-battery reads the same switch, one
      // layer further from the OS.
    }
  }
  try {
    return await Battery.isLowPowerModeEnabledAsync()
  } catch {
    return false
  }
}

/**
 * Fires when Low Power Mode or Battery Saver flips, which is the one switch
 * that changes without the app being opened. Returns the way to stop
 * listening.
 */
export function addPowerStateListener(listener: () => void): () => void {
  if (native) {
    const subscription = native.addListener("onPowerStateChange", () => listener())
    return () => subscription.remove()
  }
  const subscription = Battery.addLowPowerModeListener(() => listener())
  return () => subscription.remove()
}

export type Vendor = "xiaomi" | "huawei" | "oppo" | "vivo" | "samsung" | "transsion" | "asus"

/**
 * The makes dontkillmyapp.com ranks as killing background apps by default,
 * grouped by the software they share. Redmi and POCO run MIUI, Honor kept
 * EMUI's app launch manager, realme and OnePlus moved onto ColorOS, iQOO is
 * vivo, and Infinix, Tecno and itel are all Transsion. Build.MANUFACTURER is
 * whatever the vendor typed in, so a match survives case and the legal
 * suffixes some of them carry.
 */
const VENDOR_MARKS: Array<[Vendor, string[]]> = [
  ["xiaomi", ["xiaomi", "redmi", "poco"]],
  ["huawei", ["huawei", "honor"]],
  ["oppo", ["oppo", "realme", "oneplus"]],
  ["vivo", ["vivo", "iqoo"]],
  ["samsung", ["samsung"]],
  ["transsion", ["infinix", "tecno", "itel", "transsion"]],
  ["asus", ["asus"]],
]

export function vendorFor(manufacturer: string | null | undefined): Vendor | null {
  const make = manufacturer?.trim().toLowerCase()
  if (!make) return null
  for (const [vendor, marks] of VENDOR_MARKS) {
    if (marks.some((mark) => make.includes(mark))) return vendor
  }
  return null
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
 * so the user has to be sent to the system dialog. The native module raises
 * it directly, which Play allows for a family safety app; the intent launcher
 * is the same dialog from a build without the module.
 */
export async function requestBatteryExemption(): Promise<void> {
  if (Platform.OS !== "android") return
  if (await requestIgnoreBatteryOptimizations()) return
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
}

async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (!native) return false
  try {
    return await native.requestIgnoreBatteryOptimizationsAsync()
  } catch {
    return false
  }
}

/**
 * The vendor's own autostart or power manager screen, which is where MIUI,
 * EMUI, ColorOS and the rest keep the switch that decides whether Hearth
 * survives the screen going off. Resolves what opened, or null when it was
 * the app's own settings page because nothing better would open.
 */
export async function openVendorPowerManager(): Promise<string | null> {
  if (Platform.OS === "android" && native) {
    try {
      const opened = await native.openVendorPowerManagerAsync()
      if (opened) return opened
    } catch {
      // Older copy of the module, or the fallback failed too.
    }
  }
  await openAppSettings()
  return null
}

/**
 * Battery Saver has its own page on Android. iOS keeps Low Power Mode under
 * Settings > Battery with no supported deep link, so the app's page is as
 * close as it gets.
 */
export async function openBatterySaverSettings(): Promise<void> {
  if (Platform.OS === "android") {
    try {
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.BATTERY_SAVER_SETTINGS)
      return
    } catch {
      // Some OEM builds have no such activity.
    }
  }
  await openAppSettings()
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
