import { AppState } from "react-native"
import type { LocationFixInput } from "@hearth/shared"
import * as Location from "expo-location"

import { useTrackingStore } from "@/stores/tracking"

import {
  reportNow,
  startForegroundHeartbeat,
  stopForegroundHeartbeat,
  stopTracking,
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
    // Now, so a fix this call produces reads as fresh to the next tick, the
    // way a real acquisition does.
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

const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock
const INTERVAL_MS = 30_000

/** The last upload left this behind: nothing queued, one fix of the given age remembered. */
function seedLastFix(ageMs: number): LocationFixInput {
  const fix: LocationFixInput = {
    recordedAt: new Date(Date.now() - ageMs).toISOString(),
    lat: 51.4545,
    lon: -2.5879,
    accuracyMeters: 12,
    altitudeMeters: null,
    altitudeAccuracyMeters: null,
    speedMps: null,
    headingDegrees: null,
    batteryLevel: null,
    isCharging: null,
    source: "background",
  }
  useTrackingStore.getState().enqueue([fix])
  useTrackingStore.getState().dequeue([fix])
  return fix
}

/** A tick's acquisition runs behind the timer, so it needs the promise chain to drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Fires the timer once and waits for whatever it asked for to arrive. */
async function tick() {
  jest.advanceTimersByTime(INTERVAL_MS)
  await settle()
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate"] })
  AppState.currentState = "active"
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useTrackingStore.getState().setPermission("always")
  useTrackingStore.getState().setServicesEnabled(true)
  useTrackingStore.getState().setPolicy({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 40 })
  useTrackingStore.getState().setMode("moving")
  jest.clearAllMocks()
})

afterEach(() => {
  stopForegroundHeartbeat()
  jest.useRealTimers()
})

describe("the foreground heartbeat", () => {
  it("takes a cheap fix when the last one is older than the circle's interval", async () => {
    // Two minutes parked with the app open. The OS holds back every fix inside
    // the distance filter, so without this the row reads stale for good.
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await settle()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced })
    const { queue } = useTrackingStore.getState()
    expect(queue).toHaveLength(1)
    expect(queue[0]?.source).toBe("heartbeat")
  })

  it("leaves a fresh fix alone", async () => {
    seedLastFix(5_000)

    startForegroundHeartbeat()
    await settle()

    expect(getPosition).not.toHaveBeenCalled()
  })

  it("keeps the row fresh at the interval the circle chose", async () => {
    seedLastFix(0)
    startForegroundHeartbeat()

    await tick()
    await tick()

    expect(getPosition).toHaveBeenCalledTimes(2)
  })

  it("follows a changed interval without a restart", async () => {
    seedLastFix(0)
    startForegroundHeartbeat()
    useTrackingStore
      .getState()
      .setPolicy({ minUpdateIntervalSeconds: 300, distanceFilterMeters: 150 })

    // The 30 s timer already armed fires once and reads the new policy: the
    // fix is 30 s old against a 5 min interval, so nothing is asked for, and
    // the next timer is armed for the new interval rather than the old one.
    await tick()
    expect(getPosition).not.toHaveBeenCalled()

    // A fix this stale is one any tick would act on, so the only thing keeping
    // the count at zero until the new interval is up is that no timer fires.
    seedLastFix(10 * 60_000)
    jest.advanceTimersByTime(5 * 60_000 - 1_000)
    await settle()
    expect(getPosition).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await settle()
    expect(getPosition).toHaveBeenCalledTimes(1)
  })

  it("reports from a parked phone without waking it up", async () => {
    // Stationary means the foreground service is off and a fence is armed.
    // Bringing either back for a phone that has not moved is the cost that
    // mode exists to avoid, and it would also reset the stillness clock.
    const anchor = { lat: 51.4545, lon: -2.5879, since: new Date().toISOString() }
    useTrackingStore.getState().setMode("stationary")
    useTrackingStore.getState().setStillAnchor(anchor)
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await settle()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().queue[0]?.source).toBe("heartbeat")
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(Location.startGeofencingAsync).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().mode).toBe("stationary")
    expect(useTrackingStore.getState().stillAnchor).toEqual(anchor)
  })

  it("stops with the heartbeat", async () => {
    seedLastFix(0)
    startForegroundHeartbeat()
    await tick()
    expect(getPosition).toHaveBeenCalledTimes(1)

    stopForegroundHeartbeat()
    await tick()
    await tick()

    expect(getPosition).toHaveBeenCalledTimes(1)
  })

  it("stops with tracking", async () => {
    // Sign-out, a server change and a deleted account all go through
    // stopTracking, and none of them pass back through the AppState listener.
    seedLastFix(0)
    startForegroundHeartbeat()
    await tick()
    expect(getPosition).toHaveBeenCalledTimes(1)

    await stopTracking()

    // The mode gate alone would keep the count at one. The timer itself has to go.
    expect(jest.getTimerCount()).toBe(0)
    await tick()
    await tick()
    expect(getPosition).toHaveBeenCalledTimes(1)
  })

  it("does not pin a failed fix on the You screen", async () => {
    // reportNow writes its failure to lastError, which YouScreen shows in red
    // until the next upload clears it. A fix that times out indoors would do
    // that every interval.
    getPosition.mockRejectedValueOnce(new Error("Location request timed out"))
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await settle()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(useTrackingStore.getState().lastError).toBeNull()
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  it("gives up on a fix the OS never answers", async () => {
    // Android's getCurrentPositionAsync has no timeout of its own. Without one
    // here, the fix left hanging would read as fresh to every tick after it.
    getPosition.mockReturnValueOnce(new Promise(() => {}))
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await settle()
    expect(getPosition).toHaveBeenCalledTimes(1)

    // The deadline and the next tick land together, and a request past its
    // deadline no longer counts as in flight, so that tick asks.
    await tick()

    expect(getPosition).toHaveBeenCalledTimes(2)
    expect(useTrackingStore.getState().lastError).toBeNull()
  })

  it("asks for nothing without permission", async () => {
    useTrackingStore.getState().setPermission("denied")
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await tick()

    expect(getPosition).not.toHaveBeenCalled()
  })

  it("asks for nothing while the app is away", async () => {
    AppState.currentState = "background"
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await tick()

    expect(getPosition).not.toHaveBeenCalled()
  })

  it("asks for nothing while sharing is off", async () => {
    useTrackingStore.getState().setMode("off")
    seedLastFix(2 * 60_000)

    startForegroundHeartbeat()
    await tick()

    expect(getPosition).not.toHaveBeenCalled()
    // A signed-out phone comes to the foreground too. No timer for it to idle on.
    expect(jest.getTimerCount()).toBe(0)
  })

  it("counts a fix already on its way as fresh", async () => {
    // startTracking fires its launch fix and then starts the heartbeat, whose
    // first tick would otherwise ask for a second one right behind it.
    seedLastFix(2 * 60_000)
    const launch = reportNow("foreground")
    startForegroundHeartbeat()
    await launch
    await settle()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.High })
  })
})
