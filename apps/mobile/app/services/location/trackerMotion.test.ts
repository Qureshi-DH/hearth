import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"

import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"

import { stopDriveSensors } from "./driveSensors"
import { startMotion, stopMotion } from "./motion"
import { refreshMotionWatch, stopTracking, STATIONARY_GEOFENCE_TASK } from "./tracker"

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => true),
}))

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4, Highest: 6 },
  ActivityType: { Other: 1 },
  GeofencingEventType: { Enter: 1, Exit: 2 },
  hasStartedGeofencingAsync: jest.fn(async () => true),
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
