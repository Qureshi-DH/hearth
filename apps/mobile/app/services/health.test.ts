import { Platform } from "react-native"

import { reportHealth } from "./health"

const mockHealth = jest.fn(async () => ({ ok: true }))
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
  serviceStopped: false,
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
jest.mock("@/stores/auth", () => ({
  useAuthStore: { getState: () => ({ status: "signed_in" }) },
}))

const os = Platform.OS

describe("reportHealth", () => {
  beforeEach(() => {
    mockHealth.mockClear()
    require("@/utils/storage").clear()
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
      serviceStopped: false,
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
      backgroundRefresh: "available",
      lowPowerMode: false,
      manufacturer: "apple",
    })

    mockSnapshot = { ...mockSnapshot, location: "foreground" }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
    expect(mockHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ locationPermission: "foreground" }),
    )
  })

  it("names the vendor, the restriction, Battery Saver and a dead service on Android", async () => {
    Platform.OS = "android"
    mockSnapshot = {
      ...mockSnapshot,
      batteryOptimization: "optimized",
      backgroundRefresh: "n/a",
      backgroundRestricted: true,
      lowPowerMode: true,
      manufacturer: "xiaomi",
      serviceStopped: true,
    }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledWith({
      locationPermission: "always",
      locationServices: true,
      batteryOptimised: true,
      backgroundRestricted: true,
      lowPowerMode: true,
      manufacturer: "xiaomi",
      serviceStopped: true,
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
})
