import { AppState, Platform } from "react-native"
import type { LocationFixInput } from "@hearth/shared"
import * as Location from "expo-location"

import { useAuthStore } from "@/stores/auth"
import { useTrackingStore } from "@/stores/tracking"

import { clearTrackerLog, readTrackerLog } from "./log"
import {
  BACKGROUND_LOCATION_TASK,
  enterMoving,
  enterStationary,
  enterWatched,
  isDriving,
  processNativeQueue,
  reassertService,
  RESTING_HEARTBEAT_MS,
  runHeadlessTask,
  serviceDiedUnexpectedly,
  stopBackgroundClock,
  stopForegroundHeartbeat,
  stopTracking,
  wakeFix,
} from "./tracker"

/**
 * Android's tracker rides on the native transport in modules/hearth-motion:
 * the OS wakes the receivers there, the foreground service starts inside
 * the moment Android allows it, and the fixes and events land in a queue
 * this side drains. These tests drive that queue the way the module does.
 */

jest.mock("./nativeTracker")
// eslint-disable-next-line import/first
import * as nativeTracker from "./nativeTracker"

/** The manual mock's controls, reached through the module the tracker sees. */
const { fake } = nativeTracker as unknown as typeof import("./__mocks__/nativeTracker")

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => true),
}))

jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 1 },
  getStatusAsync: jest.fn(async () => 1),
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
}))

const HOME = { lat: 51.4545, lon: -2.5879 }
/** A kilometre up the road. */
const AWAY = { lat: 51.4635, lon: -2.5879 }
let mockHere = { ...HOME }
let mockSpeed = 0

jest.mock("expo-location", () => ({
  Accuracy: { Lowest: 1, Balanced: 3, High: 4, Highest: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  hasStartedGeofencingAsync: jest.fn(async () => false),
  startGeofencingAsync: jest.fn(async () => {}),
  stopGeofencingAsync: jest.fn(async () => {}),
  hasStartedLocationUpdatesAsync: jest.fn(async () => true),
  startLocationUpdatesAsync: jest.fn(async () => {}),
  stopLocationUpdatesAsync: jest.fn(async () => {}),
  getLastKnownPositionAsync: jest.fn(async () => null),
  hasServicesEnabledAsync: jest.fn(async () => true),
  getCurrentPositionAsync: jest.fn(async () => ({
    timestamp: Date.now(),
    coords: {
      latitude: mockHere.lat,
      longitude: mockHere.lon,
      altitude: 0,
      accuracy: 20,
      altitudeAccuracy: 5,
      heading: -1,
      speed: mockSpeed,
    },
  })),
}))

jest.mock("./motion", () => ({
  startMotion: jest.fn(async () => ({ remove: jest.fn() })),
  stopMotion: jest.fn(async () => {}),
}))

jest.mock("./driveSensors", () => ({
  startDriveSensors: jest.fn(async () => true),
  stopDriveSensors: jest.fn(),
}))

const mockUpload = jest.fn()
jest.mock("@/services/api", () => ({
  ApiError: jest.requireActual("@/services/api/client").ApiError,
  api: { websocketUrl: () => null, refreshTokens: async () => null },
  endpoints: { locations: { upload: (...args: unknown[]) => mockUpload(...args) } },
}))
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: { hydrate: async () => ({ accessToken: "a", refreshToken: "r" }), peek: () => null },
}))

const start = Location.startLocationUpdatesAsync as unknown as jest.Mock
const stop = Location.stopLocationUpdatesAsync as unknown as jest.Mock
const startExpoFence = Location.startGeofencingAsync as unknown as jest.Mock
const os = Platform.OS

const reply = (accepted: number) => ({
  accepted,
  rejected: 0,
  placeEvents: 0,
  serverTime: new Date().toISOString(),
  policy: { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 },
  watchedUntil: null,
})

const uploaded = (): LocationFixInput[] =>
  mockUpload.mock.calls.flatMap(([batch]) => batch as LocationFixInput[])

const at = (
  point: { lat: number; lon: number },
  when: number,
  speed: number | null = 0,
): Location.LocationObject =>
  ({
    timestamp: when,
    coords: {
      latitude: point.lat,
      longitude: point.lon,
      altitude: 0,
      accuracy: 15,
      altitudeAccuracy: 5,
      heading: -1,
      speed,
    },
  }) as Location.LocationObject

const lastRequest = () => fake.startService.mock.calls[fake.startService.mock.calls.length - 1]![0]

let testIndex = 0

beforeEach(async () => {
  jest.useFakeTimers()
  // Each test starts an hour on from the last, so the two minute limit on
  // confirming fixes never carries over between them.
  testIndex += 1
  jest.setSystemTime(new Date(Date.parse("2026-09-20T10:00:00Z") + testIndex * 60 * 60_000))
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useTrackingStore.getState().setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 })
  useAuthStore.getState().setServer("https://hearth.test", null as never)
  AppState.currentState = "background"
  Platform.OS = "android"
  mockHere = { ...HOME }
  mockSpeed = 0
  jest.clearAllMocks()
  fake.reset()
  mockUpload.mockImplementation(async (batch: LocationFixInput[]) => reply(batch.length))
  clearTrackerLog()
})

afterEach(async () => {
  await stopTracking()
  stopBackgroundClock()
  stopForegroundHeartbeat()
  Platform.OS = os
  AppState.currentState = "active"
  jest.useRealTimers()
})

describe("the tiers on Android", () => {
  it("runs the moving tier under the native service and never through expo's task", async () => {
    await enterMoving()
    expect(lastRequest()).toEqual({ priority: "balanced", intervalMs: 30_000, distanceMeters: 0 })
    expect(start).not.toHaveBeenCalled()
    expect(fake.state).toMatchObject({ enabled: true, mode: "moving" })
  })

  it("parks under expo's resting request with the service stopped and the native fence armed", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(fake.stopService).toHaveBeenCalled()
    expect(fake.status).toBe("none")
    const options = start.mock.calls[
      start.mock.calls.length - 1
    ]![1] as Location.LocationTaskOptions
    expect(options.foregroundService).toBeUndefined()
    expect(options.timeInterval).toBe(RESTING_HEARTBEAT_MS)
    expect(fake.fence).toEqual({ lat: HOME.lat, lon: HOME.lon, radius: expect.any(Number) })
    expect(startExpoFence).not.toHaveBeenCalled()
    expect(fake.state).toMatchObject({ enabled: true, mode: "stationary" })
  })

  it("hands native the request to use for a departure it handles alone", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    expect(fake.state?.movingRequest).toEqual({
      priority: "balanced",
      intervalMs: 30_000,
      distanceMeters: 0,
    })
  })

  it("stops expo's resting request when the service takes over", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    stop.mockClear()
    await enterMoving()
    expect(stop).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
  })

  it("tells native when sharing goes off", async () => {
    await enterMoving()
    await stopTracking()
    expect(fake.state).toMatchObject({ enabled: false, mode: "off" })
    expect(fake.fence).toBeNull()
  })
})

describe("what the OS delivered while JavaScript was down", () => {
  it("takes a fence exit from the queue as the departure and the buffered fixes as the trail", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.startService.mockClear()
    // Native started the service on the exit and buffered the first fixes
    // of the journey before this side was up.
    fake.status = "running"
    fake.events = [{ type: "fence", id: "stationary", transition: "exit", at: Date.now() }]
    fake.fixes = [at(AWAY, Date.now() - 20_000, 8), at(AWAY, Date.now() - 10_000, 9)]
    mockHere = { ...AWAY }
    mockSpeed = 9
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(fake.startService).toHaveBeenCalled()
    expect(fake.fence).toBeNull()
    const sources = uploaded().map((fix) => fix.source)
    expect(sources).toContain("background")
    expect(fake.fixes).toHaveLength(0)
  })

  it("re-parks on a fence exit whose sharp fix is still at home", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.events = [{ type: "fence", id: "stationary", transition: "exit", at: Date.now() }]
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(readTrackerLog().some((entry) => entry.what === "fence exit was false")).toBe(true)
  })

  it("starts the drive on a vehicle transition from the queue", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.status = "running"
    fake.events = [{ type: "transition", activity: "automotive", at: Date.now() }]
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(isDriving()).toBe(true)
    expect(lastRequest().priority).toBe("high")
  })

  it("lets a walk that a fix does not confirm end with the brief service down", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    // Native brought the brief service up for the confirming fix.
    fake.status = "brief"
    fake.events = [{ type: "transition", activity: "walking", at: Date.now() }]
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(fake.stopBrief).toHaveBeenCalled()
    expect(fake.startService).not.toHaveBeenCalled()
  })

  it("brings the full tier in over the brief service once a walk is confirmed", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.status = "brief"
    fake.events = [{ type: "transition", activity: "walking", at: Date.now() }]
    mockHere = { ...AWAY }
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(fake.startService).toHaveBeenCalled()
    expect(fake.status).toBe("running")
  })

  it("ingests buffered fixes from a moving phone in order and judges the stop from them", async () => {
    await enterMoving()
    fake.status = "running"
    const t = Date.now()
    fake.fixes = [at(AWAY, t - 3000, 2), at(AWAY, t - 2000, 2), at(AWAY, t - 1000, 2)]
    await processNativeQueue()
    const times = uploaded().map((fix) => Date.parse(fix.recordedAt))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(useTrackingStore.getState().stillAnchor).toMatchObject({ lat: AWAY.lat })
  })

  it("runs the queue when native pokes, and the same code as the headless task", async () => {
    await enterMoving()
    fake.status = "running"
    fake.fixes = [at(AWAY, Date.now(), 3)]
    fake.poke()
    await jest.advanceTimersByTimeAsync(10)
    expect(fake.fixes).toHaveLength(0)
    expect(uploaded()).toHaveLength(1)

    fake.fixes = [at(AWAY, Date.now() + 5000, 3)]
    await runHeadlessTask({ reason: "test" })
    expect(fake.fixes).toHaveLength(0)
  })

  it("notes a service Android refused, and re-asserts it at the next allowed moment", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.refuse = true
    fake.events = [{ type: "fence", id: "stationary", transition: "exit", at: Date.now() }]
    mockHere = { ...AWAY }
    await processNativeQueue()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(useTrackingStore.getState().serviceRefusedAt).not.toBeNull()
    // The fence stays for the refusal, since its exit is a moment that allows the start.
    expect(fake.fence).not.toBeNull()

    fake.refuse = false
    fake.startService.mockClear()
    fake.events = [{ type: "transition", activity: "walking", at: Date.now() }]
    await processNativeQueue()
    expect(fake.startService).toHaveBeenCalled()
    expect(useTrackingStore.getState().serviceRefusedAt).toBeNull()
    expect(fake.fence).toBeNull()
  })

  it("upgrades a brief service found under a moving phone without calling it dead", async () => {
    await enterMoving()
    fake.status = "brief"
    fake.startService.mockClear()
    await reassertService()
    expect(fake.startService).toHaveBeenCalled()
    expect(serviceDiedUnexpectedly()).toBe(false)
  })

  it("remembers a service that went away under a moving phone", async () => {
    await enterMoving()
    fake.status = "none"
    await reassertService()
    expect(serviceDiedUnexpectedly()).toBe(true)
  })
})

describe("live, while somebody is watching", () => {
  it("asks for a fix every second and uploads every one of them, moving or not", async () => {
    await enterMoving()
    await enterWatched(600)
    expect(lastRequest()).toEqual({ priority: "high", intervalMs: 1_000, distanceMeters: 0 })
    mockUpload.mockClear()
    // The ask's own fix went up; now the tier's, a second apart, from one spot.
    const t = Date.now()
    fake.fixes = [at(AWAY, t + 1000, 0), at(AWAY, t + 2000, 0), at(AWAY, t + 3000, 0)]
    fake.status = "running"
    await processNativeQueue()
    expect(uploaded().filter((fix) => fix.source === "background")).toHaveLength(3)
  })
})

describe("a wake on a parked Android phone", () => {
  it("takes one fix under the brief service and leaves the resting request alone", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    await wakeFix()
    expect(fake.stopBrief).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(uploaded().map((fix) => fix.source)).toContain("nudge")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })
})
