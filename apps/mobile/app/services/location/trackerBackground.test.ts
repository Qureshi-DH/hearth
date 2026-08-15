import type { LocationFixInput } from "@hearth/shared"
import * as BackgroundTask from "expo-background-task"
import * as TaskManager from "expo-task-manager"
import * as Location from "expo-location"

import { useTrackingStore } from "@/stores/tracking"
import { storage } from "@/utils/storage"

import {
  BACKGROUND_SYNC_TASK,
  enterStationary,
  ingest,
  RESTING_HEARTBEAT_MS,
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

const shared = globalThis as unknown as TestDisk
const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock
const unregisterTask = BackgroundTask.unregisterTaskAsync as unknown as jest.Mock

type TaskBody = (body: { data: unknown; error: { message: string } | null }) => Promise<unknown>

function syncTaskOf(defineTask: jest.Mock<void, [string, TaskBody]>): TaskBody {
  const registered = defineTask.mock.calls.filter(([name]) => name === BACKGROUND_SYNC_TASK)
  const last = registered[registered.length - 1]
  if (!last) throw new Error("the sync task was never registered")
  return last[1]
}

/**
 * Captured at import, because the tracker registers its tasks the moment it
 * loads: the OS can hand a background event to a process that mounted nothing.
 */
const syncTask = syncTaskOf(
  TaskManager.defineTask as unknown as jest.Mock<void, [string, TaskBody]>,
)

/**
 * A relaunch. A parked phone runs no foreground service, so Android reclaims
 * the process and the next sync wake starts a runtime whose only memory of the
 * last one is the disk.
 */
function relaunch(): { store: typeof useTrackingStore; task: TaskBody } {
  const launched: { store: typeof useTrackingStore; task: TaskBody }[] = []
  jest.isolateModules(() => {
    require("./tracker")
    launched.push({
      store: require("@/stores/tracking").useTrackingStore,
      task: syncTaskOf(require("expo-task-manager").defineTask),
    })
  })
  if (launched.length === 0) throw new Error("the process did not come back")
  return launched[0]
}

const fix = (i: number): LocationFixInput => ({
  recordedAt: new Date(Date.UTC(2026, 0, 1) + i * 30_000).toISOString(),
  lat: 51.4545 + i * 0.0001,
  lon: -2.5879 + i * 0.0001,
  accuracyMeters: 12.345,
  altitudeMeters: 43.21,
  altitudeAccuracyMeters: 3.5,
  speedMps: 13.4,
  headingDegrees: 271.5,
  batteryLevel: 0.87,
  isCharging: false,
  source: "background",
})

beforeEach(() => {
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useTrackingStore.getState().setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 })
  shared.__hearthWrites.length = 0
  jest.clearAllMocks()
})

describe("a signed-out phone", () => {
  it("does not wake the receiver on a sync, however long it sits there", async () => {
    // The literal sign-out sequence. YouScreen, PrivacyDataScreen and
    // onSessionExpired all call stopTracking(), and none of them touch
    // `enabled`, which is the user's switch rather than the session's.
    await stopTracking()
    useTrackingStore.getState().reset()
    expect(useTrackingStore.getState().enabled).toBe(true)
    expect(useTrackingStore.getState().mode).toBe("off")

    await syncTask({ data: null, error: null })

    expect(getPosition).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  it("cancels the periodic wake when tracking stops", async () => {
    await stopTracking()

    expect(unregisterTask).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK)
  })
})

describe("the parked heartbeat", () => {
  it("throttles the drift check across a relaunch", async () => {
    useTrackingStore.getState().setMode("stationary")
    useTrackingStore
      .getState()
      .setStillAnchor({ lat: 51.4545, lon: -2.5879, since: new Date().toISOString() })

    await syncTask({ data: null, error: null })
    expect(getPosition).toHaveBeenCalledTimes(1)

    // The throttle used to be a module-scoped timestamp, so it read as zero in
    // every fresh runtime and the check ran on every wake instead of hourly.
    const restarted = relaunch()
    expect(restarted.store.getState().lastDriftCheckAt).not.toBeNull()
    expect(restarted.store.getState().mode).toBe("stationary")
    getPosition.mockClear()

    await restarted.task({ data: null, error: null })

    expect(getPosition).not.toHaveBeenCalled()
  })

  it("asks for the cheap fix the drift check next to it asks for", async () => {
    // No anchor, so neither the drift check nor the stillness pass runs and the
    // staleness heartbeat is the only thing left that can acquire a position.
    useTrackingStore.getState().setMode("stationary")
    expect(useTrackingStore.getState().lastFix).toBeNull()

    await syncTask({ data: null, error: null })

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced })
  })
})

describe("the resting watch", () => {
  // Android's. A parked iPhone runs a cell-only session instead, see trackerWake.
  const { Platform } = require("react-native") as { Platform: { OS: string } }
  const os = Platform.OS
  beforeAll(() => {
    Platform.OS = "android"
  })
  afterAll(() => {
    Platform.OS = os
  })
  const HOME = { lat: 51.4545, lon: -2.5879 }
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
  const start = Location.startLocationUpdatesAsync as unknown as jest.Mock

  beforeEach(() => {
    start.mockClear()
    ;(Location.stopLocationUpdatesAsync as unknown as jest.Mock).mockClear()
    useTrackingStore.getState().reset()
    useTrackingStore.setState({ enabled: true, mode: "moving" })
  })

  // Stopping the service left the next word to the OS task schedulers, and
  // both of them let a parked phone sit for hours.
  it("steps the request down rather than stopping it when the phone parks", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    const [, options] = start.mock.calls[0] as [string, Location.LocationTaskOptions]
    expect(options.accuracy).toBe(Location.Accuracy.Balanced)
    expect(options.timeInterval).toBe(RESTING_HEARTBEAT_MS)
    expect(options.pausesUpdatesAutomatically).toBe(false)
    // No service while parked, so no notification stays in the shade. The
    // family accepts one that shows for the second a wake's fix takes.
    expect(options.foregroundService).toBeUndefined()
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("shows one plain notification while moving, and never colours it", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    await ingest([sample(HOME.lat + 0.005, HOME.lon, Date.now())], "background")
    const [, options] = start.mock.calls[0] as [string, Location.LocationTaskOptions]
    expect(options.foregroundService).toMatchObject({
      notificationTitle: "Hearth",
      notificationBody: "Updating your location",
    })
    expect(options.foregroundService?.notificationColor).toBeUndefined()
  })

  it("passes one fix per heartbeat while the phone stays put, and drops the rest", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    // The arrival fix has just said "here", so the first resting fix worth
    // keeping is a heartbeat later.
    const t0 = Date.now() + RESTING_HEARTBEAT_MS
    await ingest([sample(HOME.lat, HOME.lon, t0)], "background")
    expect(useTrackingStore.getState().lastFix?.recordedAt).toBe(new Date(t0).toISOString())

    // Two minutes later, still here: iOS chatter, not news.
    await ingest([sample(HOME.lat + 0.0001, HOME.lon, t0 + 2 * 60_000)], "background")
    expect(useTrackingStore.getState().lastFix?.recordedAt).toBe(new Date(t0).toISOString())

    // A quarter hour later it is the heartbeat.
    const t1 = t0 + RESTING_HEARTBEAT_MS
    await ingest([sample(HOME.lat, HOME.lon, t1)], "background")
    expect(useTrackingStore.getState().lastFix?.recordedAt).toBe(new Date(t1).toISOString())
    expect(useTrackingStore.getState().mode).toBe("stationary")
  })

  it("brings the full service back when a resting fix shows the phone has left", async () => {
    await enterStationary(HOME.lat, HOME.lon)
    start.mockClear()
    // Half a kilometre away, well outside any stationary radius.
    await ingest([sample(HOME.lat + 0.005, HOME.lon, Date.now())], "background")
    expect(useTrackingStore.getState().mode).toBe("moving")
    expect(start).toHaveBeenCalled()
    const [, options] = start.mock.calls[0] as [string, Location.LocationTaskOptions]
    expect(options.timeInterval).not.toBe(RESTING_HEARTBEAT_MS)
    const sources = useTrackingStore.getState().queue.map((fix) => fix.source)
    expect(sources).toContain("background")
  })
})

describe("the persisted queue", () => {
  const queueBytes = () =>
    Array.from(shared.__hearthDisk.entries())
      .filter(([key]) => key.startsWith("hearth.tracking.queue.v1"))
      .reduce((total, [, value]) => total + value.length, 0)

  const bytesWritten = () => shared.__hearthWrites.reduce((total, write) => total + write.bytes, 0)

  it("keeps a backlog out of every write that is not about the backlog", () => {
    useTrackingStore.getState().enqueue(Array.from({ length: 1500 }, (_, i) => fix(i)))
    expect(queueBytes()).toBeGreaterThan(200_000)

    shared.__hearthWrites.length = 0
    useTrackingStore.getState().setError("offline")
    useTrackingStore
      .getState()
      .setStillAnchor({ lat: 51.4, lon: -2.5, since: "2026-01-01T00:00:00.000Z" })
    useTrackingStore.getState().setMode("moving")
    useTrackingStore.getState().recordUpload(0)

    expect(bytesWritten()).toBeLessThan(4_000)
    expect(
      shared.__hearthWrites.some((write) => write.key.startsWith("hearth.tracking.queue.v1")),
    ).toBe(false)
  })

  it("writes a chunk rather than the whole backlog when a fix arrives", () => {
    useTrackingStore.getState().enqueue(Array.from({ length: 1500 }, (_, i) => fix(i)))
    const backlog = queueBytes()

    shared.__hearthWrites.length = 0
    useTrackingStore.getState().enqueue([fix(1500)])

    expect(bytesWritten()).toBeLessThan(backlog / 8)
  })

  it("survives a relaunch with the queue it was holding", () => {
    const model: LocationFixInput[] = []
    for (let batch = 0; batch < 9; batch++) {
      const fixes = Array.from({ length: 47 }, (_, i) => fix(batch * 47 + i))
      model.push(...fixes)
      useTrackingStore.getState().enqueue(fixes)
    }
    // A span that crosses chunk boundaries at both ends, which is what an
    // upload of MAX_BATCH looks like against a 100-deep chunk.
    const sent = model.slice(30, 260)
    useTrackingStore.getState().dequeue(sent)
    const expected = model.filter((f) => !sent.includes(f))

    expect(useTrackingStore.getState().queue).toEqual(expected)

    const restarted = relaunch()
    expect(restarted.store.getState().queue).toEqual(expected)
    expect(restarted.store.getState().lastFix).toEqual(model[model.length - 1])
  })

  it("keeps the newest fixes when the cap is passed, and only those", () => {
    const model = Array.from({ length: 2100 }, (_, i) => fix(i))
    for (let i = 0; i < model.length; i += 7) {
      useTrackingStore.getState().enqueue(model.slice(i, i + 7))
    }

    expect(useTrackingStore.getState().queue).toEqual(model.slice(-2000))
    expect(relaunch().store.getState().queue).toEqual(model.slice(-2000))
  })

  it("leaves nothing on disk for the next account to upload", () => {
    useTrackingStore.getState().enqueue(Array.from({ length: 250 }, (_, i) => fix(i)))
    expect(queueBytes()).toBeGreaterThan(0)

    useTrackingStore.getState().reset()

    expect(queueBytes()).toBe(0)
    const restarted = relaunch()
    expect(restarted.store.getState().queue).toEqual([])
    expect(restarted.store.getState().lastFix).toBeNull()
  })

  it("sweeps a chunk a kill left behind before the index adopted it", () => {
    useTrackingStore.getState().enqueue([fix(0)])
    storage.set("hearth.tracking.queue.v1.999", JSON.stringify([fix(1)]))

    const restarted = relaunch()

    expect(restarted.store.getState().queue).toEqual([fix(0)])
    expect(shared.__hearthDisk.has("hearth.tracking.queue.v1.999")).toBe(false)
  })

  it("carries a queue written before the split over to the new keys", () => {
    // An install that upgrades while it is offline is exactly the one holding a
    // backlog, so dropping the old shape would throw away the fixes that matter
    // most. Leaving the old blob in charge is no better: nothing writes it any
    // more, so every launch would resurrect the same stale queue.
    const waiting = [fix(0), fix(1), fix(2)]
    shared.__hearthDisk.clear()
    shared.__hearthDisk.set(
      "hearth.tracking.v1",
      JSON.stringify({
        state: { enabled: true, queue: waiting, lastFix: waiting[2] },
        version: 0,
      }),
    )

    const upgraded = relaunch()
    expect(upgraded.store.getState().queue).toEqual(waiting)
    expect(upgraded.store.getState().lastFix).toEqual(waiting[2])

    upgraded.store.getState().enqueue([fix(3)])

    expect(relaunch().store.getState().queue).toEqual([...waiting, fix(3)])
  })
})
