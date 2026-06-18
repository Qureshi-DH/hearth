import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"

import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"

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
  // Whichever way movement is worked out, the crash detector needs the OS
  // classifier, so this is the switch that asks for the motion watch.
  useSettingsStore.getState().setIncidentDetection(true)
  useSettingsStore.getState().setNativeMotion(false)
  useTrackingStore.getState().setEnabled(true)
  await stopTracking()
  jest.clearAllMocks()
})

describe("background wakes", () => {
  it("watches motion after a geofence exit wakes a process that never mounted", async () => {
    // Parking stops the foreground service so Android can reclaim the process.
    // Leaving relaunches it straight into this task, which brings the location
    // pipeline back but not the classifier, so crash detection stays off for
    // the whole journey that follows and the settings screen still reads on.
    const wake = taskBodies.get(STATIONARY_GEOFENCE_TASK)
    expect(wake).toBeDefined()

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
  it("watches motion when the app itself asks for it", async () => {
    await refreshMotionWatch()

    expect(startMotion).toHaveBeenCalled()
  })

  it("releases the drive sensors when incident detection is switched off", async () => {
    // Sampling at 50 Hz is only worth its battery while a crash could still be
    // reported. Dropping the motion watch is what makes this the last chance to
    // stop: with no classifier left to report a change, nothing calls the stop
    // again until the phone has been parked for five minutes.
    useSettingsStore.getState().setIncidentDetection(false)

    await refreshMotionWatch()

    expect(stopMotion).toHaveBeenCalled()
    expect(stopDriveSensors).toHaveBeenCalled()
  })
})
