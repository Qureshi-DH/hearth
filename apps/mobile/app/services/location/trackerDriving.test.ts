import * as Location from "expo-location"
import { Platform } from "react-native"

import { useTrackingStore } from "@/stores/tracking"

import { startMotion } from "./motion"
import {
  DRIVING_INTERVAL_MS,
  drivingDistanceMeters,
  enterStationary,
  ingest,
  isDriving,
  startTracking,
  stationaryRadiusMeters,
  stopTracking,
} from "./tracker"

/**
 * MMKV outlives the process, and half of what is under test here is what a
 * freshly launched process reads back. The mock that ships with the library
 * hands out a new Map per instance, so a re-imported store would find an empty
 * disk. This one hangs off the global so a fresh module registry finds it.
 */
interface TestDisk {
  __hearthDisk: Map<string, string>
  __hearthWrites: { key: string; bytes: number }[]
}

jest.mock("react-native-mmkv", () => {
  const shared = globalThis as unknown as TestDisk
  shared.__hearthDisk ??= new Map<string, string>()
  shared.__hearthWrites ??= []
  const disk = shared.__hearthDisk
  const writes = shared.__hearthWrites
  return {
    MMKV: class {
      getString(key: string) {
        return disk.get(key)
      }
      set(key: string, value: string) {
        disk.set(key, String(value))
        writes.push({ key, bytes: String(value).length })
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

jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 1 },
  getStatusAsync: jest.fn(async () => 1),
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
}))

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4, Highest: 6 },
  ActivityType: { Other: 1 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  hasStartedGeofencingAsync: jest.fn(async () => true),
  startGeofencingAsync: jest.fn(async () => {}),
  stopGeofencingAsync: jest.fn(async () => {}),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  startLocationUpdatesAsync: jest.fn(async () => {}),
  stopLocationUpdatesAsync: jest.fn(async () => {}),
  getLastKnownPositionAsync: jest.fn(async () => null),
  hasServicesEnabledAsync: jest.fn(async () => true),
  getCurrentPositionAsync: jest.fn(async () => ({
    // Now, so a fix this call produces reads as fresh to the staleness check,
    // the way a real acquisition does.
    timestamp: Date.now(),
    coords: {
      latitude: 51.4545,
      longitude: -2.5879,
      altitude: 0,
      accuracy: 20,
      altitudeAccuracy: 5,
      heading: -1,
      speed: -1,
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

const HOME = { lat: 51.4545, lon: -2.5879 }
const start = Location.startLocationUpdatesAsync as unknown as jest.Mock

function sample(lat: number, lon: number, at: number, speed: number): Location.LocationObject {
  return {
    timestamp: at,
    coords: {
      latitude: lat,
      longitude: lon,
      altitude: 0,
      accuracy: 10,
      altitudeAccuracy: 5,
      heading: 90,
      speed,
    },
  }
}

/** Options of the most recent (re)registration of the location task. */
function lastOptions(): Location.LocationTaskOptions {
  const call = start.mock.calls[start.mock.calls.length - 1] as [
    string,
    Location.LocationTaskOptions,
  ]
  return call[1]
}

/** The classifier callback the tracker handed to startMotion. */
function classifier(): (activity: string, confidence: number) => Promise<void> {
  const calls = (startMotion as jest.Mock).mock.calls
  return calls[calls.length - 1]![0]
}

describe("the driving tier", () => {
  beforeEach(async () => {
    start.mockClear()
    ;(startMotion as jest.Mock).mockClear()
    useTrackingStore.getState().reset()
    useTrackingStore.getState().setEnabled(true)
    await startTracking()
    // startTracking asks for a launch fix in the background. Let it land, then
    // forget it, or thin() reads the first test fix as its near duplicate.
    await new Promise((resolve) => setTimeout(resolve, 0))
    useTrackingStore.setState({ queue: [], lastFix: null })
    start.mockClear()
  })

  afterEach(async () => {
    await stopTracking()
  })

  it("scales the filter with speed in steps, within bounds", () => {
    expect(drivingDistanceMeters(null)).toBe(30)
    expect(drivingDistanceMeters(15)).toBe(150)
    expect(drivingDistanceMeters(17)).toBe(150)
    expect(drivingDistanceMeters(30)).toBe(300)
    expect(drivingDistanceMeters(45)).toBe(300)
  })

  // Speed and heading only come from GPS, and the walking tier never turns
  // it on, so a driver's speed read as noise and their dot sat off the road.
  it("turns the GPS on from speed alone, for a phone with no motion permission", async () => {
    const t0 = Date.now()
    await ingest([sample(HOME.lat, HOME.lon, t0, 15)], "background")
    expect(isDriving()).toBe(true)
    const options = lastOptions()
    expect(options.accuracy).toBe(Location.Accuracy.High)
    expect(options.timeInterval).toBe(DRIVING_INTERVAL_MS)
    expect(options.distanceInterval).toBe(150)
    expect(options.deferredUpdatesInterval).toBeUndefined()
  })

  it("rebuilds the request only when the speed crosses into another step", async () => {
    const t0 = Date.now()
    await ingest([sample(HOME.lat, HOME.lon, t0, 15)], "background")
    start.mockClear()
    await ingest([sample(HOME.lat + 0.002, HOME.lon, t0 + 10_000, 16)], "background")
    expect(start).not.toHaveBeenCalled()
    await ingest([sample(HOME.lat + 0.004, HOME.lon, t0 + 20_000, 31)], "background")
    expect(lastOptions().distanceInterval).toBe(300)
  })

  it("comes off the GPS after three minutes of crawling", async () => {
    const t0 = Date.now()
    await ingest([sample(HOME.lat, HOME.lon, t0, 15)], "background")
    await ingest([sample(HOME.lat + 0.001, HOME.lon, t0 + 60_000, 1)], "background")
    expect(isDriving()).toBe(true)
    await ingest([sample(HOME.lat + 0.001, HOME.lon, t0 + 4 * 60_000, 0.5)], "background")
    expect(isDriving()).toBe(false)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.Balanced)
  })

  it("follows the classifier into a drive and out of it", async () => {
    await classifier()("automotive", 90)
    expect(isDriving()).toBe(true)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.High)
    await classifier()("walking", 90)
    expect(isDriving()).toBe(false)
    expect(lastOptions().accuracy).toBe(Location.Accuracy.Balanced)
  })

  it("ends the drive when the phone parks", async () => {
    await classifier()("automotive", 90)
    await enterStationary(HOME.lat, HOME.lon)
    expect(isDriving()).toBe(false)
  })
})

describe("the exit fence", () => {
  const policy = { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 }
  const os = Platform.OS
  afterEach(() => {
    Platform.OS = os
  })

  it("is wide enough for iOS to notice an exit", () => {
    Platform.OS = "ios"
    expect(stationaryRadiusMeters(policy)).toBe(200)
    Platform.OS = "android"
    expect(stationaryRadiusMeters(policy)).toBe(150)
  })
})
