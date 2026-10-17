import { AppState, Platform } from "react-native"
import type { LocationFixInput } from "@hearth/shared"
import * as Location from "expo-location"

import { ApiError } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { useIncidentStore } from "@/stores/incident"
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
  processNativeQueue,
  reassertService,
  reportNow,
  RESTING_HEARTBEAT_MS,
  serviceDiedUnexpectedly,
  setHealthReporter,
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

jest.mock("./nativeTracker")
// eslint-disable-next-line import/first
import * as nativeTracker from "./nativeTracker"

/** The native transport's test double, reached through the module the tracker sees. */
const { fake } = nativeTracker as unknown as typeof import("./__mocks__/nativeTracker")
const lastRequest = () => fake.startService.mock.calls[fake.startService.mock.calls.length - 1]![0]

jest.mock("./driveSensors", () => ({
  startDriveSensors: jest.fn(async () => true),
  stopDriveSensors: jest.fn(),
}))

const mockUpload = jest.fn()
const mockRaiseSos = jest.fn(async (..._args: unknown[]) => ({ id: "alert" }))
jest.mock("@/services/api", () => ({
  ApiError: jest.requireActual("@/services/api/client").ApiError,
  endpoints: {
    locations: { upload: (...args: unknown[]) => mockUpload(...args) },
    safety: { raiseSos: (...args: unknown[]) => mockRaiseSos(...args) },
    circles: { list: async () => [{ id: "c1", settings: { incidentDetection: true } }] },
  },
}))
let mockHeldTokens: { accessToken: string; refreshToken: string } | null = null
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: {
    hydrate: async () => ({ accessToken: "a", refreshToken: "r" }),
    peek: () => mockHeldTokens,
  },
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
  mockHeldTokens = null
  jest.clearAllMocks()
  fake.reset()
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
    expect(fake.status).toBe("running")
    expect(lastRequest()).toEqual({ priority: "balanced", intervalMs: 30_000, distanceMeters: 0 })
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(fake.status).toBe("none")
    expect(lastOptions().foregroundService).toBeUndefined()
    expect(lastOptions().accuracy).toBe(Location.Accuracy.Balanced)
    expect(lastOptions().timeInterval).toBe(RESTING_HEARTBEAT_MS)
  })

  it("answers a wake on a parked phone with one fix under the wake service, which goes with it", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    getPosition.mockClear()
    await wakeFix()
    // The native service carries the fix and its notification; the resting
    // request is left exactly as it was.
    expect(fake.startBrief).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(fake.stopBrief).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(uploaded().map((fix) => fix.source)).toContain("nudge")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("takes the wake service down even when the fix never comes", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    const fix = wakeFix()
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(await fix).toBeNull()
    expect(fake.stopBrief).toHaveBeenCalledTimes(1)
  })

  it("leaves a parked phone alone, since it wants no service", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    fake.status = "refused"
    await reassertService()
    expect(fake.startService).not.toHaveBeenCalled()
  })

  it("tries once per ten minutes on deliveries while refused, since a re-register re-delivers", async () => {
    await enterMoving()
    fake.refuse = true
    fake.status = "refused"
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
    fake.refuse = false
    fake.status = "running"
    await deliver()
    expect(reasserts()).toBe(2)
  })

  it("tries at once on a transition even inside the backoff, since Android allows that start", async () => {
    await startTracking()
    await enterMoving()
    fake.refuse = true
    fake.status = "refused"
    fake.startService.mockClear()
    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat, HOME.lon, Date.now())] },
      error: null,
    })
    expect(fake.startService).toHaveBeenCalledTimes(1)
    classifier()("walking", 90, "transition")
    await jest.advanceTimersByTimeAsync(0)
    expect(fake.startService).toHaveBeenCalledTimes(2)
  })

  it("tries again on an activity transition, which is a moment Android allows the start", async () => {
    await startTracking()
    await enterMoving()
    fake.status = "refused"
    fake.startService.mockClear()
    classifier()("walking", 90, "transition")
    await jest.advanceTimersByTimeAsync(0)
    expect(fake.startService).toHaveBeenCalled()
  })

  it("tries again from the sync task", async () => {
    await enterMoving()
    fake.status = "refused"
    fake.startService.mockClear()
    await taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })
    expect(fake.startService).toHaveBeenCalled()
  })

  it("does not read a parked phone's missing service as a death", async () => {
    await enterMoving()
    fake.status = "none"
    await enterStationary(HOME.lat, HOME.lon)
    expect(serviceDiedUnexpectedly()).toBe(false)
    // Nor a wake's brief service going down with its fix.
    await wakeFix()
    expect(serviceDiedUnexpectedly()).toBe(false)
  })

  it("forgets a death once the phone parks, since a parked phone wants no service", async () => {
    await enterMoving()
    fake.status = "none"
    await reassertService()
    expect(serviceDiedUnexpectedly()).toBe(true)
    await enterStationary(HOME.lat, HOME.lon)
    expect(serviceDiedUnexpectedly()).toBe(false)
  })

  it("remembers a service that died without being asked, for the health report", async () => {
    await enterMoving()
    expect(serviceDiedUnexpectedly()).toBe(false)
    fake.status = "none"
    fake.startService.mockClear()
    await reassertService()
    expect(serviceDiedUnexpectedly()).toBe(true)
    expect(useTrackingStore.getState().serviceStoppedAt).not.toBeNull()
    // And it is brought back.
    expect(fake.startService).toHaveBeenCalledTimes(1)
  })
})

describe("a stop the phone cannot arm", () => {
  it("is not tried again on the next delivery when the fence cannot be set", async () => {
    await enterMoving()
    fake.refuseFence = true
    const before = Date.now()
    await enterStationary(HOME.lat, HOME.lon)
    expect(useTrackingStore.getState().mode).toBe("moving")
    // The anchor is re-dated, so the phone has to sit still for the full
    // window again before it tries to park, rather than on the next fix.
    const anchor = useTrackingStore.getState().stillAnchor
    expect(anchor).not.toBeNull()
    expect(Date.parse(anchor!.since)).toBeGreaterThanOrEqual(before)
    fake.armFence.mockClear()
    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat, HOME.lon, Date.now())] },
      error: null,
    })
    expect(fake.armFence).not.toHaveBeenCalled()
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

describe("the fence Play Services keeps for a parked phone", () => {
  const sync = () => taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })

  // The app's own flag said armed long after Play Services had dropped the
  // fence, so the sync task's re-arm never ran.
  it("is added again on every sync, whatever the app last recorded", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    fake.armFence.mockClear()
    await sync()
    await sync()
    expect(fake.armFence).toHaveBeenCalledTimes(2)
    expect(fake.armFence).toHaveBeenLastCalledWith(HOME.lat, HOME.lon, expect.any(Number))
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("is noted when Play Services drops it, and the next sync looks for a departure", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    await sync()
    getPosition.mockClear()
    // What the receiver does with the error Play Services sends.
    fake.fence = null
    fake.events = [{ type: "fence_lost", code: 1000, at: Date.now() } as never]
    await processNativeQueue()
    expect(readTrackerLog().some((entry) => entry.what === "fence lost")).toBe(true)
    await sync()
    expect(fake.fence).not.toBeNull()
    expect(getPosition).toHaveBeenCalled()
  })
})

describe("tracking that should be running and is not", () => {
  const background = Location.getBackgroundPermissionsAsync as unknown as jest.Mock
  const services = Location.hasServicesEnabledAsync as unknown as jest.Mock
  /** Long enough for a start, its first fix and the park, all on fake timers. */
  const settle = () => jest.advanceTimersByTimeAsync(1_000)

  beforeEach(() => {
    // Signed in at launch, which the launch path answers on its own.
    useAuthStore.setState({ status: "booting" })
    useAuthStore.setState({ status: "signed_in", user: { id: "u1" } as never })
  })

  afterEach(() => {
    useAuthStore.getState().signedOut()
  })

  // The switch stayed on through a permission fixed in Settings, an expired
  // session signed back into and a change of server, and only a cold start
  // brought the tracker back.
  it("starts again on the way back to the app once it can", async () => {
    expect(useTrackingStore.getState().mode).toBe("off")
    await refreshLocationStatus()
    await settle()
    expect(useTrackingStore.getState().mode).not.toBe("off")
  })

  it("starts on a fresh sign-in", async () => {
    useAuthStore.getState().signedOut()
    useAuthStore.getState().signedIn({ id: "u2" } as never)
    await settle()
    expect(useTrackingStore.getState().mode).not.toBe("off")
  })

  it("never starts when the person turned sharing off", async () => {
    useTrackingStore.getState().setEnabled(false)
    await refreshLocationStatus()
    useAuthStore.getState().signedOut()
    useAuthStore.getState().signedIn({ id: "u2" } as never)
    await settle()
    expect(useTrackingStore.getState().mode).toBe("off")
  })

  it("stays off signed out, short of Always, with Location off, or refused by the server", async () => {
    useAuthStore.getState().signedOut()
    await refreshLocationStatus()
    expect(useTrackingStore.getState().mode).toBe("off")
    useAuthStore.getState().signedIn({ id: "u1" } as never)
    await settle()
    await stopTracking()

    background.mockResolvedValueOnce({ status: "denied" })
    await refreshLocationStatus()
    services.mockResolvedValueOnce(false)
    await refreshLocationStatus()
    useTrackingStore.getState().setUploadsRefusedAt(new Date().toISOString())
    await refreshLocationStatus()
    await settle()
    expect(useTrackingStore.getState().mode).toBe("off")
  })
})

describe("what the family hears with the app closed", () => {
  const reporter = jest.fn(async () => {})
  const sync = () => taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null })
  const services = Location.hasServicesEnabledAsync as unknown as jest.Mock
  const background = Location.getBackgroundPermissionsAsync as unknown as jest.Mock

  beforeAll(() => setHealthReporter(reporter))

  // The report only went when the app was opened, and the phones in trouble
  // are the ones nobody opens.
  it("hears of a location service that died under a moving phone", async () => {
    await enterMoving()
    reporter.mockClear()
    fake.status = "none"
    await reassertService()
    expect(reporter).toHaveBeenCalled()
  })

  it("hears of Location switched off from the sync task, which leaves the tracker as it was", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    reporter.mockClear()
    services.mockResolvedValueOnce(false)
    await sync()
    expect(useTrackingStore.getState().servicesEnabled).toBe(false)
    expect(reporter).toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("hears of a fence Play Services dropped", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    reporter.mockClear()
    fake.events = [{ type: "fence_lost", code: 1000, at: Date.now() } as never]
    await processNativeQueue()
    expect(reporter).toHaveBeenCalled()
  })

  it("hears of a parked iPhone changed to While Using", async () => {
    Platform.OS = "ios"
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    reporter.mockClear()
    background.mockResolvedValueOnce({ status: "denied" })
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    expect(useTrackingStore.getState().permission).toBe("foreground")
    expect(reporter).toHaveBeenCalled()
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

  // A report a moment earlier had the phone at home, 174 m from where the
  // stop began. The made-up fix repeated the start of the stop with a fresh
  // time and no accuracy, and her dot sat down the road for twelve minutes.
  it("repeats a fresh real position rather than a stale anchor", async () => {
    await enterMoving()
    const home = { lat: HOME.lat + 174 / 111_195, lon: HOME.lon }
    useTrackingStore.getState().enqueue([
      toFix(at(home.lat, home.lon, Date.now(), null, 100), "nudge", {
        batteryLevel: 0.3,
        isCharging: false,
      }),
    ])
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    const parked = enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    await parked
    const park = uploaded().find((fix) => fix.source === "significant")
    expect(park).toMatchObject({
      lat: home.lat,
      lon: home.lon,
      activity: "still",
      accuracyMeters: 100,
    })
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
    expect(fake.armFence).toHaveBeenCalledTimes(1)
    expect(uploaded().filter((fix) => fix.activity === "still")).toHaveLength(1)
  })

  it("does the same on iOS, without tearing the session down first", async () => {
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

  it("reports on the clock while watched, not on distance, so a phone standing still is still live", async () => {
    // iOS has no time interval; only a session with no distance filter
    // delivers to a phone that is not moving, and "live" is a fix in the
    // last half minute whatever the phone is doing.
    await enterMoving()
    await enterWatched(600)
    expect(lastOptions().distanceInterval).toBe(0)
    await enterStationary(HOME.lat, HOME.lon)
    await enterWatched(600)
    expect(lastOptions().distanceInterval).toBe(0)
  })

  it("says it is still there every quarter hour from the fix the OS already has", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    mockUpload.mockClear()
    getPosition.mockClear()
    lastKnown.mockResolvedValue(at(HOME.lat + 0.0001, HOME.lon, Date.now() - 10 * 60_000, 0, 65))
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    const beat = uploaded().find((fix) => fix.source === "heartbeat")
    expect(beat).toMatchObject({ activity: "still", lat: HOME.lat, accuracyMeters: mockAccuracy })
    // It says "here, now", which is what a phone that has not left the fence means.
    expect(Date.now() - Date.parse(beat!.recordedAt)).toBeLessThan(1_000)
    expect(getPosition).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("stationary")

    // And again a quarter hour later.
    mockUpload.mockClear()
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    expect(uploaded().some((fix) => fix.source === "heartbeat")).toBe(true)
  })

  // A cell-only session's estimate, re-dated now, put a parked member
  // hundreds of metres from home on the family's map every quarter hour.
  it("says so from where it parked, not from a cell estimate down the road", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    mockUpload.mockClear()
    lastKnown.mockResolvedValue(
      at(HOME.lat + 600 / 111_195, HOME.lon, Date.now() - 60_000, null, 1_000),
    )
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    const beat = uploaded().find((fix) => fix.source === "heartbeat")
    expect(beat).toMatchObject({
      lat: HOME.lat,
      lon: HOME.lon,
      accuracyMeters: mockAccuracy,
      activity: "still",
    })
    expect(useTrackingStore.getState().mode).toBe("stationary")
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
    expect(lastOptions().timeInterval).toBe(1_000)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(uploaded().some((fix) => fix.source === "nudge")).toBe(true)

    // No fix comes for the rest of the window: the phone parks meanwhile,
    // and the window's end still steps the request down to the parked one.
    start.mockClear()
    await jest.advanceTimersByTimeAsync(601_000 + 1_000)
    expect(useTrackingStore.getState().watchedUntil).toBeNull()
    expect(start).toHaveBeenCalled()
    expect(lastOptions().timeInterval).not.toBe(1_000)
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

  it("ask again when the OS answers a fresh request with a fix it had cached", async () => {
    // An app opened after hours away asks for a fix, and iOS can answer
    // with the one it already holds, from where the phone was hours ago.
    // Uploaded as it is, the server never moves presence back to it, and
    // the row keeps saying "two hours ago, at home".
    Platform.OS = "ios"
    await enterMoving()
    getPosition.mockClear()
    mockUpload.mockClear()
    getPosition.mockImplementationOnce(async () =>
      at(HOME.lat, HOME.lon, Date.now() - 2 * 60 * 60_000, 0, 30),
    )
    mockHere = { lat: HOME.lat + 0.01, lon: HOME.lon }
    const fix = await reportNow("foreground", Location.Accuracy.Balanced)
    expect(getPosition).toHaveBeenCalledTimes(2)
    expect(fix?.lat).toBeCloseTo(HOME.lat + 0.01)
    expect(Date.now() - Date.parse(fix!.recordedAt)).toBeLessThan(60_000)
    const stale = readTrackerLog().find((entry) => entry.what === "report stale")
    expect(stale?.detail).toMatchObject({ age: 7200 })
  })

  it("take the second answer whatever its age, since two cached fixes are all the OS has", async () => {
    Platform.OS = "ios"
    await enterMoving()
    getPosition.mockClear()
    getPosition.mockImplementation(async () =>
      at(HOME.lat, HOME.lon, Date.now() - 2 * 60 * 60_000, 0, 30),
    )
    const fix = await reportNow("foreground", Location.Accuracy.Balanced)
    expect(getPosition).toHaveBeenCalledTimes(2)
    expect(fix).not.toBeNull()
    getPosition.mockImplementation(mockPositionNow)
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
    expect(useTrackingStore.getState().driving).toEqual({ distance: 250, slowSince: null })
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

  it("opens the control channel at boot when an Android phone is on the move", () => {
    Platform.OS = "android"
    useTrackingStore.setState({ enabled: true, mode: "moving" })
    mockControlWanted.mockClear()
    relaunch()
    expect(mockControlWanted).toHaveBeenLastCalledWith(true)
  })

  it("tells native the tier it woke in on Android, then drains what native kept", async () => {
    Platform.OS = "android"
    useTrackingStore.setState({ enabled: true, mode: "stationary" })
    let fresh: typeof import("./__mocks__/nativeTracker") | null = null
    jest.isolateModules(() => {
      // Everything is fresh in here, the platform included.
      ;(require("react-native") as { Platform: { OS: string } }).Platform.OS = "android"
      // The fresh process's own copy of the transport, seeded as a receiver
      // would have left it before this side came up.
      fresh = require("./nativeTracker")
      fresh!.fake.events = [{ type: "boot", at: Date.now() }]
      require("./tracker")
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(fresh!.fake.state).toMatchObject({ enabled: true, mode: "stationary" })
    expect(fresh!.fake.state?.movingRequest).toMatchObject({ priority: "balanced" })
    expect(fresh!.fake.events).toHaveLength(0)
  })

  it("asks for the channel again once the keychain has handed over the tokens", async () => {
    Platform.OS = "android"
    useTrackingStore.setState({ enabled: true, mode: "moving" })
    mockControlWanted.mockClear()
    relaunch()
    await jest.advanceTimersByTimeAsync(0)
    expect(mockControlWanted.mock.calls.filter(([wanted]) => wanted)).toHaveLength(2)
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
    fake.armFence.mockClear()
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
    expect(fake.armFence).not.toHaveBeenCalled()
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
    // A parked Android phone holds nothing open; a high priority push
    // starts the wake service natively, the way a messaging app checks for
    // messages.
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
  it("answers a watch on a parked phone at once and goes live under the service, still parked", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockClear()
    mockUpload.mockClear()
    await enterWatched(600)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(uploaded()).toHaveLength(1)
    expect(lastRequest()).toEqual({ priority: "high", intervalMs: 1_000, distanceMeters: 0 })
    expect(useTrackingStore.getState().mode).toBe("stationary")
    // The window is held, so a departure inside it goes straight to live.
    expect(useTrackingStore.getState().watchedUntil).not.toBeNull()
    await enterMoving()
    expect(lastRequest()).toMatchObject({ priority: "high", intervalMs: 1_000 })
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
    expect(readTrackerLog().some((entry) => entry.what === "watch adopted")).toBe(true)
  })

  it("keeps the GPS tier's accuracy for a moving phone", async () => {
    await enterMoving()
    await enterDriving(30)
    await enterWatched(600)
    expect(lastRequest()).toMatchObject({ priority: "high", intervalMs: 1_000 })
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

  it("retry when the token refresh got no answer, since the session is still good", async () => {
    await enterMoving()
    // The client refreshed on the 401 and the refresh hit a dropped network,
    // so the tokens are still held and the 401 comes back to the tracker.
    mockHeldTokens = { accessToken: "a", refreshToken: "r" }
    mockUpload.mockRejectedValueOnce(new ApiError(401, "unauthorized", "expired"))
    queued()
    await flush()
    expect(useTrackingStore.getState().lastError).not.toMatch(/signed out/i)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  // A firewall in front of the server answers with a page of its own, often
  // a 403 while it holds the address out. That says nothing about the fixes,
  // and dropping them as a bad batch lost the whole queue.
  it("keep the batch when something in front of the server refused it", async () => {
    await enterMoving()
    mockUpload.mockRejectedValueOnce(
      new ApiError(403, "http_403", "Request failed with status 403."),
    )
    queued()
    await flush()
    expect(useTrackingStore.getState().queue).not.toHaveLength(0)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  it("drop a batch the server itself refused, so one bad fix cannot hold up the rest", async () => {
    await enterMoving()
    mockUpload.mockRejectedValueOnce(new ApiError(400, "validation_error", "Invalid body"))
    queued()
    await flush()
    expect(useTrackingStore.getState().queue).toHaveLength(0)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  // A firewall in front of the server locks an address out after a 4xx, so
  // the next batch straight after a refused one only made it worse.
  it("wait before the next batch once the server refused one", async () => {
    await enterMoving()
    const t0 = Date.now()
    useTrackingStore.getState().enqueue(
      Array.from({ length: 250 }, (_, i) => ({
        ...HOME,
        recordedAt: new Date(t0 - (250 - i) * 1_000).toISOString(),
        accuracyMeters: 10,
        source: "background" as const,
      })),
    )
    mockUpload.mockRejectedValueOnce(new ApiError(400, "validation_error", "Invalid body"))
    await flush()
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().queue).toHaveLength(50)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  // A deactivated account is answered 403 on every request, and each one
  // tripped the firewall in front of the server.
  it("stop sharing and say so when the server refuses the account", async () => {
    await enterMoving()
    mockUpload.mockRejectedValue(
      new ApiError(403, "forbidden", "This account has been deactivated."),
    )
    queued()
    await flush()
    expect(useTrackingStore.getState().mode).toBe("off")
    expect(useTrackingStore.getState().lastError).toMatch(/deactivated/)
    expect(readTrackerLog().some((entry) => entry.what === "refused")).toBe(true)

    queued()
    await flush()
    await jest.advanceTimersByTimeAsync(10 * 60_000)
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  it("stop and say so once the server has ended the session", async () => {
    await enterMoving()
    mockUpload.mockRejectedValueOnce(new ApiError(401, "unauthorized", "expired"))
    queued()
    await flush()
    expect(useTrackingStore.getState().lastError).toMatch(/signed out/i)
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  // Behind a firewall that locks out an address for a while, a phone on Live
  // trying again with every second's fix kept the whole household locked out.
  it("back off on a short ladder while live, and keep every fix for when it lifts", async () => {
    await enterMoving()
    await enterWatched(600)
    await jest.advanceTimersByTimeAsync(0)
    mockUpload.mockReset()
    mockUpload.mockRejectedValue(new ApiError(0, "network_error", "Could not reach the server."))
    const before = useTrackingStore.getState().queue.length
    const t0 = Date.now()
    for (let i = 0; i < 20; i += 1) {
      const n = i + 1
      await ingest([at(HOME.lat + n * 0.0001, HOME.lon, t0 + n * 1_000, 5, 8)], "background")
      await jest.advanceTimersByTimeAsync(1_000)
    }
    // At once, then two, five and ten seconds on.
    expect(mockUpload).toHaveBeenCalledTimes(4)
    expect(useTrackingStore.getState().queue).toHaveLength(before + 20)

    mockUpload.mockImplementation(async (batch: LocationFixInput[]) => reply(batch.length))
    await jest.advanceTimersByTimeAsync(10_000)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
    const [delivered] = mockUpload.mock.calls.at(-1) as [LocationFixInput[]]
    expect(delivered).toHaveLength(before + 20)
    const times = delivered.map((fix) => Date.parse(fix.recordedAt))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  // One upload that hung for its whole half minute froze the stream on the
  // viewer's screen for as long.
  it("give a stuck upload a few seconds while live, then send it again at once", async () => {
    await enterMoving()
    await enterWatched(600)
    await jest.advanceTimersByTimeAsync(0)
    mockUpload.mockClear()
    mockUpload.mockRejectedValueOnce(
      new ApiError(0, "timeout", "The server took too long to respond."),
    )
    queued()
    await flush()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    const [first, second] = mockUpload.mock.calls as Array<
      [LocationFixInput[], { timeoutMs?: number }]
    >
    expect(first![1]?.timeoutMs).toBeLessThanOrEqual(5_000)
    expect(second![0]).toEqual(first![0])
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  // A network that is slow rather than stuck still has to get through.
  it("give a slow network the full time after two quick tries", async () => {
    await enterMoving()
    await enterWatched(600)
    await jest.advanceTimersByTimeAsync(0)
    mockUpload.mockClear()
    const late = new ApiError(0, "timeout", "The server took too long to respond.")
    mockUpload.mockRejectedValueOnce(late).mockRejectedValueOnce(late)
    queued()
    await flush()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(2_000 + 10)
    expect(mockUpload).toHaveBeenCalledTimes(3)
    const third = mockUpload.mock.calls[2] as [
      LocationFixInput[],
      { timeoutMs?: number } | undefined,
    ]
    expect(third[1]?.timeoutMs ?? 30_000).toBeGreaterThan(5_000)
    expect(useTrackingStore.getState().queue).toHaveLength(0)
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
    fake.status = "refused"
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
    expect(header).toContain("anchor since")
    expect(header).toContain("queue 0")
    expect(header).toContain("service none")
    expect(header).toContain("permission")
    expect(header).toContain("location precise")
    expect(header).toContain("uploads accepted")
    expect(formatTrackerLog().startsWith(header)).toBe(true)

    useTrackingStore.getState().setPreciseLocation(false)
    useTrackingStore.getState().setUploadsRefusedAt("2026-09-17T10:00:00.000Z")
    expect(headerForTrackerLog()).toContain("location approximate")
    expect(headerForTrackerLog()).toContain("uploads refused since 2026-09-17T10:00:00.000Z")
    useTrackingStore.getState().setPreciseLocation(true)
  })

  it("holds no position, since it is shared into issues and chats", async () => {
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    const shared = formatTrackerLog()
    expect(shared).not.toContain(HOME.lat.toFixed(3))
    expect(shared).not.toContain(HOME.lon.toFixed(3))
  })

  it("keeps a thousand lines", () => {
    for (let i = 0; i < 1200; i += 1) logTracker("line", { i })
    expect(readTrackerLog().length).toBe(1000)
  })
})

describe("an incident alert waiting for a signal", () => {
  it("goes with the first upload that gets through", async () => {
    await enterMoving()
    // Decided on a minute ago, by a countdown that ran out with no signal.
    useIncidentStore.setState({
      pending: {
        detectedAt: Date.now() - 90_000,
        peakDeltaG: 9,
        corroborations: 2,
        escalatedAt: Date.now() - 60_000,
        triedAt: Date.now() - 1_000,
        attempts: 1,
        failure: "network",
        notice: "waiting",
      },
    })

    await taskBodies.get(BACKGROUND_LOCATION_TASK)!({
      data: { locations: [at(HOME.lat + 0.01, HOME.lon, Date.now(), 12)] },
      error: null,
    })
    await jest.advanceTimersByTimeAsync(0)

    expect(mockUpload).toHaveBeenCalled()
    expect(mockRaiseSos).toHaveBeenCalledWith("c1", expect.any(String), "incident")
    expect(useIncidentStore.getState().pending).toBeNull()
  })

  it("holds the background sync task open until the alert has had its try", async () => {
    // iOS suspends the app the moment the task returns, and an alert still on
    // its way at that moment waits for the next wake, a quarter hour or more.
    let answer!: () => void
    mockRaiseSos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ id: "alert" })
        }),
    )
    useIncidentStore.setState({
      pending: {
        detectedAt: Date.now() - 90_000,
        peakDeltaG: 9,
        corroborations: 2,
        escalatedAt: Date.now() - 60_000,
        triedAt: Date.now() - 60_000,
        attempts: 1,
        failure: "network",
      },
    })

    let returned = false
    const run = taskBodies.get(BACKGROUND_SYNC_TASK)!({ data: null, error: null }).then(() => {
      returned = true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(mockRaiseSos).toHaveBeenCalled()
    expect(returned).toBe(false)

    answer()
    await run
    expect(useIncidentStore.getState().pending).toBeNull()
  })
})
