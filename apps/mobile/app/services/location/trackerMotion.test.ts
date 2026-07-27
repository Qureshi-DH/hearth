import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"

import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"
import { storage } from "@/utils/storage"

import { stopDriveSensors } from "./driveSensors"
import { startMotion, stopMotion } from "./motion"
import {
  BACKGROUND_SYNC_TASK,
  enterStationary,
  ingest,
  refreshMotionWatch,
  stopTracking,
  STATIONARY_GEOFENCE_TASK,
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
}))

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4, Highest: 6 },
  ActivityType: { Other: 1 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "denied" })),
  hasStartedGeofencingAsync: jest.fn(async () => true),
  startGeofencingAsync: jest.fn(async () => {}),
  stopGeofencingAsync: jest.fn(async () => {}),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  startLocationUpdatesAsync: jest.fn(async () => {}),
  stopLocationUpdatesAsync: jest.fn(async () => {}),
  getCurrentPositionAsync: jest.fn(async () => ({
    timestamp: Date.UTC(2026, 0, 1, 8, 0),
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

type TaskBody = (body: { data: unknown; error: { message: string } | null }) => Promise<unknown>

/**
 * The tracker registers these at import time, because the OS hands a background
 * event to whatever process it had to launch to receive it. Captured here so a
 * test can play the OS and deliver one.
 */
const taskBodies = new Map(
  (TaskManager.defineTask as unknown as jest.Mock<void, [string, TaskBody]>).mock.calls,
)

beforeEach(async () => {
  // Nothing asks for the classifier. It runs because tracking does, and the
  // suite below holds that with no setting on at all.
  useSettingsStore.getState().setIncidentDetection(false)
  useTrackingStore.getState().setEnabled(true)
  await stopTracking()
  jest.clearAllMocks()
})

describe("background wakes", () => {
  it("watches motion after a geofence exit wakes a process that never mounted", async () => {
    // Parking stops the foreground service so Android can reclaim the process.
    // Leaving relaunches it straight into this task, which used to bring the
    // location pipeline back but not the classifier, so the journey that
    // followed ran on the slow GPS heuristic with crash detection off.
    const wake = taskBodies.get(STATIONARY_GEOFENCE_TASK)
    expect(wake).toBeDefined()
    // What the relaunched process reads back from disk: a parked phone.
    useTrackingStore.setState({
      mode: "stationary",
      stillAnchor: { lat: 51.4545, lon: -2.5879, since: new Date().toISOString() },
    })

    await wake?.({ data: { eventType: Location.GeofencingEventType.Exit }, error: null })

    // The location half of the journey does come back, which is why nothing
    // about this looks broken from the map.
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalled()
    expect(startMotion).toHaveBeenCalled()
  })
})

describe("parking", () => {
  it("remembers the spot it armed the fence around", async () => {
    // Everything that looks after a parked phone reads stillAnchor, not the
    // fence: the periodic re-arm, the drift check and the relaunch path all
    // skip a stationary phone whose anchor is null, which is what the motion
    // classifier left behind whenever it called the stop.
    await enterStationary(51.4545, -2.5879)

    expect(useTrackingStore.getState().stillAnchor).toMatchObject({
      lat: 51.4545,
      lon: -2.5879,
    })
  })

  it("reports the fix the drift check woke the GPS for", async () => {
    useTrackingStore.getState().reset()
    useTrackingStore.getState().setEnabled(true)
    useTrackingStore.getState().setMode("stationary")
    // Anchored where the mocked fix reads, so the phone has not drifted far
    // enough to call the stop over. Waking the GPS cost the same either way.
    useTrackingStore
      .getState()
      .setStillAnchor({ lat: 51.4545, lon: -2.5879, since: new Date().toISOString() })

    const sweep = taskBodies.get(BACKGROUND_SYNC_TASK)
    expect(sweep).toBeDefined()
    await sweep?.({ data: null, error: null })

    expect(useTrackingStore.getState().queue).toHaveLength(1)
  })

  it("calls the stop on fixes spaced at the circle's own distance filter", async () => {
    useTrackingStore.getState().reset()
    useTrackingStore.getState().setEnabled(true)
    useTrackingStore
      .getState()
      .setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 100 })
    useTrackingStore.getState().setMode("moving")
    useTrackingStore.getState().setStillAnchor({
      lat: 51.4545,
      lon: -2.5879,
      since: new Date(Date.UTC(2026, 0, 1, 8, 0)).toISOString(),
    })

    // ~100 m from the anchor six minutes later. The OS holds back anything
    // closer than the filter, so this is the nearest fix a circle set that way
    // can ever deliver: measured against a fixed 60 m radius every fix it will
    // ever see reads as movement, and the service runs until something else
    // stops it.
    await ingest(
      [
        {
          timestamp: Date.UTC(2026, 0, 1, 8, 6),
          coords: {
            latitude: 51.45539,
            longitude: -2.5879,
            altitude: 0,
            accuracy: 20,
            altitudeAccuracy: 5,
            heading: -1,
            speed: -1,
          },
        } as Location.LocationObject,
      ],
      "background",
    )

    expect(useTrackingStore.getState().mode).toBe("stationary")
  })
})

describe("motion watch", () => {
  it("watches motion with no setting asking for it", async () => {
    useTrackingStore.getState().setMode("moving")

    await refreshMotionWatch()

    expect(startMotion).toHaveBeenCalled()
  })

  it("leaves the classifier alone while sharing is off", async () => {
    // A circles refetch and the checklist's Allow both land here, and neither
    // knows whether tracking is running. Starting the classifier on a phone
    // that paused sharing would leave a native subscription nobody consumes
    // and nothing stops until the next stopTracking.
    expect(useTrackingStore.getState().mode).toBe("off")

    await refreshMotionWatch()

    expect(startMotion).not.toHaveBeenCalled()
  })

  it("releases the drive sensors when incident detection is switched off", async () => {
    // Sampling at 50 Hz is only worth its battery while a crash could still be
    // reported, and once the setting is off the motion callback only stops them
    // at the next classified change, which mid drive can be the end of the
    // journey. The classifier itself stays: the location side needs it whether
    // or not anyone is listening for a crash.
    useTrackingStore.getState().setMode("moving")
    useSettingsStore.getState().setIncidentDetection(false)

    await refreshMotionWatch()

    expect(stopDriveSensors).toHaveBeenCalled()
    expect(stopMotion).not.toHaveBeenCalled()
  })

  it("tries again after a start that found the permission missing", async () => {
    // The tracker only checks, so a launch before the checklist has asked
    // leaves no subscription behind. That is what lets the grant on the
    // checklist bring the classifier up without restarting tracking.
    useTrackingStore.getState().setMode("moving")
    ;(startMotion as jest.Mock).mockResolvedValueOnce(null)

    await refreshMotionWatch()
    expect(startMotion).toHaveBeenCalledTimes(1)

    await refreshMotionWatch()
    expect(startMotion).toHaveBeenCalledTimes(2)
  })
})

describe("a wake with the permission still undetermined", () => {
  it("never raises the OS dialog", async () => {
    // A geofence exit can be the first thing to run in a process the OS
    // launched with no Activity. Android answers a request made from there as
    // denied without showing anything, and the module then reports denied for
    // good, so the tracker has to go through the real motion.ts here rather
    // than the mock the rest of the file uses.
    const wake = {
      isAvailableAsync: jest.fn(async () => true),
      getPermissionAsync: jest.fn(async () => "undetermined"),
      requestPermissionAsync: jest.fn(async () => "granted"),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
      startUpdatesAsync: jest.fn(async () => {}),
      stopUpdatesAsync: jest.fn(async () => {}),
    }
    const launched: { task: TaskBody; store: typeof useTrackingStore }[] = []
    jest.isolateModules(() => {
      jest.dontMock("./motion")
      jest.doMock("../../../modules/hearth-motion", () => ({ default: wake }))
      require("./tracker")
      const defineTask = require("expo-task-manager").defineTask as jest.Mock<
        void,
        [string, TaskBody]
      >
      const task = new Map(defineTask.mock.calls).get(STATIONARY_GEOFENCE_TASK)
      if (task) launched.push({ task, store: require("@/stores/tracking").useTrackingStore })
    })
    const fresh = launched[0]
    expect(fresh).toBeDefined()
    fresh.store.getState().setEnabled(true)
    fresh.store.setState({
      mode: "stationary",
      stillAnchor: { lat: 51.4545, lon: -2.5879, since: new Date().toISOString() },
    })

    await fresh.task({ data: { eventType: Location.GeofencingEventType.Exit }, error: null })

    expect(wake.getPermissionAsync).toHaveBeenCalled()
    expect(wake.requestPermissionAsync).not.toHaveBeenCalled()
    expect(wake.startUpdatesAsync).not.toHaveBeenCalled()
  })
})

describe("the update that put motion on the checklist", () => {
  it("walks an install that had finished onboarding through it again", async () => {
    // The checklist opens itself once per install and never again, so a phone
    // that finished it before the motion row existed would run GPS-only until
    // somebody found the screen by hand.
    useTrackingStore.getState().reset()
    storage.set(
      "hearth.tracking.v1",
      JSON.stringify({ state: { enabled: true, onboardedPermissions: true }, version: 1 }),
    )

    await useTrackingStore.persist.rehydrate()

    expect(useTrackingStore.getState().onboardedPermissions).toBe(false)
  })

  it("does the same for a blob from before the queue moved out", async () => {
    useTrackingStore.getState().reset()
    storage.set(
      "hearth.tracking.v1",
      JSON.stringify({ state: { enabled: true, onboardedPermissions: true }, version: 0 }),
    )

    await useTrackingStore.persist.rehydrate()

    expect(useTrackingStore.getState().onboardedPermissions).toBe(false)
  })
})
