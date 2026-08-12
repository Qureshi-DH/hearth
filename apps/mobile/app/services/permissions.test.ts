import { Linking, Platform } from "react-native"
import * as Battery from "expo-battery"
import * as IntentLauncher from "expo-intent-launcher"

import {
  addPowerStateListener,
  getPermissionSnapshot,
  openVendorPowerManager,
  requestBatteryExemption,
  vendorFor,
} from "./permissions"

/**
 * modules/hearth-motion/index.ts calls requireNativeModule at import time, so
 * the module file itself is what gets replaced, not a native binding under it.
 */
jest.mock("../../modules/hearth-motion", () => ({
  default: {
    getBackgroundRestrictedAsync: jest.fn(async () => false),
    isPowerSaveModeAsync: jest.fn(async () => false),
    isLowPowerModeAsync: jest.fn(async () => false),
    requestIgnoreBatteryOptimizationsAsync: jest.fn(async () => true),
    openVendorPowerManagerAsync: jest.fn(async () => "com.miui.securitycenter/AutoStart"),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    getBackgroundRefreshStatusAsync: jest.fn(async () => "available"),
  },
}))

type NativeMock = Record<
  | "getBackgroundRestrictedAsync"
  | "isPowerSaveModeAsync"
  | "isLowPowerModeAsync"
  | "requestIgnoreBatteryOptimizationsAsync"
  | "openVendorPowerManagerAsync"
  | "addListener"
  | "getBackgroundRefreshStatusAsync",
  jest.Mock
>

const native = (jest.requireMock("../../modules/hearth-motion") as { default: NativeMock }).default

let mockManufacturer: string | null = "Xiaomi"
jest.mock("expo-device", () => ({
  get manufacturer() {
    return mockManufacturer
  },
}))

jest.mock("expo-location", () => ({
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  hasServicesEnabledAsync: jest.fn(async () => true),
}))
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
}))
jest.mock("expo-battery", () => ({
  isBatteryOptimizationEnabledAsync: jest.fn(async () => true),
  isLowPowerModeEnabledAsync: jest.fn(async () => false),
  addLowPowerModeListener: jest.fn(() => ({ remove: jest.fn() })),
}))
jest.mock("expo-intent-launcher", () => ({
  ActivityAction: {
    LOCATION_SOURCE_SETTINGS: "android.settings.LOCATION_SOURCE_SETTINGS",
    BATTERY_SAVER_SETTINGS: "android.settings.BATTERY_SAVER_SETTINGS",
  },
  startActivityAsync: jest.fn(async () => ({ resultCode: 0 })),
}))
let mockServiceStopped = false
jest.mock("@/services/location/tracker", () => ({
  serviceDiedUnexpectedly: () => mockServiceStopped,
}))
jest.mock("@/services/location/motion", () => ({
  backgroundRefreshStatus: jest.fn(async () => "available"),
}))

const os = Platform.OS
function onPlatform(name: "android" | "ios") {
  Platform.OS = name
}

beforeEach(() => {
  jest.clearAllMocks()
  mockManufacturer = "Xiaomi"
  mockServiceStopped = false
  native.getBackgroundRestrictedAsync.mockResolvedValue(false)
  native.isPowerSaveModeAsync.mockResolvedValue(false)
  native.isLowPowerModeAsync.mockResolvedValue(false)
  native.requestIgnoreBatteryOptimizationsAsync.mockResolvedValue(true)
  native.openVendorPowerManagerAsync.mockResolvedValue("com.miui.securitycenter/AutoStart")
  ;(Linking.openSettings as jest.Mock).mockResolvedValue(undefined)
})

afterEach(() => {
  Platform.OS = os
})

describe("vendorFor", () => {
  // Build.MANUFACTURER is whatever the vendor typed into the build, so the
  // match has to survive case and the legal suffixes some of them carry.
  it.each([
    ["Xiaomi", "xiaomi"],
    ["Redmi", "xiaomi"],
    ["POCO", "xiaomi"],
    ["HUAWEI", "huawei"],
    ["HONOR", "huawei"],
    ["OPPO", "oppo"],
    ["realme", "oppo"],
    ["OnePlus", "oppo"],
    ["vivo", "vivo"],
    ["iQOO", "vivo"],
    ["samsung", "samsung"],
    ["INFINIX MOBILITY LIMITED", "transsion"],
    ["TECNO MOBILE LIMITED", "transsion"],
    ["ITEL MOBILE LIMITED", "transsion"],
    ["asus", "asus"],
  ])("reads %s as %s", (manufacturer, vendor) => {
    expect(vendorFor(manufacturer)).toBe(vendor)
  })

  it("has nothing to say about phones that leave apps alone", () => {
    expect(vendorFor("Google")).toBeNull()
    expect(vendorFor("Apple")).toBeNull()
    expect(vendorFor("motorola")).toBeNull()
    expect(vendorFor("")).toBeNull()
    expect(vendorFor(null)).toBeNull()
    expect(vendorFor(undefined)).toBeNull()
  })
})

describe("getPermissionSnapshot", () => {
  it("carries the vendor, the background restriction, Battery Saver and the service on Android", async () => {
    onPlatform("android")
    native.getBackgroundRestrictedAsync.mockResolvedValue(true)
    native.isPowerSaveModeAsync.mockResolvedValue(true)
    mockServiceStopped = true

    const snapshot = await getPermissionSnapshot()

    expect(snapshot.manufacturer).toBe("xiaomi")
    expect(snapshot.backgroundRestricted).toBe(true)
    expect(snapshot.lowPowerMode).toBe(true)
    expect(snapshot.serviceStopped).toBe(true)
    expect(native.isLowPowerModeAsync).not.toHaveBeenCalled()
  })

  it("reads Low Power Mode on iOS and never claims a background restriction there", async () => {
    onPlatform("ios")
    mockManufacturer = "Apple"
    native.isLowPowerModeAsync.mockResolvedValue(true)
    native.getBackgroundRestrictedAsync.mockResolvedValue(true)

    const snapshot = await getPermissionSnapshot()

    expect(snapshot.manufacturer).toBe("apple")
    expect(snapshot.lowPowerMode).toBe(true)
    expect(snapshot.backgroundRestricted).toBe(false)
    expect(snapshot.serviceStopped).toBe(false)
    expect(native.getBackgroundRestrictedAsync).not.toHaveBeenCalled()
  })

  it("falls back to expo-battery for the power mode when the native call is missing", async () => {
    onPlatform("android")
    native.isPowerSaveModeAsync.mockRejectedValue(new TypeError("not a function"))
    ;(Battery.isLowPowerModeEnabledAsync as jest.Mock).mockResolvedValue(true)

    const snapshot = await getPermissionSnapshot()

    expect(snapshot.lowPowerMode).toBe(true)
  })

  it("has no manufacturer when the OS does not say", async () => {
    onPlatform("android")
    mockManufacturer = null

    const snapshot = await getPermissionSnapshot()

    expect(snapshot.manufacturer).toBeNull()
  })
})

describe("requestBatteryExemption", () => {
  it("asks through the native dialog first and stops there when it opened", async () => {
    onPlatform("android")
    await requestBatteryExemption()
    expect(native.requestIgnoreBatteryOptimizationsAsync).toHaveBeenCalledTimes(1)
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled()
  })

  it("falls back to the intent, then to the settings list, when the dialog cannot be launched", async () => {
    onPlatform("android")
    native.requestIgnoreBatteryOptimizationsAsync.mockResolvedValue(false)
    ;(IntentLauncher.startActivityAsync as jest.Mock)
      .mockRejectedValueOnce(new Error("no activity"))
      .mockResolvedValueOnce({ resultCode: 0 })

    await requestBatteryExemption()

    const actions = (IntentLauncher.startActivityAsync as jest.Mock).mock.calls.map(
      ([action]) => action,
    )
    expect(actions).toEqual([
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
    ])
  })

  it("does nothing on iOS", async () => {
    onPlatform("ios")
    await requestBatteryExemption()
    expect(native.requestIgnoreBatteryOptimizationsAsync).not.toHaveBeenCalled()
  })
})

describe("openVendorPowerManager", () => {
  it("returns what the native side opened", async () => {
    onPlatform("android")
    await expect(openVendorPowerManager()).resolves.toBe("com.miui.securitycenter/AutoStart")
    expect(Linking.openSettings).not.toHaveBeenCalled()
  })

  it("opens the app's own settings page when the native side has nothing to offer", async () => {
    onPlatform("android")
    native.openVendorPowerManagerAsync.mockRejectedValue(new TypeError("not a function"))
    await expect(openVendorPowerManager()).resolves.toBeNull()
    expect(Linking.openSettings).toHaveBeenCalledTimes(1)
  })
})

describe("addPowerStateListener", () => {
  it("hears the native power state event and stops hearing it when removed", () => {
    const remove = jest.fn()
    native.addListener.mockReturnValue({ remove })
    const listener = jest.fn()

    const stop = addPowerStateListener(listener)

    expect(native.addListener).toHaveBeenCalledWith("onPowerStateChange", expect.any(Function))
    const [, handler] = native.addListener.mock.calls[0] as [string, () => void]
    handler()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
