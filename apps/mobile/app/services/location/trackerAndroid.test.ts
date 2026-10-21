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
  ingest,
  isDriving,
  keepTrackerAwake,
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

  // A background app with no service and no request gets nothing at all,
  // and that was a refused journey until the next allowed moment.
  it("keeps a request running on the moving options while Android refuses the service", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.refuse = true
    start.mockClear()
    stop.mockClear()
    await enterMoving()
    expect(fake.status).toBe("refused")
    expect(stop).not.toHaveBeenCalled()
    const options = start.mock.calls[
      start.mock.calls.length - 1
    ]![1] as Location.LocationTaskOptions
    expect(options).toMatchObject({ accuracy: Location.Accuracy.Balanced, timeInterval: 30_000 })
    expect(options.foregroundService).toBeUndefined()

    fake.refuse = false
    await reassertService({ exempt: true })
    expect(fake.status).toBe("running")
    expect(stop).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
  })

  it("tells native when sharing goes off", async () => {
    await enterMoving()
    await stopTracking()
    expect(fake.state).toMatchObject({ enabled: false, mode: "off" })
    expect(fake.fence).toBeNull()
  })
})

describe("fixes the service took on its way down", () => {
  it("are not held for the next account once tracking has stopped", async () => {
    await enterMoving()
    fake.fixes = [at(AWAY, Date.now() - 2_000, 9)]
    await stopTracking()
    expect(fake.fixes).toHaveLength(0)
  })

  it("are dropped when they arrive after the stop", async () => {
    await enterMoving()
    await stopTracking()
    mockUpload.mockClear()
    // ACTION_STOP is handled a moment after the call, and a fix lands first.
    fake.fixes = [at(AWAY, Date.now(), 9)]
    await processNativeQueue()
    expect(fake.fixes).toHaveLength(0)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
    expect(mockUpload).not.toHaveBeenCalled()
  })
})

// React Native runs no JavaScript timer while the app is in the background
// and no headless task is open, and fetch hands every response over on one.
// A phone on the move with its screen off sent nothing until a push or the
// sync task opened a task for it, and Live showed one fix and then nothing.
describe("JavaScript held awake while the service runs", () => {
  it("drains what the service buffered on its own while moving", async () => {
    await enterMoving()
    fake.status = "running"
    const held = keepTrackerAwake()
    fake.fixes = [at(AWAY, Date.now(), 9)]
    await jest.advanceTimersByTimeAsync(6_000)
    expect(fake.fixes).toHaveLength(0)
    expect(uploaded().some((fix) => fix.source === "background")).toBe(true)

    await stopTracking()
    await jest.advanceTimersByTimeAsync(6_000)
    await held
  })

  it("lets go once the phone parks with nobody watching, and says so to the native side", async () => {
    await enterMoving()
    const held = keepTrackerAwake()
    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(6_000)
    await held
    expect(fake.releaseAwake).toHaveBeenCalledTimes(1)
  })

  it("stays awake on a parked phone somebody is watching", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    await enterWatched(600)
    let done = false
    void keepTrackerAwake().then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(30_000)
    expect(done).toBe(false)
    await stopTracking()
    await jest.advanceTimersByTimeAsync(6_000)
    expect(done).toBe(true)
  })

  it("is one hold however many tasks ask for it", async () => {
    await enterMoving()
    expect(keepTrackerAwake()).toBe(keepTrackerAwake())
    await stopTracking()
    await jest.advanceTimersByTimeAsync(6_000)
  })

  it("runs as the headless task the service opens for it", async () => {
    await enterMoving()
    let done = false
    void runHeadlessTask({ reason: "awake" }).then(() => {
      done = true
    })
    await jest.advanceTimersByTimeAsync(10_000)
    expect(done).toBe(false)
    await stopTracking()
    await jest.advanceTimersByTimeAsync(6_000)
    expect(done).toBe(true)
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

describe("a phone allowed only approximate location", () => {
  const foreground = Location.getForegroundPermissionsAsync as unknown as jest.Mock
  const precise = async () => ({ status: "granted", canAskAgain: true })

  afterEach(() => {
    foreground.mockImplementation(precise)
    useTrackingStore.getState().setPreciseLocation(true)
  })

  // Play Services will not arm a fence without fine location, and the stop
  // that could not arm one ran the service all day instead.
  it("parks on Android without the fence Play Services refuses it", async () => {
    foreground.mockImplementation(async () => ({
      status: "granted",
      canAskAgain: true,
      android: { accuracy: "coarse" },
    }))
    fake.refuseFence = true
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(fake.status).toBe("none")
    expect(fake.armFence).not.toHaveBeenCalled()
  })

  it("still leaves on a resting fix far enough off for its looseness to clear the fence", async () => {
    foreground.mockImplementation(async () => ({
      status: "granted",
      canAskAgain: true,
      android: { accuracy: "coarse" },
    }))
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    const far = at({ lat: HOME.lat + 4_000 / 111_195, lon: HOME.lon }, Date.now(), null)
    await ingest([{ ...far, coords: { ...far.coords, accuracy: 2_000 } }], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
  })

  it("parks on iOS without the region iOS will not monitor with Precise Location off", async () => {
    Platform.OS = "ios"
    foreground.mockImplementation(async () => ({
      status: "granted",
      canAskAgain: true,
      ios: { scope: "always", accuracy: "reduced" },
    }))
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(startExpoFence).not.toHaveBeenCalled()
  })
})

describe("a loose fix on a parked phone", () => {
  /** Four hundred metres north, with two hundred metres of doubt. */
  const loose = (when: number): Location.LocationObject =>
    ({
      timestamp: when,
      coords: {
        latitude: HOME.lat + 400 / 111_195,
        longitude: HOME.lon,
        altitude: 0,
        accuracy: 200,
        altitudeAccuracy: 5,
        heading: -1,
        speed: null,
      },
    }) as Location.LocationObject
  const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock

  it("is not taken as the phone leaving, and is checked with a sharper one", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockClear()
    await ingest([loose(Date.now())], "background")
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(getPosition).toHaveBeenCalledTimes(1)
  })

  it("ends the stop once the sharper fix agrees", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    mockHere = { ...AWAY }
    await ingest([loose(Date.now())], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
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

  // Three lines a fix rewrote the log three times a second and pushed the
  // night's evidence out of it within minutes.
  it("logs a line every half minute for the window, not three for every fix", async () => {
    await enterMoving()
    await enterWatched(600)
    const window = useTrackingStore.getState().watchedUntil
    mockUpload.mockImplementation(async (batch: LocationFixInput[]) => ({
      ...reply(batch.length),
      watchedUntil: window,
    }))
    clearTrackerLog()
    fake.status = "running"
    for (let i = 1; i <= 60; i += 1) {
      await jest.advanceTimersByTimeAsync(1_000)
      fake.fixes = [at({ lat: AWAY.lat + i * 0.0001, lon: AWAY.lon }, Date.now(), 12)]
      await processNativeQueue()
    }
    expect(uploaded().filter((fix) => fix.source === "background")).toHaveLength(60)
    const names = readTrackerLog().map((entry) => entry.what)
    const tallies = names.filter((name) => name === "live").length
    expect(tallies).toBeGreaterThanOrEqual(1)
    expect(tallies).toBeLessThanOrEqual(2)
    expect(names.filter((name) => name === "fixes" || name === "flush")).toHaveLength(0)
    expect(names.filter((name) => name === "watch adopted")).toHaveLength(0)
    expect(names.length).toBeLessThan(10)
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
