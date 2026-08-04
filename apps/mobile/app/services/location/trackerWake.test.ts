import { AppState, Platform } from "react-native"
import * as Location from "expo-location"

import { useTrackingStore } from "@/stores/tracking"

import { useAuthStore } from "@/stores/auth"
import {
  enterDriving,
  enterMoving,
  enterStationary,
  enterWatched,
  flush,
  ingest,
  isDriving,
  reassertService,
  RESTING_HEARTBEAT_MS,
  startBackgroundClock,
  startTracking,
  STATIONARY_GEOFENCE_TASK,
  stopBackgroundClock,
  stopTracking,
  wakeFix,
} from "./tracker"

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => true),
}))
// eslint-disable-next-line import/first
import * as TaskManager from "expo-task-manager"

type TaskBody = (body: { data: unknown; error: { message: string } | null }) => Promise<unknown>
/** Captured at import, since the tracker registers its tasks the moment it loads. */
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

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4, Highest: 6 },
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
// eslint-disable-next-line import/first
import { startMotion } from "./motion"

jest.mock("./driveSensors", () => ({
  startDriveSensors: jest.fn(async () => true),
  stopDriveSensors: jest.fn(),
}))

const start = Location.startLocationUpdatesAsync as unknown as jest.Mock
const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock
const os = Platform.OS
const optionsOf = (call: number) => start.mock.calls[call]![1] as Location.LocationTaskOptions

beforeEach(async () => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date("2026-09-13T10:00:00Z"))
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useTrackingStore.getState().setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 })
  AppState.currentState = "background"
  mockHere = { ...HOME }
  mockSpeed = 0
  jest.clearAllMocks()
})

afterEach(async () => {
  stopBackgroundClock()
  Platform.OS = os
  AppState.currentState = "active"
  jest.useRealTimers()
})

let mockServiceStatus = "running"
jest.mock("expo-modules-core", () => ({
  ...jest.requireActual("expo-modules-core"),
  requireOptionalNativeModule: () => ({
    getForegroundServiceStatusAsync: async () => mockServiceStatus,
  }),
}))

describe("a journey starting in the background on Android", () => {
  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
  })

  it("stops the fence once the service is up", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    ;(Location.stopGeofencingAsync as unknown as jest.Mock).mockClear()
    await enterMoving()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(Location.stopGeofencingAsync).toHaveBeenCalled()
    expect(optionsOf(start.mock.calls.length - 1).foregroundService).toMatchObject({
      notificationTitle: "Hearth",
    })
  })

  it("keeps the fence armed when Android refused the service, and is still moving", async () => {
    // A stop that ends on the classifier's sampled verdict is not one of the
    // moments Android allows a start. The fence exit is, so it stays.
    await enterStationary(HOME.lat, HOME.lon)
    ;(Location.stopGeofencingAsync as unknown as jest.Mock).mockClear()
    mockServiceStatus = "refused"
    await enterMoving()
    expect(useTrackingStore.getState().mode).toBe("moving")
    // The anchor is kept: a departure that turns out false settles on it.
    expect(useTrackingStore.getState().stillAnchor).toMatchObject(HOME)
    expect(Location.stopGeofencingAsync).not.toHaveBeenCalled()
    // The request itself stands, so the phone is on throttled fixes, not none.
    expect(optionsOf(start.mock.calls.length - 1).accuracy).toBe(Location.Accuracy.Balanced)
  })

  it("re-asserts the request when a push lands and the service was refused, in the tier it is in", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    mockServiceStatus = "refused"
    await enterMoving()
    await enterDriving(30)
    start.mockClear()

    await reassertService()
    expect(start).toHaveBeenCalledTimes(1)
    expect(optionsOf(0).accuracy).toBe(Location.Accuracy.High)
    expect(optionsOf(0).foregroundService).toMatchObject({ notificationTitle: "Hearth" })
    expect(isDriving()).toBe(true)
  })

  it("leaves a running service, a parked phone and iOS alone", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    await enterMoving()
    start.mockClear()
    await reassertService()
    expect(start).not.toHaveBeenCalled()

    mockServiceStatus = "refused"
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    await reassertService()
    expect(start).not.toHaveBeenCalled()

    Platform.OS = "ios"
    await enterMoving()
    start.mockClear()
    await reassertService()
    expect(start).not.toHaveBeenCalled()
  })

  it("answers a wake with the service up for the fix and down again after", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    // Let the arrival fix land, then forget it.
    await jest.advanceTimersByTimeAsync(0)
    useTrackingStore.setState({ queue: [] })
    start.mockClear()
    getPosition.mockClear()
    await wakeFix()
    // Up with the notification, the fix, and down without it.
    expect(start).toHaveBeenCalledTimes(2)
    expect(optionsOf(0).foregroundService).toMatchObject({ notificationTitle: "Hearth" })
    expect(optionsOf(0).timeInterval).toBe(RESTING_HEARTBEAT_MS)
    expect(optionsOf(1).foregroundService).toBeUndefined()
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(getPosition.mock.invocationCallOrder[0]!)
    expect(useTrackingStore.getState().queue.map((fix) => fix.source)).toContain("nudge")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("does not bring the service in for a moving phone's wake, which already has it", async () => {
    await enterMoving()
    start.mockClear()
    await wakeFix()
    expect(start).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().queue).toHaveLength(1)
  })

  it("takes the service down again even when the fix never comes", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockImplementationOnce(() => new Promise(() => {}))
    start.mockClear()
    const fix = wakeFix()
    await jest.advanceTimersByTimeAsync(30_000 + 10)
    expect(await fix).toBeNull()
    expect(start).toHaveBeenCalledTimes(2)
    expect(optionsOf(1).foregroundService).toBeUndefined()
  })
})

describe("being watched", () => {
  const sample = (at: number): Location.LocationObject => ({
    timestamp: at,
    coords: {
      latitude: HOME.lat + 0.01,
      longitude: HOME.lon,
      altitude: 0,
      accuracy: 10,
      altitudeAccuracy: 5,
      heading: 0,
      speed: 1,
    },
  })

  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
  })

  it("goes live for the window while moving, and steps down on the first fix past it", async () => {
    await enterMoving()
    start.mockClear()
    await enterWatched(600)
    expect(optionsOf(0).accuracy).toBe(Location.Accuracy.High)
    expect(optionsOf(0).timeInterval).toBe(5_000)
    // On the interval, so the window's end is always seen.
    expect(optionsOf(0).distanceInterval).toBe(0)

    // Still inside the window: a fix changes nothing.
    start.mockClear()
    await ingest([sample(Date.now())], "background")
    expect(start).not.toHaveBeenCalled()

    // Past it: the next fix steps the request back to the tier it was in.
    jest.setSystemTime(Date.now() + 601_000)
    await ingest([sample(Date.now())], "background")
    expect(start).toHaveBeenCalledTimes(1)
    expect(optionsOf(0).accuracy).not.toBe(Location.Accuracy.High)
    expect(useTrackingStore.getState().watchedUntil).toBeNull()
  })

  it("answers with one fix when parked, since it is not going anywhere", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockClear()
    start.mockClear()
    await enterWatched(600)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    // No live request while parked.
    expect(
      start.mock.calls.every(
        ([, options]) =>
          (options as Location.LocationTaskOptions).accuracy !== Location.Accuracy.High,
      ),
    ).toBe(true)
  })

  it("stays live in the driving tier's place until the window ends", async () => {
    await enterMoving()
    await enterDriving(30)
    await enterWatched(600)
    start.mockClear()
    // A re-assertion mid window keeps the live request, not the drive's.
    mockServiceStatus = "refused"
    await reassertService()
    expect(optionsOf(0).timeInterval).toBe(5_000)
    expect(isDriving()).toBe(true)
  })

  it("does nothing when sharing is off", async () => {
    await stopTracking()
    start.mockClear()
    await enterWatched(600)
    expect(start).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().watchedUntil).toBeNull()
  })
})

describe("a parked iPhone", () => {
  beforeEach(() => {
    Platform.OS = "ios"
  })

  it("runs no location session at all, only the fence", async () => {
    await enterMoving()
    start.mockClear()
    await enterStationary(HOME.lat, HOME.lon)
    expect(start).not.toHaveBeenCalled()
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalled()
    expect(Location.startGeofencingAsync).toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("never shows the background location indicator in any tier", async () => {
    await enterMoving()
    await enterDriving(30)
    await enterWatched(600)
    for (const [, options] of start.mock.calls as [string, Location.LocationTaskOptions][]) {
      expect(options.showsBackgroundLocationIndicator).toBe(false)
    }
  })

  it("asks for one arrival fix from where it actually settled", async () => {
    await enterMoving()
    getPosition.mockClear()
    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().queue[0]?.source).toBe("significant")
  })
})

describe("one request for the tier the tracker is in", () => {
  it("never carries deferred delivery, which held the end of every journey", async () => {
    Platform.OS = "android"
    await enterMoving()
    expect(optionsOf(0).deferredUpdatesInterval).toBeUndefined()
    await enterDriving(30)
    expect(optionsOf(1).deferredUpdatesInterval).toBeUndefined()
  })

  it("serialises registrations so the last one reflects the last state", async () => {
    Platform.OS = "android"
    let release: (() => void) | null = null
    start.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const moving = enterMoving()
    const parked = enterStationary(HOME.lat, HOME.lon)
    // The first registration reaches the OS a tick later, and holds.
    while (!release) await jest.advanceTimersByTimeAsync(0)
    ;(release as () => void)()
    await Promise.all([moving, parked])
    const last = optionsOf(start.mock.calls.length - 1)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(last.timeInterval).toBe(RESTING_HEARTBEAT_MS)
    expect(last.foregroundService).toBeUndefined()
  })
})

describe("the background clock on iOS", () => {
  const sample = (lat: number, lon: number, at: number): Location.LocationObject => ({
    timestamp: at,
    coords: {
      latitude: lat,
      longitude: lon,
      altitude: 0,
      accuracy: 40,
      altitudeAccuracy: 5,
      heading: -1,
      speed: 0,
    },
  })

  beforeEach(() => {
    Platform.OS = "ios"
  })

  it("never lets iOS pause the updates, since a paused app cannot call the stop", async () => {
    await enterMoving()
    expect(optionsOf(0).pausesUpdatesAutomatically).toBe(false)
  })

  it("calls the stop itself once no fix has come for five minutes", async () => {
    await enterMoving()
    const t0 = Date.now()
    await ingest([sample(HOME.lat, HOME.lon, t0)], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
    getPosition.mockClear()

    // Nothing arrives, because the phone never crossed the distance filter.
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)

    // The clock's fix, then the arrival fix the stop asks for.
    expect(getPosition).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(Location.startGeofencingAsync).toHaveBeenCalled()
  })

  it("never calls a stop from a fix while the tracker believes the phone is driving", async () => {
    // A crawl: fixes keep coming, none of them ends the drive on their own.
    await enterMoving()
    await enterDriving(30)
    const t0 = Date.now()
    const crawl = (at: number, dLat: number) => ({
      ...sample(HOME.lat + dLat, HOME.lon, at),
      coords: { ...sample(HOME.lat + dLat, HOME.lon, at).coords, speed: 3 },
    })
    await ingest([crawl(t0, 0)], "background")
    await ingest([crawl(t0 + 4 * 60_000, 0.0003)], "background")
    await ingest([crawl(t0 + 8 * 60_000, 0.0006)], "background")
    expect(isDriving()).toBe(true)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(Location.startGeofencingAsync).not.toHaveBeenCalled()
  })

  it("ends a drive whose car has not moved in five minutes, and parks it", async () => {
    // The driving tier delivers on distance on iOS, so five minutes without a
    // fix is a car that has not moved. The clock's fix is from the same spot.
    await enterMoving()
    await enterDriving(30)
    const t0 = Date.now()
    await ingest([sample(HOME.lat, HOME.lon, t0)], "background")
    getPosition.mockClear()
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(isDriving()).toBe(false)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(Location.startGeofencingAsync).toHaveBeenCalled()
  })

  it("stands down while the app is open, when parked, and when tracking stops", async () => {
    await enterMoving()
    AppState.currentState = "active"
    stopBackgroundClock()
    getPosition.mockClear()
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(getPosition).not.toHaveBeenCalled()

    // Parked, the phone is suspended and the server's wake is the heartbeat.
    AppState.currentState = "background"
    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    getPosition.mockClear()
    await jest.advanceTimersByTimeAsync(RESTING_HEARTBEAT_MS + 10)
    expect(getPosition).not.toHaveBeenCalled()

    await enterMoving()
    startBackgroundClock()
    await stopTracking()
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(getPosition).not.toHaveBeenCalled()
  })

  it("is Android's sync task's job there, not a timer's", async () => {
    Platform.OS = "android"
    await enterMoving()
    getPosition.mockClear()
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(getPosition).not.toHaveBeenCalled()
  })
})

describe("calling the stop on Android without the classifier", () => {
  const still = (at: number, accuracy = 30, dLat = 0): Location.LocationObject => ({
    timestamp: at,
    coords: {
      latitude: HOME.lat + dLat,
      longitude: HOME.lon,
      altitude: 0,
      accuracy,
      altitudeAccuracy: 5,
      heading: -1,
      speed: 0,
    },
  })

  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
  })

  it("asks Android for a fix on the interval whether or not the phone moved", async () => {
    await enterMoving()
    expect(optionsOf(0).distanceInterval).toBe(0)
    expect(optionsOf(0).timeInterval).toBe(30_000)
    Platform.OS = "ios"
    await enterMoving()
    expect(optionsOf(1).distanceInterval).toBe(60)
  })

  it("judges the stop from the fixes a still phone delivers, without uploading them", async () => {
    await enterMoving()
    const t0 = Date.now()
    await ingest([still(t0)], "background")
    for (let minute = 1; minute <= 4; minute += 1) {
      await ingest([still(t0 + minute * 60_000, 40, 0.0002)], "background")
      await ingest([still(t0 + minute * 60_000 + 30_000, 40, -0.0001)], "background")
    }
    // Eight fixes within a few metres of the first, none worth an upload.
    expect(useTrackingStore.getState().queue).toHaveLength(1)
    expect(useTrackingStore.getState().mode).toBe("moving")

    start.mockClear()
    await ingest([still(t0 + 5 * 60_000 + 1000)], "background")
    expect(useTrackingStore.getState().mode).toBe("stationary")
    // The service and its notification go with the request.
    expect(optionsOf(start.mock.calls.length - 1).foregroundService).toBeUndefined()
  })

  it("does not let a loose Wi-Fi fix reset the clock, and does not let one call the phone gone", async () => {
    await enterMoving()
    const t0 = Date.now()
    await ingest([still(t0)], "background")
    // Two streets away on paper, with an error circle that covers the house.
    await ingest([still(t0 + 2 * 60_000, 200, 0.0011)], "background")
    expect(useTrackingStore.getState().stillAnchor?.since).toBe(new Date(t0).toISOString())
    // A sharp fix two streets away is another matter.
    await ingest([still(t0 + 3 * 60_000, 15, 0.0011)], "background")
    expect(useTrackingStore.getState().stillAnchor?.since).toBe(
      new Date(t0 + 3 * 60_000).toISOString(),
    )

    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    // Parked, a loose fix 400 m off with a 500 m error stays parked.
    await ingest([still(t0 + 20 * 60_000, 500, 0.0036)], "background")
    expect(useTrackingStore.getState().mode).toBe("stationary")
    // A sharp one 400 m off is the phone leaving.
    await ingest([still(t0 + 21 * 60_000, 20, 0.0036)], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
  })
})

describe("the classifier on a parked phone", () => {
  let run = 0

  /** The verdict callback the tracker handed to the classifier. */
  function classifier():
    ((activity: string, confidence: number, source?: "sample" | "transition") => void) | undefined {
    const calls = (startMotion as jest.Mock).mock.calls
    return calls[calls.length - 1]?.[0]
  }

  beforeEach(async () => {
    Platform.OS = "android"
    mockServiceStatus = "running"
    // The classifier's subscription lives in module scope; only a stop
    // releases it, and startTracking is what hands it its callback. So does
    // the time of the last confirming fix, which the clock walks past.
    await stopTracking()
    run += 1
    jest.setSystemTime(Date.now() + run * 5 * 60_000)
    useTrackingStore.getState().setEnabled(true)
    ;(startMotion as jest.Mock).mockClear()
    await startTracking()
    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    start.mockClear()
    getPosition.mockClear()
  })

  it("does not bring the service back for 'walking' from a phone fidgeting in bed", async () => {
    // The fix that confirms the verdict is where the phone parked.
    mockHere = { ...HOME }
    classifier()!("walking", 60)
    await jest.advanceTimersByTimeAsync(0)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(
      start.mock.calls.every(
        ([, options]) => (options as Location.LocationTaskOptions).foregroundService === undefined,
      ),
    ).toBe(true)
  })

  it("brings it back once a fix shows the phone has actually walked off", async () => {
    mockHere = { lat: HOME.lat + 0.002, lon: HOME.lon }
    classifier()!("walking", 60)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(optionsOf(start.mock.calls.length - 1).foregroundService).toMatchObject({
      notificationTitle: "Hearth",
    })
  })

  it("asks for the confirming fix at most every two minutes", async () => {
    mockHere = { ...HOME }
    classifier()!("walking", 60)
    await jest.advanceTimersByTimeAsync(0)
    classifier()!("walking", 70)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(getPosition).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(2 * 60_000)
    classifier()!("walking", 70)
    await jest.advanceTimersByTimeAsync(0)
    expect(getPosition).toHaveBeenCalledTimes(2)
  })

  it("takes a sure vehicle verdict at its word, and lands in the driving tier once", async () => {
    mockHere = { ...HOME }
    classifier()!("automotive", 90)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(isDriving()).toBe(true)
    // One walking registration on the way up, one driving. Not a third.
    const accuracies = start.mock.calls.map(
      ([, options]) => (options as Location.LocationTaskOptions).accuracy,
    )
    expect(accuracies).toEqual([Location.Accuracy.Balanced, Location.Accuracy.High])
  })

  it("confirms a doubtful vehicle sample the way it confirms a walk", async () => {
    mockHere = { ...HOME }
    classifier()!("automotive", 60)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(getPosition).toHaveBeenCalledTimes(1)

    // A transition is the OS's debounced word, and is taken at it.
    classifier()!("automotive", 100, "transition")
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(isDriving()).toBe(true)
  })
})

describe("the other ways a parked phone was made to leave", () => {
  const exit = () =>
    taskBodies.get(STATIONARY_GEOFENCE_TASK)!({
      data: { eventType: Location.GeofencingEventType.Exit },
      error: null,
    })

  beforeEach(async () => {
    Platform.OS = "android"
    mockServiceStatus = "running"
    await enterMoving()
    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    start.mockClear()
  })

  it("re-arms the fence on a false exit, when a sharp fix is still at home", async () => {
    mockHere = { ...HOME }
    ;(Location.startGeofencingAsync as unknown as jest.Mock).mockClear()
    await exit()
    // The service came up inside the allowed moment, and went straight back
    // down once the fix showed the phone had not left.
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(Location.startGeofencingAsync).toHaveBeenCalledTimes(1)
    expect(optionsOf(0).foregroundService).toBeDefined()
    expect(optionsOf(start.mock.calls.length - 1).foregroundService).toBeUndefined()
  })

  it("does nothing to a phone already moving but re-assert the service", async () => {
    mockServiceStatus = "refused"
    await enterMoving()
    getPosition.mockClear()
    start.mockClear()
    mockServiceStatus = "running"
    await exit()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(getPosition).not.toHaveBeenCalled()
    expect(Location.stopGeofencingAsync).toHaveBeenCalled()
  })

  it("takes a real exit, and a loose fix's word for one", async () => {
    mockHere = { lat: HOME.lat + 0.003, lon: HOME.lon }
    await exit()
    expect(useTrackingStore.getState().mode).toBe("moving")

    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    // A cell fix cannot say either way; a departure missed is the worse error.
    mockHere = { ...HOME }
    getPosition.mockImplementationOnce(async () => ({
      timestamp: Date.now(),
      coords: {
        latitude: HOME.lat,
        longitude: HOME.lon,
        altitude: 0,
        accuracy: 1200,
        altitudeAccuracy: 5,
        heading: -1,
        speed: 0,
      },
    }))
    await exit()
    expect(useTrackingStore.getState().mode).toBe("moving")
  })

  it("lets a wake's fix end the stop when it shows the phone has gone", async () => {
    mockHere = { lat: HOME.lat + 0.003, lon: HOME.lon }
    await wakeFix()
    expect(useTrackingStore.getState().mode).toBe("moving")
    // And the service is kept, not taken down with the wake's.
    expect(optionsOf(start.mock.calls.length - 1).foregroundService).toMatchObject({
      notificationTitle: "Hearth",
    })
  })

  it("parks at the first fix when sharing is switched on, rather than running the service to learn it is still", async () => {
    await stopTracking()
    useTrackingStore.getState().setEnabled(true)
    start.mockClear()
    mockHere = { ...HOME }
    await startTracking()
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(useTrackingStore.getState().stillAnchor).toMatchObject(HOME)
    expect(
      start.mock.calls.every(
        ([, options]) => (options as Location.LocationTaskOptions).foregroundService === undefined,
      ),
    ).toBe(true)
  })
})

describe("what the review found", () => {
  const at = (lat: number, lon: number, when: number, speed: number | null = 0, accuracy = 20) =>
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

  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
  })

  it("does not let a still streak from before a departure park the phone on its first sample after", async () => {
    await stopTracking()
    useTrackingStore.getState().setEnabled(true)
    ;(startMotion as jest.Mock).mockClear()
    await startTracking()
    const verdict = (startMotion as jest.Mock).mock.calls.at(-1)![0] as (
      a: string,
      c: number,
    ) => void
    await enterMoving()
    verdict("still", 100)
    await jest.advanceTimersByTimeAsync(100_000)
    verdict("still", 100)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("stationary")

    // Hours later a sharp fix a kilometre off: the phone has left.
    await jest.advanceTimersByTimeAsync(3 * 60 * 60_000)
    await ingest([at(HOME.lat + 0.01, HOME.lon, Date.now())], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
    // One "still" now is a red light, not ninety seconds of stillness.
    verdict("still", 100)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().mode).toBe("moving")
  })

  it("keeps a drive through a still verdict at the lights, and parks it after the crawl's three minutes", async () => {
    await stopTracking()
    useTrackingStore.getState().setEnabled(true)
    ;(startMotion as jest.Mock).mockClear()
    await startTracking()
    const verdict = (startMotion as jest.Mock).mock.calls.at(-1)![0] as (
      a: string,
      c: number,
    ) => void
    await enterMoving()
    await enterDriving(30)
    verdict("still", 60)
    await jest.advanceTimersByTimeAsync(100_000)
    verdict("still", 60)
    await jest.advanceTimersByTimeAsync(0)
    expect(isDriving()).toBe(true)
    expect(useTrackingStore.getState().mode).toBe("moving")

    await jest.advanceTimersByTimeAsync(2 * 60_000)
    verdict("still", 60)
    await jest.advanceTimersByTimeAsync(0)
    expect(isDriving()).toBe(false)
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("registers nothing after a stop, even for a wake that was mid fix", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    let release: ((value: Location.LocationObject) => void) | null = null
    getPosition.mockImplementationOnce(
      () => new Promise<Location.LocationObject>((resolve) => (release = resolve)),
    )
    const wake = wakeFix()
    await jest.advanceTimersByTimeAsync(0)
    await stopTracking()
    start.mockClear()
    ;(release as unknown as (value: Location.LocationObject) => void)(
      at(HOME.lat, HOME.lon, Date.now()),
    )
    await wake
    expect(useTrackingStore.getState().mode).toBe("off")
    expect(start).not.toHaveBeenCalled()
  })

  it("promotes a drive from displacement when Android's fixes carry no speed", async () => {
    await enterMoving()
    const t0 = Date.now()
    await ingest([at(HOME.lat, HOME.lon, t0, null)], "background")
    // 300 m in 30 s is 10 m/s, whatever the fix says.
    await ingest([at(HOME.lat + 0.0027, HOME.lon, t0 + 30_000, null)], "background")
    expect(isDriving()).toBe(true)
  })

  it("dates the stop from the crawl, so a parked car is parked five minutes after it stopped", async () => {
    await enterMoving()
    await enterDriving(30)
    const t0 = Date.now()
    for (let i = 0; i <= 18; i += 1) {
      await ingest([at(HOME.lat, HOME.lon, t0 + i * 10_000, 0)], "background")
    }
    // Three minutes of crawling ends the drive, dated from its start.
    expect(isDriving()).toBe(false)
    expect(useTrackingStore.getState().stillAnchor?.since).toBe(new Date(t0).toISOString())
    await ingest([at(HOME.lat, HOME.lon, t0 + 5 * 60_000 + 1000, 0)], "background")
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("comes back to a moving phone without throwing its still clock away", async () => {
    await enterMoving()
    const since = new Date(Date.now() - 4 * 60_000).toISOString()
    useTrackingStore.setState({ stillAnchor: { ...HOME, since } })
    await stopTracking()
    useTrackingStore.getState().setEnabled(true)
    useTrackingStore.setState({ mode: "moving", stillAnchor: { ...HOME, since } })
    await startTracking()
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(useTrackingStore.getState().stillAnchor?.since).toBe(since)
  })

  it("runs nothing in the background on a phone with only While Using", async () => {
    await stopTracking()
    useTrackingStore.getState().setEnabled(true)
    ;(Location.getBackgroundPermissionsAsync as unknown as jest.Mock).mockResolvedValueOnce({
      status: "denied",
    })
    start.mockClear()
    expect(await startTracking()).toBe(false)
    expect(start).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("off")
  })
})

const at = (lat: number, lon: number, when: number, speed: number | null = 0, accuracy = 20) =>
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

describe("what a fix says the phone is doing", () => {
  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
  })

  it("says still when parked, driving on the GPS tier, and nothing it does not know", async () => {
    await enterMoving()
    await ingest([at(HOME.lat, HOME.lon, Date.now(), 0)], "background")
    expect(useTrackingStore.getState().queue.at(-1)?.activity).toBe("unknown")

    await enterDriving(30)
    await ingest([at(HOME.lat + 0.01, HOME.lon, Date.now(), 20)], "background")
    expect(useTrackingStore.getState().queue.at(-1)?.activity).toBe("driving")

    await enterStationary(HOME.lat, HOME.lon)
    await jest.advanceTimersByTimeAsync(0)
    expect(useTrackingStore.getState().queue.at(-1)?.activity).toBe("still")
  })
})

const mockUpload = jest.fn()
jest.mock("@/services/api", () => ({
  endpoints: { locations: { upload: (...args: unknown[]) => mockUpload(...args) } },
}))
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: { hydrate: async () => ({ accessToken: "a", refreshToken: "r" }), peek: () => null },
}))

describe("a watched phone learns so from its own upload", () => {
  const reply = (watchedUntil: string | null) => ({
    accepted: 1,
    rejected: 0,
    placeEvents: 0,
    serverTime: new Date().toISOString(),
    policy: { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 },
    watchedUntil,
  })
  const queued = () =>
    useTrackingStore
      .getState()
      .enqueue([
        { ...HOME, recordedAt: new Date().toISOString(), accuracyMeters: 10, source: "background" },
      ])

  beforeEach(() => {
    Platform.OS = "android"
    mockServiceStatus = "running"
    useAuthStore.getState().setServer("https://hearth.test", null as never)
  })

  it("goes live for the rest of the window the reply names", async () => {
    await enterMoving()
    start.mockClear()
    const until = new Date(Date.now() + 9 * 60_000).toISOString()
    mockUpload.mockResolvedValueOnce(reply(until))
    queued()

    await flush()

    expect(useTrackingStore.getState().watchedUntil).toBe(until)
    expect(start).toHaveBeenCalled()
    expect(optionsOf(start.mock.calls.length - 1).timeInterval).toBe(5_000)
  })

  it("stays as it was on a reply that names nobody", async () => {
    await enterMoving()
    start.mockClear()
    mockUpload.mockResolvedValueOnce(reply(null))
    queued()

    await flush()

    expect(useTrackingStore.getState().watchedUntil).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })

  it("extends a window it already holds without re-registering", async () => {
    await enterMoving()
    await enterWatched(600)
    start.mockClear()
    // The page asks again each minute, so every reply pushes the end out.
    const later = new Date(Date.now() + 600_000 + 60_000).toISOString()
    mockUpload.mockResolvedValueOnce(reply(later))
    queued()

    await flush()
    await jest.advanceTimersByTimeAsync(0)

    expect(start).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().watchedUntil).toBe(later)
  })

  it("measures the window by the server's clock, not the phone's", async () => {
    await enterMoving()
    start.mockClear()
    // The phone's clock is five minutes slow. The server says "until ten
    // minutes from my now"; the phone must hold it for ten minutes of its
    // own, not fifteen.
    const serverNow = Date.now() + 5 * 60_000
    mockUpload.mockResolvedValueOnce({
      ...reply(new Date(serverNow + 600_000).toISOString()),
      serverTime: new Date(serverNow).toISOString(),
    })
    queued()

    await flush()
    await jest.advanceTimersByTimeAsync(0)

    const held = Date.parse(useTrackingStore.getState().watchedUntil!) - Date.now()
    expect(held).toBeGreaterThan(595_000)
    expect(held).toBeLessThanOrEqual(600_000)
  })

  it("answers a watch with one fix while parked, as the push would", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    getPosition.mockClear()
    mockUpload.mockResolvedValueOnce(reply(new Date(Date.now() + 600_000).toISOString()))
    queued()

    await flush()
    // The reply is acted on beside the upload loop, not inside it, so a slow
    // fix cannot hold the next batch back.
    await jest.advanceTimersByTimeAsync(0)

    expect(getPosition).toHaveBeenCalled()
  })
})
