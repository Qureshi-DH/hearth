import { AppState, Platform } from "react-native"
import type { LocationFixInput } from "@hearth/shared"
import * as Location from "expo-location"

import { ApiError } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { usePlacesStore } from "@/stores/places"
import { useTrackingStore } from "@/stores/tracking"

import { clearTrackerLog, formatTrackerLog, logTracker, readTrackerLog } from "./log"
import {
  BACKGROUND_LOCATION_TASK,
  BACKGROUND_SYNC_TASK,
  enterDriving,
  enterMoving,
  enterStationary,
  enterWatched,
  refreshLocationStatus,
  flush,
  headerForTrackerLog,
  ingest,
  isDriving,
  reassertService,
  reportNow,
  RESTING_HEARTBEAT_MS,
  serviceDiedUnexpectedly,
  startForegroundHeartbeat,
  startTracking,
  stopBackgroundClock,
  stopForegroundHeartbeat,
  stopTracking,
  toFix,
  wakeFix,
} from "./tracker"

/**
 * MMKV outlives the process, and the relaunch tests read back what a fresh
 * runtime finds there. The library's own mock hands out a new Map per
 * instance, so this one hangs off the global.
 */
interface TestDisk {
  __hearthDisk: Map<string, string>
}

jest.mock("react-native-mmkv", () => {
  const shared = globalThis as unknown as TestDisk
  shared.__hearthDisk ??= new Map<string, string>()
  const disk = shared.__hearthDisk
  return {
    MMKV: class {
      getString(key: string) {
        return disk.get(key)
      }
      set(key: string, value: string) {
        disk.set(key, String(value))
      }
      delete(key: string) {
        disk.delete(key)
      }
      contains(key: string) {
        return disk.has(key)
      }
      getAllKeys() {
        return Array.from(disk.keys())
      }
      clearAll() {
        disk.clear()
      }
    },
  }
})

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => true),
}))
// eslint-disable-next-line import/first
import * as TaskManager from "expo-task-manager"

type TaskBody = (body: { data: unknown; error: { message: string } | null }) => Promise<unknown>
const taskBodies = new Map(
  (TaskManager.defineTask as unknown as jest.Mock<void, [string, TaskBody]>).mock.calls,
)

jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 1 },
  getStatusAsync: jest.fn(async () => 1),
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
}))

const HOME = { lat: 51.4545, lon: -2.5879 }
let mockHere = { ...HOME }
let mockSpeed = 0
let mockAccuracy = 20

const mockPositionNow = async () => ({
  timestamp: Date.now(),
  coords: {
    latitude: mockHere.lat,
    longitude: mockHere.lon,
    altitude: 0,
    accuracy: mockAccuracy,
    altitudeAccuracy: 5,
    heading: -1,
    speed: mockSpeed,
  },
})

jest.mock("expo-location", () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  hasStartedGeofencingAsync: jest.fn(async () => true),
  startGeofencingAsync: jest.fn(async () => {}),
  stopGeofencingAsync: jest.fn(async () => {}),
  hasStartedLocationUpdatesAsync: jest.fn(async () => true),
  startLocationUpdatesAsync: jest.fn(async () => {}),
  stopLocationUpdatesAsync: jest.fn(async () => {}),
  getLastKnownPositionAsync: jest.fn(async () => null),
  hasServicesEnabledAsync: jest.fn(async () => true),
  getCurrentPositionAsync: jest.fn(mockPositionNow),
}))

jest.mock("./motion", () => ({
  startMotion: jest.fn(async () => ({ remove: jest.fn() })),
  stopMotion: jest.fn(async () => {}),
}))
// eslint-disable-next-line import/first
import { startMotion } from "./motion"

const mockControlWanted = jest.fn()
jest.mock("./control", () => ({
  // The tracker syncs the channel at import, before this file's consts exist.
  control: { setWanted: (wanted: boolean) => mockControlWanted?.(wanted), refresh: jest.fn() },
  // The first tracker instance to load hands over its handler and keeps
  // the slot: the relaunch tests load fresh instances with their own stores,
  // and the test below drives the one this file imported.
  setControlHandler: (handler: { watch(s: number): Promise<void>; wake(): Promise<void> }) => {
    const slot = globalThis as { __hearthControlHandler?: typeof handler }
    slot.__hearthControlHandler ??= handler
  },
}))

jest.mock("./driveSensors", () => ({
  startDriveSensors: jest.fn(async () => true),
  stopDriveSensors: jest.fn(),
}))

let mockServiceStatus: string | undefined = "running"
jest.mock("expo-modules-core", () => ({
  ...jest.requireActual("expo-modules-core"),
  requireOptionalNativeModule: () => ({
    getForegroundServiceStatusAsync: async () => mockServiceStatus,
  }),
}))

const mockUpload = jest.fn()
jest.mock("@/services/api", () => ({
  ApiError: jest.requireActual("@/services/api/client").ApiError,
  endpoints: { locations: { upload: (...args: unknown[]) => mockUpload(...args) } },
}))
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: { hydrate: async () => ({ accessToken: "a", refreshToken: "r" }), peek: () => null },
}))

const start = Location.startLocationUpdatesAsync as unknown as jest.Mock
const stop = Location.stopLocationUpdatesAsync as unknown as jest.Mock
const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock
const lastKnown = Location.getLastKnownPositionAsync as unknown as jest.Mock
const os = Platform.OS
const optionsOf = (call: number) => start.mock.calls[call]![1] as Location.LocationTaskOptions
const lastOptions = () => optionsOf(start.mock.calls.length - 1)

const reply = (accepted: number, watchedUntil: string | null = null) => ({
  accepted,
  rejected: 0,
  placeEvents: 0,
  serverTime: new Date().toISOString(),
  policy: { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 },
  watchedUntil,
})

/** Every fix the server has been sent so far, oldest first. */
const uploaded = (): LocationFixInput[] =>
  mockUpload.mock.calls.flatMap(([batch]) => batch as LocationFixInput[])

const at = (
  lat: number,
  lon: number,
  when: number,
  speed: number | null = 0,
  accuracy = 20,
): Location.LocationObject =>
  ({
    timestamp: when,
    coords: {
      latitude: lat,
      longitude: lon,
      altitude: 0,
      accuracy,
      altitudeAccuracy: 5,
      heading: -1,
      speed,
    },
  }) as Location.LocationObject

/** The verdict callback the tracker handed to the classifier. */
function classifier(): (
  activity: string,
  confidence: number,
  source?: "sample" | "transition",
) => void {
  const calls = (startMotion as jest.Mock).mock.calls
  return calls[calls.length - 1]![0]
}

beforeEach(async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date("2026-09-17T10:00:00Z"))
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useTrackingStore.getState().setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 })
  useAuthStore.getState().setServer("https://hearth.test", null as never)
  AppState.currentState = "background"
  Platform.OS = "android"
  mockHere = { ...HOME }
  mockSpeed = 0
  mockAccuracy = 20
  mockServiceStatus = "running"
  jest.clearAllMocks()
  // clearAllMocks keeps implementations, and a test that leaves a fix
  // hanging must not hang the ones after it.
  getPosition.mockImplementation(mockPositionNow)
  lastKnown.mockImplementation(async () => null)
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

describe("the Android foreground service", () => {
  it("runs while moving and goes with the stop, so no notification stays", async () => {
    await enterMoving()
    expect(lastOptions().foregroundService).toEqual({
      notificationTitle: "Hearth",
      notificationBody: "Updating your location",
      killServiceOnDestroy: false,
    })
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(lastOptions().foregroundService).toBeUndefined()
    expect(lastOptions().accuracy).toBe(Location.Accuracy.Balanced)
    expect(lastOptions().timeInterval).toBe(RESTING_HEARTBEAT_MS)
  })

  it("answers a wake on a parked phone with one fix under a service that goes with it", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    getPosition.mockClear()
    await wakeFix()
    expect(getPosition).toHaveBeenCalledTimes(1)
    // Up for the fix, down with it: the notification shows for the second
    // the fix takes, which is the one the family accepts.
    const registrations = start.mock.calls as [string, Location.LocationTaskOptions][]
    expect(registrations.length).toBe(2)
    expect(registrations[0]![1].foregroundService).toBeDefined()
    expect(registrations[1]![1].foregroundService).toBeUndefined()
    expect(uploaded().map((fix) => fix.source)).toContain("nudge")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("leaves a parked phone alone, since it wants no service", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    mockServiceStatus = "refused"
    start.mockClear()
    await reassertService()
    expect(start).not.toHaveBeenCalled()
  })

  it("tries once per ten minutes on deliveries while refused, since a re-register re-delivers", async () => {
    await enterMoving()
    mockServiceStatus = "refused"
    clearTrackerLog()
    const deliver = () =>
      taskBodies.get(BACKGROUND_LOCATION_TASK)!({
        data: { locations: [at(HOME.lat, HOME.lon, Date.now())] },
        error: null,
      })
    const reasserts = () => readTrackerLog().filter((entry) => entry.what === "reassert").length
    await deliver()
    expect(reasserts()).toBe(1)
    // A fresh request hands back the fix it already had, which is another
    // delivery. Trying again on it would spin until Android relented.
    await deliver()
    await deliver()
    expect(reasserts()).toBe(1)
    // Ten minutes on and a kilometre away, so the phone is still on the
    // move rather than parking, which would take the service question
    // with it.
    jest.setSystemTime(Date.now() + 10 * 60_000 + 1)
    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat + 0.01, HOME.lon, Date.now())] },
      error: null,
    })
    expect(reasserts()).toBe(2)
    mockServiceStatus = "running"
    await deliver()
    expect(reasserts()).toBe(2)
  })

  it("tries at once on a transition even inside the backoff, since Android allows that start", async () => {
    await startTracking()
    await enterMoving()
    mockServiceStatus = "refused"
    start.mockClear()
    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat, HOME.lon, Date.now())] },
      error: null,
    })
    expect(start).toHaveBeenCalledTimes(1)
    classifier()("walking", 90, "transition")
    await jest.advanceTimersByTimeAsync(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it("tries again on an activity transition, which is a moment Android allows the start", async () => {
    await startTracking()
    await enterMoving()
    mockServiceStatus = "refused"
    start.mockClear()
    classifier()("walking", 90, "transition")
    await jest.advanceTimersByTimeAsync(0)
    expect(start).toHaveBeenCalled()
  })

  it("tries again from the sync task", async () => {
    await enterMoving()
    mockServiceStatus = "refused"
    start.mockClear()
    await taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })
    expect(start).toHaveBeenCalled()
  })

  it("does not read a parked phone's missing service as a death", async () => {
    await enterMoving()
    mockServiceStatus = "none"
    await enterStationary(HOME.lat, HOME.lon)
    expect(serviceDiedUnexpectedly()).toBe(false)
    // Nor a wake's brief service going down with its fix.
    await wakeFix()
    expect(serviceDiedUnexpectedly()).toBe(false)
  })

  it("forgets a death once the phone parks, since a parked phone wants no service", async () => {
    await enterMoving()
    mockServiceStatus = "none"
    await reassertService()
    expect(serviceDiedUnexpectedly()).toBe(true)
    await enterStationary(HOME.lat, HOME.lon)
    expect(serviceDiedUnexpectedly()).toBe(false)
  })

  it("remembers a service that died without being asked, for the health report", async () => {
    await enterMoving()
    expect(serviceDiedUnexpectedly()).toBe(false)
    mockServiceStatus = "none"
    start.mockClear()
    await reassertService()
    expect(serviceDiedUnexpectedly()).toBe(true)
    expect(useTrackingStore.getState().serviceStoppedAt).not.toBeNull()
    // And it is brought back.
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("leaves alone a build that cannot say whether the service is up", async () => {
    await enterMoving()
    mockServiceStatus = undefined
    start.mockClear()
    await reassertService()
    expect(start).not.toHaveBeenCalled()
    expect(serviceDiedUnexpectedly()).toBe(false)
  })
})

describe("a stop the phone cannot arm", () => {
  it("is not tried again on the next delivery when the fence cannot be set", async () => {
    await enterMoving()
    const fence = Location.startGeofencingAsync as unknown as jest.Mock
    fence.mockRejectedValueOnce(new Error("background location not granted"))
    const before = Date.now()
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("moving")
    // The anchor is re-dated, so the phone has to sit still for the full
    // window again before it tries to park, rather than on the next fix.
    const anchor = useTrackingStore.getState().stillAnchor
    expect(anchor).not.toBeNull()
    expect(Date.parse(anchor!.since)).toBeGreaterThanOrEqual(before)
    fence.mockClear()
    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat, HOME.lon, Date.now())] },
      error: null,
    })
    expect(fence).not.toHaveBeenCalled()
  })

  it("stops the background tiers when the permission drops to while-using", async () => {
    await enterMoving()
    ;(Location.getBackgroundPermissionsAsync as unknown as jest.Mock).mockResolvedValueOnce({
      status: "denied",
    })
    await refreshLocationStatus()
    expect(useTrackingStore.getState().mode).toBe("off")
  })
})

describe("the park fix", () => {
  it("leaves as 'still' from the moving registration before the request steps down", async () => {
    await enterMoving()
    start.mockClear()
    getPosition.mockClear()
    await enterStationary(HOME.lat, HOME.lon)
    // The fix was asked for before the parked registration reached the OS.
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(getPosition.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
    // And it had been uploaded, stamped still, before that registration too.
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
    const park = uploaded().find((fix) => fix.source === "significant")
    expect(park?.activity).toBe("still")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("is made up from the anchor when the OS never answers, so the word still always leaves", async () => {
    await enterMoving()
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    start.mockClear()
    const parked = enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    await parked
    const park = uploaded().find((fix) => fix.source === "significant")
    expect(park).toMatchObject({
      lat: HOME.lat,
      lon: HOME.lon,
      activity: "still",
      accuracyMeters: null,
    })
    expect(Date.now() - Date.parse(park!.recordedAt)).toBeLessThan(1_000)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(lastOptions().timeInterval).toBe(RESTING_HEARTBEAT_MS)
  })

  it("parks once when the stop is called again while the fix is on its way", async () => {
    await enterMoving()
    let release: ((value: Location.LocationObject) => void) | null = null
    getPosition.mockImplementationOnce(
      () => new Promise<Location.LocationObject>((resolve) => (release = resolve)),
    )
    const first = enterStationary(HOME.lat, HOME.lon)
    const second = enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    ;(release as unknown as (value: Location.LocationObject) => void)(
      at(HOME.lat, HOME.lon, Date.now()),
    )
    await Promise.all([first, second])
    expect(Location.startGeofencingAsync).toHaveBeenCalledTimes(1)
    expect(uploaded().filter((fix) => fix.activity === "still")).toHaveLength(1)
  })

  it("does the same on iOS, where the session used to be torn down first", async () => {
    Platform.OS = "ios"
    await enterMoving()
    start.mockClear()
    getPosition.mockClear()
    await enterStationary(HOME.lat, HOME.lon)
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
    expect(uploaded().find((fix) => fix.source === "significant")?.activity).toBe("still")
  })
})

describe("a parked iPhone", () => {
  beforeEach(() => {
    Platform.OS = "ios"
  })

  it("keeps a cell-only session with no distance filter, the shape iOS does not suspend", async () => {
    await enterMoving()
    start.mockClear()
    await enterStationary(HOME.lat, HOME.lon)
    expect(stop).not.toHaveBeenCalled()
    expect(lastOptions()).toMatchObject({
      accuracy: Location.Accuracy.Lowest,
      distanceInterval: 0,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Other,
      showsBackgroundLocationIndicator: false,
    })
    expect(Location.startGeofencingAsync).toHaveBeenCalled()
  })

  it("goes live at full accuracy when watched while parked, never a filtered low one", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    await enterWatched(600)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.High)
  })

  it("says it is still there every quarter hour from the fix the OS already has", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    mockUpload.mockClear()
    getPosition.mockClear()
    lastKnown.mockResolvedValue(at(HOME.lat + 0.0001, HOME.lon, Date.now() - 10 * 60_000, 0, 65))
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    const beat = uploaded().find((fix) => fix.source === "heartbeat")
    expect(beat).toMatchObject({ activity: "still", accuracyMeters: 65 })
    // It says "here, now", which is what a phone that has not left the fence means.
    expect(Date.now() - Date.parse(beat!.recordedAt)).toBeLessThan(1_000)
    expect(getPosition).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("stationary")

    // And again a quarter hour later.
    mockUpload.mockClear()
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    expect(uploaded().some((fix) => fix.source === "heartbeat")).toBe(true)
  })

  it("takes the last known fix's word for a departure the fence missed", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    lastKnown.mockResolvedValue(at(HOME.lat + 0.01, HOME.lon, Date.now(), 0, 20))
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(lastOptions().accuracy).toBe(Location.Accuracy.High)
  })

  it("runs the moving tier on GPS with the circle's filter, since a low accuracy session gets suspended", async () => {
    await enterMoving()
    expect(lastOptions()).toMatchObject({
      accuracy: Location.Accuracy.High,
      distanceInterval: 60,
      pausesUpdatesAutomatically: false,
    })
  })

  it("asks for one fix the moment it is watched, and ends the window by the clock", async () => {
    await enterMoving()
    getPosition.mockClear()
    start.mockClear()
    await enterWatched(600)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.High)
    expect(lastOptions().timeInterval).toBe(5_000)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(uploaded().some((fix) => fix.source === "nudge")).toBe(true)

    // No fix comes for the rest of the window: the phone parks meanwhile,
    // and the window's end still steps the request down to the parked one.
    start.mockClear()
    await jest.advanceTimersByTimeAsync(601_000 + 1_000)
    expect(useTrackingStore.getState().watchedUntil).toBeNull()
    expect(start).toHaveBeenCalled()
    expect(lastOptions().timeInterval).not.toBe(5_000)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.Lowest)
  })
})

describe("one-shot fixes", () => {
  it("give up after the deadline and do not wedge the foreground heartbeat", async () => {
    await enterMoving()
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    const late = reportNow("manual")
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(await late).toBeNull()
    expect(useTrackingStore.getState().lastError).toMatch(/timed out/)

    // The app comes to the front with a stale row: the heartbeat must ask.
    AppState.currentState = "active"
    useTrackingStore.getState().setPermission("always")
    useTrackingStore.setState({ lastFix: null })
    getPosition.mockClear()
    startForegroundHeartbeat()
    await jest.advanceTimersByTimeAsync(0)
    expect(getPosition).toHaveBeenCalledTimes(1)
  })

  it("fall back to the fix the OS already has when a fresh one is late", async () => {
    await enterMoving()
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    lastKnown.mockResolvedValueOnce(at(HOME.lat, HOME.lon, Date.now() - 60_000, 0, 30))
    const wake = wakeFix()
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    const fix = await wake
    expect(fix?.source).toBe("nudge")
    expect(lastKnown).toHaveBeenCalledWith({ maxAge: 2 * 60_000 })
  })

  it("are bounded inside the sync task, which iOS gives half a minute", async () => {
    await enterMoving()
    getPosition.mockImplementation(() => new Promise(() => {}))
    const run = taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })
    await jest.advanceTimersByTimeAsync(15_000 + 10)
    await jest.advanceTimersByTimeAsync(15_000 + 10)
    expect(await run).toBe(1)
  })

  it("read a parked phone's clock fix on iOS with a deadline too", async () => {
    Platform.OS = "ios"
    await enterMoving()
    await ingest([at(HOME.lat, HOME.lon, Date.now())], "background")
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    getPosition.mockClear()
    // Five minutes of silence asks for the clock's fix; it never comes, and
    // the clock is armed again rather than dead for the rest of the process.
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(getPosition).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(30_000 + 5 * 60_000 + 10)
    // The second clock fix, and the park fix the stop it settles asks for.
    expect(getPosition.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })
})

describe("what survives a relaunch", () => {
  function relaunch() {
    const launched: { tracker: typeof import("./tracker"); log: typeof import("./log") }[] = []
    jest.isolateModules(() => {
      launched.push({ tracker: require("./tracker"), log: require("./log") })
    })
    return launched[0]!
  }

  it("keeps the drive, so a headless delivery does not start it over", async () => {
    await enterMoving()
    await enterDriving(30)
    expect(useTrackingStore.getState().driving).toEqual({ distance: 300, slowSince: null })
    ;(startMotion as jest.Mock).mockClear()
    const fresh = relaunch()
    expect(fresh.tracker.isDriving()).toBe(true)
    // A process the OS started for a fix runs the classifier from the start.
    expect(startMotion).toHaveBeenCalled()
  })

  it("keeps the classifier's last word and its still streak", async () => {
    await startTracking()
    await enterMoving()
    classifier()("walking", 90)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().lastVerdict).toBe("walking")
    classifier()("still", 90)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().motionStillSince).toBe(Date.now())
  })

  it("opens the control channel at boot when the phone is on the move", () => {
    Platform.OS = "android"
    useTrackingStore.setState({ enabled: true, mode: "moving" })
    mockControlWanted.mockClear()
    relaunch()
    expect(mockControlWanted).toHaveBeenLastCalledWith(true)
  })

  it("opens the control channel at boot on a parked iPhone, whose session keeps it alive", () => {
    Platform.OS = "ios"
    useTrackingStore.setState({ enabled: true, mode: "stationary" })
    mockControlWanted.mockClear()
    relaunch()
    expect(mockControlWanted).toHaveBeenLastCalledWith(true)
  })

  it("logs a boot line saying whether the process is headless", () => {
    ;(startMotion as jest.Mock).mockClear()
    const fresh = relaunch()
    const boot = fresh.log
      .readTrackerLog()
      .filter((entry) => entry.what === "boot")
      .at(-1)
    expect(boot?.detail).toMatchObject({ headless: true, mode: "off" })
  })

  it("does not run the classifier for a phone whose sharing is off", () => {
    useTrackingStore.getState().setMode("off")
    ;(startMotion as jest.Mock).mockClear()
    relaunch()
    expect(startMotion).not.toHaveBeenCalled()
  })
})

describe("speed on Android", () => {
  const battery = { batteryLevel: null, isCharging: null }

  it("reads zero on a network fix as unmeasured, and zero on a GPS fix as a stop", () => {
    expect(
      toFix(at(HOME.lat, HOME.lon, Date.now(), 0, 65), "background", battery).speedMps,
    ).toBeNull()
    expect(toFix(at(HOME.lat, HOME.lon, Date.now(), 0, 20), "background", battery).speedMps).toBe(0)
    expect(toFix(at(HOME.lat, HOME.lon, Date.now(), 4, 65), "background", battery).speedMps).toBe(4)
  })

  it("leaves iOS alone, which says -1 for a speed it did not measure", () => {
    Platform.OS = "ios"
    expect(toFix(at(HOME.lat, HOME.lon, Date.now(), 0, 65), "background", battery).speedMps).toBe(0)
    expect(
      toFix(at(HOME.lat, HOME.lon, Date.now(), -1, 65), "background", battery).speedMps,
    ).toBeNull()
  })

  it("lets a run of network fixes under a flyover derive a speed rather than end the drive", async () => {
    await enterMoving()
    await enterDriving(15)
    const t0 = Date.now()
    await ingest([at(HOME.lat, HOME.lon, t0, 15, 10)], "background")
    // Four minutes of Wi-Fi fixes at speed "0", 200 m apart.
    for (let i = 1; i <= 8; i += 1) {
      await ingest([at(HOME.lat + i * 0.0018, HOME.lon, t0 + i * 30_000, 0, 60)], "background")
    }
    expect(isDriving()).toBe(true)
  })
})

describe("a traffic stop", () => {
  beforeEach(async () => {
    await startTracking()
    await enterMoving()
    getPosition.mockClear()
    start.mockClear()
    ;(Location.startGeofencingAsync as unknown as jest.Mock).mockClear()
  })

  it("does not park a phone that travelled in the last ten minutes on the classifier's word alone", async () => {
    const t0 = Date.now()
    // Half a kilometre in two minutes, then held at the lights.
    await ingest([at(HOME.lat, HOME.lon, t0, 8, 10)], "background")
    await ingest([at(HOME.lat + 0.0045, HOME.lon, t0 + 60_000, 8, 10)], "background")
    jest.setSystemTime(t0 + 2 * 60_000)
    await ingest([at(HOME.lat + 0.0045, HOME.lon, t0 + 2 * 60_000, 0, 10)], "background")
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(100_000)
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(Location.startGeofencingAsync).not.toHaveBeenCalled()
  })

  it("nor one that was doing walking pace or better three minutes ago", async () => {
    const t0 = Date.now()
    await ingest([at(HOME.lat, HOME.lon, t0, 4, 10)], "background")
    jest.setSystemTime(t0 + 60_000)
    await ingest([at(HOME.lat, HOME.lon, t0 + 60_000, 0, 10)], "background")
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(100_000)
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
  })

  it("parks once the position evidence agrees: five minutes with nothing clear of the anchor", async () => {
    const t0 = Date.now()
    await ingest([at(HOME.lat, HOME.lon, t0, 8, 10)], "background")
    await ingest([at(HOME.lat + 0.0045, HOME.lon, t0 + 60_000, 8, 10)], "background")
    for (let minute = 2; minute <= 7; minute += 1) {
      jest.setSystemTime(t0 + minute * 60_000)
      await ingest([at(HOME.lat + 0.0045, HOME.lon, t0 + minute * 60_000, 0, 10)], "background")
      if (useTrackingStore.getState().mode !== "moving") break
      classifier()("still", 100)
      await jest.advanceTimersByTimeAsync(0)
    }
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("still parks a phone that has not gone anywhere after ninety seconds of still", async () => {
    await ingest([at(HOME.lat, HOME.lon, Date.now(), 0, 10)], "background")
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(100_000)
    classifier()("still", 100)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })
})

describe("the control channel", () => {
  const lastWanted = () =>
    mockControlWanted.mock.calls[mockControlWanted.mock.calls.length - 1]?.[0]

  it("is open while an Android phone is on the move and closed while it is parked", async () => {
    Platform.OS = "android"
    await enterMoving()
    expect(lastWanted()).toBe(true)
    await enterStationary(HOME.lat, HOME.lon)
    expect(lastWanted()).toBe(false)
    await enterMoving()
    expect(lastWanted()).toBe(true)
    await stopTracking()
    expect(lastWanted()).toBe(false)
  })

  it("is open in every tier on iOS, whose parked session keeps the app alive", async () => {
    Platform.OS = "ios"
    await enterMoving()
    expect(lastWanted()).toBe(true)
    await enterStationary(HOME.lat, HOME.lon)
    expect(lastWanted()).toBe(true)
    await stopTracking()
    expect(lastWanted()).toBe(false)
  })

  it("answers a watch and a wake that arrive over it", async () => {
    const handler = (
      globalThis as {
        __hearthControlHandler?: { watch(s: number): Promise<void>; wake(): Promise<void> }
      }
    ).__hearthControlHandler!
    expect(handler).toBeDefined()
    await enterMoving()
    // An earlier test may have left a one-shot fix hanging; its deadline is
    // in module state and the clock here restarts from the same instant.
    await jest.advanceTimersByTimeAsync(31_000)
    getPosition.mockClear()
    await handler.wake()
    expect(getPosition).toHaveBeenCalledTimes(1)
    await handler.watch(600)
    expect(useTrackingStore.getState().watchedUntil).not.toBeNull()
  })
})

describe("crossing a place", () => {
  it("uploads the crossing fix at once, whatever the distance gate says", async () => {
    Platform.OS = "android"
    usePlacesStore
      .getState()
      .setPlaces("c1", [{ id: "home", lat: HOME.lat, lon: HOME.lon, radiusMeters: 100 }])
    await enterMoving()
    await enterDriving(20)
    mockUpload.mockClear()
    // Last kept fix 190 m out, next one 55 m out, inside the circle: a
    // 135 m step, under the 200 m driving gate at this speed.
    const t0 = Date.now()
    await ingest([at(HOME.lat + 0.0017, HOME.lon, t0, 20)], "background")
    mockUpload.mockClear()
    await ingest([at(HOME.lat + 0.0005, HOME.lon, t0 + 10_000, 4)], "background")
    expect(uploaded()).toHaveLength(1)
    expect(uploaded()[0]!.lat).toBeCloseTo(HOME.lat + 0.0005, 5)
  })

  it("leaves a step of the same length alone away from any place", async () => {
    Platform.OS = "android"
    usePlacesStore
      .getState()
      .setPlaces("c1", [{ id: "home", lat: HOME.lat, lon: HOME.lon, radiusMeters: 100 }])
    await enterMoving()
    await enterDriving(20)
    const t0 = Date.now()
    await ingest([at(HOME.lat + 0.02, HOME.lon, t0, 20)], "background")
    mockUpload.mockClear()
    await ingest([at(HOME.lat + 0.02 + 0.0012, HOME.lon, t0 + 10_000, 20)], "background")
    expect(uploaded()).toHaveLength(0)
  })
})

describe("being watched", () => {
  it("answers a watch on a parked phone with one fix and stays parked, so no notification stays", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    getPosition.mockClear()
    mockUpload.mockClear()
    await enterWatched(600)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(uploaded()).toHaveLength(1)
    expect(lastOptions().foregroundService).toBeUndefined()
    expect(lastOptions().timeInterval).toBe(RESTING_HEARTBEAT_MS)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    // The window is held, so a departure inside it goes straight to live.
    expect(useTrackingStore.getState().watchedUntil).not.toBeNull()
    start.mockClear()
    await enterMoving()
    expect(lastOptions()).toMatchObject({ accuracy: Location.Accuracy.High, timeInterval: 5_000 })
  })

  it("does so from the upload reply as well as the push", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockClear()
    mockUpload.mockResolvedValueOnce(reply(1, new Date(Date.now() + 600_000).toISOString()))
    useTrackingStore
      .getState()
      .enqueue([
        { ...HOME, recordedAt: new Date().toISOString(), accuracyMeters: 10, source: "background" },
      ])
    await flush()
    await jest.advanceTimersByTimeAsync(0)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(lastOptions().foregroundService).toBeUndefined()
    expect(readTrackerLog().some((entry) => entry.what === "watch adopted")).toBe(true)
  })

  it("keeps the GPS tier's accuracy for a moving phone", async () => {
    await enterMoving()
    await enterDriving(30)
    start.mockClear()
    await enterWatched(600)
    expect(lastOptions()).toMatchObject({ accuracy: Location.Accuracy.High, timeInterval: 5_000 })
  })
})

describe("uploads", () => {
  const queued = () =>
    useTrackingStore
      .getState()
      .enqueue([
        { ...HOME, recordedAt: new Date().toISOString(), accuracyMeters: 10, source: "background" },
      ])

  it("retry on their own after a failure: half a minute, a minute, two minutes", async () => {
    await enterMoving()
    mockUpload.mockRejectedValue(new ApiError(0, "network", "offline"))
    queued()
    await flush()
    expect(mockUpload).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(60_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(120_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(4)
    // Then it waits for the next delivery rather than hammering.
    await jest.advanceTimersByTimeAsync(10 * 60_000)
    expect(mockUpload).toHaveBeenCalledTimes(4)
    expect(useTrackingStore.getState().queue).toHaveLength(1)
  })

  it("start the ladder over once one gets through", async () => {
    await enterMoving()
    mockUpload.mockRejectedValueOnce(new ApiError(503, "down", "down"))
    queued()
    await flush()
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().queue).toHaveLength(0)

    mockUpload.mockRejectedValueOnce(new ApiError(0, "network", "offline"))
    queued()
    await flush()
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(4)
  })

  it("are attempted on every delivery, whether or not it kept a fix", async () => {
    await enterMoving()
    const t0 = Date.now()
    await ingest([at(HOME.lat, HOME.lon, t0)], "background")
    mockUpload.mockClear()
    // A near duplicate a second later is thinned away, and the queue behind
    // it, left by an earlier failure, still goes.
    useTrackingStore.getState().enqueue([
      {
        ...HOME,
        recordedAt: new Date(t0 - 60_000).toISOString(),
        accuracyMeters: 10,
        source: "background",
      },
    ])
    await ingest([at(HOME.lat, HOME.lon, t0 + 1_000)], "background")
    expect(mockUpload).toHaveBeenCalled()
  })
})

describe("diagnostics", () => {
  it("records what every report, upload and registration came to", async () => {
    await enterMoving()
    await reportNow("manual")
    const names = readTrackerLog().map((entry) => entry.what)
    expect(names).toContain("service")
    expect(names).toContain("report")
    expect(names).toContain("report done")
    expect(names).toContain("flush")

    mockUpload.mockRejectedValueOnce(new ApiError(0, "network", "offline"))
    getPosition.mockRejectedValueOnce(new Error("no fix"))
    await reportNow("manual")
    const later = readTrackerLog().map((entry) => entry.what)
    expect(later).toContain("report failed")

    useTrackingStore
      .getState()
      .enqueue([
        { ...HOME, recordedAt: new Date().toISOString(), accuracyMeters: 10, source: "background" },
      ])
    mockUpload.mockRejectedValueOnce(new ApiError(0, "network", "offline"))
    await flush()
    expect(readTrackerLog().map((entry) => entry.what)).toContain("flush failed")
  })

  it("says why the heartbeat did not ask", async () => {
    await enterMoving()
    AppState.currentState = "active"
    useTrackingStore.getState().setPermission("denied")
    startForegroundHeartbeat()
    await jest.advanceTimersByTimeAsync(0)
    const skipped = readTrackerLog().find((entry) => entry.what === "heartbeat skipped")
    expect(skipped?.detail).toMatchObject({ reason: "permission" })
  })

  it("notes the sync task's run and a re-asserted service", async () => {
    await enterMoving()
    mockServiceStatus = "refused"
    await taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })
    const names = readTrackerLog().map((entry) => entry.what)
    expect(names).toContain("sync")
    expect(names).toContain("reassert")
  })

  it("opens a shared log with what the tracker believes right now", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    const header = headerForTrackerLog()
    expect(header).toContain("mode stationary")
    expect(header).toContain("anchor 51.4545")
    expect(header).toContain("queue 0")
    expect(header).toContain("service running")
    expect(header).toContain("permission")
    expect(formatTrackerLog().startsWith(header)).toBe(true)
  })

  it("keeps a thousand lines", () => {
    for (let i = 0; i < 1200; i += 1) logTracker("line", { i })
    expect(readTrackerLog().length).toBe(1000)
  })
})
