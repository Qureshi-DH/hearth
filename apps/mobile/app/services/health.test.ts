import { Platform } from "react-native"

import { useTrackingStore } from "@/stores/tracking"

import { reportHealth } from "./health"

const mockHealth = jest.fn(async () => ({ ok: true }))
jest.mock("expo-application", () => ({ nativeApplicationVersion: "1.3.0" }))
jest.mock("expo-device", () => ({ osVersion: "17.2" }))
jest.mock("@/services/api", () => ({
  endpoints: { auth: { health: (...args: unknown[]) => mockHealth(...(args as [])) } },
}))
let mockSnapshot = {
  location: "always",
  servicesEnabled: true,
  preciseLocation: true,
  notifications: "granted",
  batteryOptimization: "n/a",
  backgroundRefresh: "available",
  backgroundRestricted: false,
  lowPowerMode: false,
  manufacturer: "apple",
}
/** The listener health.ts installs, so a test can play the OS. */
let mockPowerListener: (() => void) | null = null
jest.mock("@/services/permissions", () => ({
  getPermissionSnapshot: jest.fn(async () => mockSnapshot),
  addPowerStateListener: jest.fn((listener: () => void) => {
    mockPowerListener = listener
    return () => {
      mockPowerListener = null
    }
  }),
}))
let mockAuth: { status: string; serverUrl: string | null; user: object | null } = {
  status: "signed_in",
  serverUrl: "https://hearth.test",
  user: { id: "u1" },
}
jest.mock("@/stores/auth", () => ({
  useAuthStore: { getState: () => mockAuth },
}))
let mockTokens: object | null = { accessToken: "a", refreshToken: "r" }
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: { hydrate: async () => mockTokens },
}))
let mockMotion = "granted"
jest.mock("@/services/location/motion", () => ({
  motionPermission: jest.fn(async () => mockMotion),
}))

const os = Platform.OS

describe("reportHealth", () => {
  beforeEach(() => {
    mockHealth.mockClear()
    require("@/utils/storage").clear()
    mockAuth = { status: "signed_in", serverUrl: "https://hearth.test", user: { id: "u1" } }
    mockTokens = { accessToken: "a", refreshToken: "r" }
    mockMotion = "granted"
    useTrackingStore.getState().setEnabled(true)
    mockSnapshot = {
      location: "always",
      servicesEnabled: true,
      preciseLocation: true,
      notifications: "granted",
      batteryOptimization: "n/a",
      backgroundRefresh: "available",
      backgroundRestricted: false,
      lowPowerMode: false,
      manufacturer: "apple",
    }
  })

  afterEach(() => {
    Platform.OS = os
  })

  it("tells the server once, and again only when something changes", async () => {
    Platform.OS = "ios"
    await reportHealth()
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(1)
    expect(mockHealth).toHaveBeenCalledWith({
      locationPermission: "always",
      locationServices: true,
      preciseLocation: true,
      motionPermission: "granted",
      sharingEnabled: true,
      backgroundRefresh: "available",
      lowPowerMode: false,
      manufacturer: "apple",
      appVersion: "1.3.0",
      osVersion: "17.2",
    })

    mockSnapshot = { ...mockSnapshot, location: "foreground" }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
    expect(mockHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ locationPermission: "foreground" }),
    )
  })

  it("names the vendor, the restriction and Battery Saver on Android", async () => {
    Platform.OS = "android"
    mockSnapshot = {
      ...mockSnapshot,
      batteryOptimization: "optimized",
      backgroundRefresh: "n/a",
      backgroundRestricted: true,
      lowPowerMode: true,
      manufacturer: "xiaomi",
    }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledWith({
      locationPermission: "always",
      locationServices: true,
      preciseLocation: true,
      motionPermission: "granted",
      sharingEnabled: true,
      batteryOptimised: true,
      backgroundRestricted: true,
      lowPowerMode: true,
      manufacturer: "xiaomi",
      appVersion: "1.3.0",
      osVersion: "17.2",
    })
  })

  it("leaves the vendor out when the OS did not say", async () => {
    Platform.OS = "android"
    mockSnapshot = { ...mockSnapshot, backgroundRefresh: "n/a", manufacturer: null as never }
    await reportHealth()
    const [sent] = (mockHealth.mock.calls as unknown as [Record<string, unknown>][])[0]!
    expect(Object.keys(sent)).not.toContain("manufacturer")
  })

  // Low Power Mode is the one switch that changes without the app being
  // opened, and the server only learns of it from us.
  it("sends again the moment the power state changes, and not when it merely fires unchanged", async () => {
    Platform.OS = "ios"
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(1)
    expect(mockPowerListener).not.toBeNull()

    mockSnapshot = { ...mockSnapshot, lowPowerMode: true }
    mockPowerListener!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockHealth).toHaveBeenCalledTimes(2)
    expect(mockHealth).toHaveBeenLastCalledWith(expect.objectContaining({ lowPowerMode: true }))

    mockPowerListener!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockHealth).toHaveBeenCalledTimes(2)
  })

  it("keeps quiet when the server cannot be reached, and tries again next time", async () => {
    mockHealth.mockRejectedValueOnce(new Error("offline"))
    await reportHealth()
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
  })

  // Neither stops the phone reporting, so nothing said so, and the family
  // read rough positions and a phone that never slept as a broken one.
  it("says when precise location, motion access or Share my location is off", async () => {
    Platform.OS = "android"
    mockSnapshot = { ...mockSnapshot, preciseLocation: false, backgroundRefresh: "n/a" }
    mockMotion = "denied"
    useTrackingStore.getState().setEnabled(false)
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        preciseLocation: false,
        motionPermission: "denied",
        sharingEnabled: false,
      }),
    )
  })

  it("leaves motion out where the phone cannot classify it", async () => {
    mockMotion = "unavailable"
    await reportHealth()
    const [sent] = (mockHealth.mock.calls as unknown as [Record<string, unknown>][])[0]!
    expect(Object.keys(sent)).not.toContain("motionPermission")
  })

  // The tracker's own process never derives the session's status, and the
  // report it owes the family is the one nobody opens the app to send.
  it("sends from a process the OS started for the tracker", async () => {
    mockAuth = { status: "booting", serverUrl: "https://hearth.test", user: { id: "u1" } }
    await reportHealth({ background: true })
    expect(mockHealth).toHaveBeenCalledTimes(1)

    mockHealth.mockClear()
    require("@/utils/storage").clear()
    mockTokens = null
    await reportHealth({ background: true })
    mockAuth = { status: "signed_out", serverUrl: "https://hearth.test", user: null }
    await reportHealth({ background: true })
    expect(mockHealth).not.toHaveBeenCalled()
  })

  it("sends from the background once in ten minutes however often it changes", async () => {
    jest.useFakeTimers()
    try {
      await reportHealth({ background: true })
      mockSnapshot = { ...mockSnapshot, servicesEnabled: false }
      await reportHealth({ background: true })
      expect(mockHealth).toHaveBeenCalledTimes(1)

      jest.setSystemTime(Date.now() + 10 * 60_000 + 1)
      await reportHealth({ background: true })
      expect(mockHealth).toHaveBeenCalledTimes(2)
      expect(mockHealth).toHaveBeenLastCalledWith(
        expect.objectContaining({ locationServices: false }),
      )

      // The app opening is somebody looking, and always goes.
      mockSnapshot = { ...mockSnapshot, servicesEnabled: true }
      await reportHealth()
      expect(mockHealth).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })

  it("sends for the account signed in now, though the last one said the same", async () => {
    await reportHealth()
    mockAuth = { ...mockAuth, user: { id: "u2" } }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
  })
})
