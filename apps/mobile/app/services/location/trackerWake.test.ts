import { AppState, Platform } from "react-native"
import * as Location from "expo-location"

import { useTrackingStore } from "@/stores/tracking"

import {
  enterDriving,
  enterMoving,
  enterStationary,
  enterWatched,
  ingest,
  isDriving,
  reassertService,
  RESTING_HEARTBEAT_MS,
  startBackgroundClock,
  stopBackgroundClock,
  stopTracking,
  wakeFix,
} from "./tracker"

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
    expect(useTrackingStore.getState().stillAnchor).toBeNull()
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
    expect(optionsOf(0).distanceInterval).toBe(5)

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

  it("never calls a stop while the tracker believes the phone is driving", async () => {
    // A queue of traffic: the same spot for five minutes, still rolling.
    await enterMoving()
    await enterDriving(30)
    mockSpeed = 3
    const t0 = Date.now()
    await ingest(
      [
        {
          ...sample(HOME.lat, HOME.lon, t0),
          coords: { ...sample(HOME.lat, HOME.lon, t0).coords, speed: 3 },
        },
      ],
      "background",
    )
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(isDriving()).toBe(true)
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(Location.startGeofencingAsync).not.toHaveBeenCalled()
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
