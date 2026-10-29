import { AppState, Platform } from "react-native"
import type { LocationFixInput } from "@hearth/shared"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"

import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"

import { checkIncident } from "@/services/incidentAlarm"

import { startDriveSensors, stopDriveSensors } from "./driveSensors"

import { clearTrackerLog } from "./log"
import {
  answerWake,
  BACKGROUND_LOCATION_TASK,
  BACKGROUND_SYNC_TASK,
  enterWatched,
  processNativeQueue,
  startForegroundHeartbeat,
  startTracking,
  stopForegroundHeartbeat,
  stopTracking,
  wakeFix,
} from "./tracker"

/**
 * The ping and Live, on both platforms. The server asks for one fix on its
 * interval and the phone answers it; somebody watching gets a fix a second
 * for as long as they look; and nothing runs in between.
 */

jest.mock("./nativeTracker")
// eslint-disable-next-line import/first
import * as nativeTracker from "./nativeTracker"

/** The manual mock's controls, reached through the module the tracker sees. */
const { fake } = nativeTracker as unknown as typeof import("./__mocks__/nativeTracker")

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
let mockSessionRunning = false
let mockLegacyFence = false

jest.mock("expo-location", () => ({
  Accuracy: { Lowest: 1, Balanced: 3, High: 4, Highest: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted", canAskAgain: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  hasStartedGeofencingAsync: jest.fn(async () => mockLegacyFence),
  stopGeofencingAsync: jest.fn(async () => {
    mockLegacyFence = false
  }),
  hasStartedLocationUpdatesAsync: jest.fn(async () => mockSessionRunning),
  startLocationUpdatesAsync: jest.fn(async () => {
    mockSessionRunning = true
  }),
  stopLocationUpdatesAsync: jest.fn(async () => {
    mockSessionRunning = false
  }),
  getLastKnownPositionAsync: jest.fn(async () => null),
  hasServicesEnabledAsync: jest.fn(async () => true),
  getCurrentPositionAsync: jest.fn(async () => ({
    timestamp: Date.now(),
    coords: {
      latitude: 51.4545,
      longitude: -2.5879,
      altitude: 0,
      accuracy: 40,
      altitudeAccuracy: 5,
      heading: -1,
      speed: -1,
    },
  })),
}))

jest.mock("@/services/incidentAlarm", () => ({
  checkIncident: jest.fn(async () => {}),
  noteIncidentFix: jest.fn(),
  raiseIncident: jest.fn(async () => {}),
}))

jest.mock("./driveSensors", () => ({
  startDriveSensors: jest.fn(async () => true),
  stopDriveSensors: jest.fn(),
}))

/** Core Motion's history as a test sets it, for an iPhone's ping to read. */
let mockMotionHistory: unknown[] | null = null
let mockMotionPermission = "granted"
jest.mock("./motion", () => ({
  ...jest.requireActual("./motion"),
  queryMotion: jest.fn(async () => mockMotionHistory),
  motionPermission: jest.fn(async () => mockMotionPermission),
  startMotion: jest.fn(async () => ({ remove: jest.fn() })),
  stopMotion: jest.fn(async () => {}),
}))

const mockUpload = jest.fn()
jest.mock("@/services/api", () => ({
  ApiError: jest.requireActual("@/services/api/client").ApiError,
  api: {
    websocketUrl: () => null,
    refreshTokens: async () => null,
    url: (path: string) => `https://hearth.example/api/v1${path}`,
  },
  endpoints: { locations: { upload: (...args: unknown[]) => mockUpload(...args) } },
}))
/** The session's tokens as the vault holds them. A test gives them an upload key to answer natively. */
let mockTokens: { accessToken: string; refreshToken: string; uploadKey?: string } | null = null
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: {
    hydrate: async () => ({ accessToken: "a", refreshToken: "r" }),
    peek: () => mockTokens,
  },
}))

type TaskBody = (body: { data: unknown; error: { message: string } | null }) => Promise<unknown>

/** Captured at import, because the tracker defines its tasks the moment it loads. */
const syncTask = (
  TaskManager.defineTask as unknown as jest.Mock<void, [string, TaskBody]>
).mock.calls.find(([name]) => name === BACKGROUND_SYNC_TASK)![1]
const locationTask = (
  TaskManager.defineTask as unknown as jest.Mock<void, [string, TaskBody]>
).mock.calls.find(([name]) => name === BACKGROUND_LOCATION_TASK)![1]

const getPosition = Location.getCurrentPositionAsync as unknown as jest.Mock
const startSession = Location.startLocationUpdatesAsync as unknown as jest.Mock
const os = Platform.OS

const reply = (accepted: number, watchedUntil: string | null = null) => ({
  accepted,
  rejected: 0,
  placeEvents: 0,
  serverTime: new Date().toISOString(),
  policy: { minUpdateIntervalSeconds: 300, distanceFilterMeters: 60 },
  watchedUntil,
})

const uploaded = (): LocationFixInput[] =>
  mockUpload.mock.calls.flatMap(([batch]) => batch as LocationFixInput[])

const at = (when: number, speed: number | null = 0): Location.LocationObject =>
  ({
    timestamp: when,
    coords: {
      latitude: HOME.lat,
      longitude: HOME.lon,
      altitude: 0,
      accuracy: 8,
      altitudeAccuracy: 5,
      heading: -1,
      speed,
    },
  }) as Location.LocationObject

/** The service's queue entries, as it leaves them for this side. */
const queued = (when: number, sent: boolean) => ({ ...at(when, null), sent })

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate"] })
  jest.setSystemTime(new Date("2026-10-31T12:00:00Z"))
  useTrackingStore.getState().reset()
  useTrackingStore.getState().setEnabled(true)
  useAuthStore.getState().setServer("https://hearth.test", null as never)
  AppState.currentState = "background"
  mockSessionRunning = false
  mockLegacyFence = false
  mockTokens = { accessToken: "a", refreshToken: "r", uploadKey: "hk1.session.mac" }
  mockMotionHistory = null
  mockMotionPermission = "granted"
  useSettingsStore.setState({ incidentDetection: false })
  jest.clearAllMocks()
  fake.reset()
  mockUpload.mockImplementation(async (batch: LocationFixInput[]) => reply(batch.length))
  clearTrackerLog()
})

afterEach(async () => {
  await stopTracking()
  stopForegroundHeartbeat()
  Platform.OS = os
  AppState.currentState = "active"
  jest.useRealTimers()
})

describe("on Android", () => {
  beforeEach(() => {
    Platform.OS = "android"
  })

  it("hands the push handler sharing and the key, and starts nothing", async () => {
    expect(await startTracking()).toBe(true)

    expect(fake.state).toEqual({ enabled: true, mode: "on", crashDetection: false })
    expect(fake.uploader).toEqual({
      url: "https://hearth.example/api/v1/locations/batch",
      key: "hk1.session.mac",
    })
    expect(startSession).not.toHaveBeenCalled()
    expect(fake.startBrief).not.toHaveBeenCalled()
    expect(fake.watch).not.toHaveBeenCalled()
  })

  it("takes back the request and the fence an older build left running", async () => {
    mockSessionRunning = true
    mockLegacyFence = true

    await startTracking()

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
    expect(Location.stopGeofencingAsync).toHaveBeenCalledWith("hearth-stationary-geofence")
  })

  it("takes no fix of its own for a ping the service answered", async () => {
    await startTracking()

    await answerWake()

    expect(getPosition).not.toHaveBeenCalled()
    expect(fake.startBrief).not.toHaveBeenCalled()
  })

  it("answers a ping from here, under the brief service, without a key", async () => {
    mockTokens = { accessToken: "a", refreshToken: "r" }
    await startTracking()

    await answerWake()

    expect(fake.startBrief).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced })
    expect(uploaded()).toHaveLength(1)
    expect(uploaded()[0]).toMatchObject({ source: "nudge" })
    expect(fake.stopBrief).toHaveBeenCalledTimes(1)
  })

  it("learns from the fixes the service sent and sends none of them again", async () => {
    await startTracking()
    const now = Date.now()
    fake.fixes = [queued(now - 2_000, true), queued(now - 1_000, true)]

    await processNativeQueue()

    expect(mockUpload).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().lastFix?.recordedAt).toBe(
      new Date(now - 1_000).toISOString(),
    )
  })

  it("sends a fix the service handed back unsent", async () => {
    await startTracking()
    fake.fixes = [queued(Date.now() - 1_000, false)]

    await processNativeQueue()

    expect(uploaded()).toHaveLength(1)
  })

  it("goes Live through the service, and never through a session of its own", async () => {
    await startTracking()

    await enterWatched(600)

    expect(fake.watch).toHaveBeenCalledWith(600)
    expect(startSession).not.toHaveBeenCalled()
    expect(getPosition).not.toHaveBeenCalled()
  })

  it("sends its one fix for a watch when Android will not start the service", async () => {
    await startTracking()
    fake.refuse = true

    await enterWatched(600)

    expect(uploaded()).toHaveLength(1)
  })

  it("takes the window the service opened on a push", async () => {
    await startTracking()
    const until = Date.now() + 5 * 60_000
    fake.events = [{ type: "watch", until, reason: "push", at: Date.now() }]

    await processNativeQueue()

    expect(useTrackingStore.getState().watchedUntil).toBe(new Date(until).toISOString())
    expect(fake.watch).not.toHaveBeenCalled()
  })

  it("passes on a viewer leaving, and not its own clock running out", async () => {
    await startTracking()
    await enterWatched(60)
    fake.endWatch.mockClear()

    jest.advanceTimersByTime(61_000)
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.endWatch).not.toHaveBeenCalled()

    await enterWatched(60)
    await enterWatched(0)
    expect(fake.endWatch).toHaveBeenCalledTimes(1)
  })

  it("takes the fix from here, without the service, for an ask while the app is open", async () => {
    await startTracking()
    AppState.currentState = "active"
    getPosition.mockClear()

    await wakeFix()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(fake.startBrief).not.toHaveBeenCalled()
  })

  it("reads what the service sent before deciding the sync is overdue", async () => {
    await startTracking()
    // Two hours since this side last heard of a fix, and a minute since the
    // service sent one for a ping.
    jest.setSystemTime(Date.now() + 2 * 60 * 60_000)
    fake.fixes = [queued(Date.now() - 60_000, true)]
    getPosition.mockClear()

    await syncTask({ data: null, error: null })

    expect(getPosition).not.toHaveBeenCalled()
  })

  describe("with the motion sensor", () => {
    /** The last real fix, a minute ago, uploaded. */
    async function aFixAMinuteAgo() {
      fake.fixes = [queued(Date.now() - 60_000, true)]
      await processNativeQueue()
    }

    beforeEach(async () => {
      // Without a key, so this side answers and the decision is seen here.
      mockTokens = { accessToken: "a", refreshToken: "r" }
      await startTracking()
    })

    it("answers the server's ping with the last fix, and no location, while still since it", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(getPosition).not.toHaveBeenCalled()
      expect(fake.startBrief).not.toHaveBeenCalled()
      expect(uploaded().pop()).toMatchObject({ activity: "still", source: "nudge" })
    })

    it("takes a fresh fix for a ping once the motion sensor has the phone moving", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      fake.events = [{ type: "transition", activity: "walking", at: Date.now() }]
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced })
    })

    it("takes a fresh fix for a phone that went still only after its last fix", async () => {
      await aFixAMinuteAgo()
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 30_000 }]
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("always takes a fresh fix for an ask somebody made", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      getPosition.mockClear()

      await answerWake()

      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("takes a fresh fix once the motion permission is taken away", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      mockMotionPermission = "denied"
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("forgets what the sensor said, and any drive, when the phone was switched off", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      fake.events = [{ type: "boot", reboot: true, at: Date.now() }]
      await processNativeQueue()
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(useTrackingStore.getState().lastVerdict).toBeNull()
      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("stays off location in the app's own check while the phone lies still in a hand", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 10 * 60_000 }]
      await aFixAMinuteAgo()
      AppState.currentState = "active"
      jest.advanceTimersByTime(6 * 60_000)
      getPosition.mockClear()

      startForegroundHeartbeat()
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(getPosition).not.toHaveBeenCalled()
      expect(uploaded().pop()).toMatchObject({ activity: "still" })
    })

    it("takes one real fix an hour, however long the phone lies still", async () => {
      fake.events = [{ type: "transition", activity: "still", at: Date.now() - 3 * 60 * 60_000 }]
      fake.fixes = [queued(Date.now() - 61 * 60_000, true)]
      await processNativeQueue()
      getPosition.mockClear()

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledTimes(1)
    })
  })

  describe("on a drive", () => {
    beforeEach(async () => {
      useSettingsStore.setState({ incidentDetection: true })
      await startTracking()
    })

    it("tells the receiver crash alerts are on, so a vehicle starts a drive", () => {
      expect(fake.state).toMatchObject({ crashDetection: true })
    })

    it("runs the detector from the service's word until the drive is over", async () => {
      fake.events = [{ type: "drive", at: Date.now() }]
      await processNativeQueue()
      expect(startDriveSensors).toHaveBeenCalled()

      fake.events = [{ type: "drive over", reason: "motion", at: Date.now() }]
      await processNativeQueue()
      expect(stopDriveSensors).toHaveBeenCalled()
      expect(useTrackingStore.getState().driveSince).toBeNull()
    })

    it("keeps the drive's own fixes on the phone", async () => {
      fake.events = [{ type: "drive", at: Date.now() }]
      fake.fixes = [{ ...at(Date.now() - 2_000, 14), local: true } as never]

      await processNativeQueue()

      expect(mockUpload).not.toHaveBeenCalled()
    })

    // A countdown that ran out with the screen off is decided on the drive's
    // own beat, since nothing on a drive is uploaded to bring it round.
    it("decides a running crash countdown on each of the drive's fixes", async () => {
      ;(checkIncident as jest.Mock).mockClear()
      fake.fixes = [{ ...at(Date.now() - 2_000, 14), local: true } as never]

      await processNativeQueue()

      expect(checkIncident).toHaveBeenCalled()
    })

    it("lets go of a drive the service no longer has, found when tracking starts", async () => {
      await stopTracking()
      useSettingsStore.setState({ incidentDetection: true })
      useTrackingStore
        .getState()
        .setDriveSince(new Date(Date.now() - 6 * 60 * 60_000).toISOString())
      fake.status = "none"
      ;(startDriveSensors as jest.Mock).mockClear()

      await startTracking()

      expect(useTrackingStore.getState().driveSince).toBeNull()
      expect(startDriveSensors).not.toHaveBeenCalled()
    })

    it("tells the receiver when the last circle turns crash alerts off", async () => {
      useSettingsStore.setState({ incidentDetection: false })
      await new Promise((resolve) => setImmediate(resolve))
      expect(fake.state).toMatchObject({ crashDetection: false })
    })
  })

  it("takes the key away and ends what the service is doing when sharing stops", async () => {
    await startTracking()

    await stopTracking()

    expect(fake.state).toEqual({ enabled: false, mode: "off", crashDetection: false })
    expect(fake.uploader).toBeNull()
    expect(fake.stopService).toHaveBeenCalled()
  })
})

describe("on iOS", () => {
  beforeEach(() => {
    Platform.OS = "ios"
  })

  it("starts nothing that keeps running", async () => {
    await startTracking()

    expect(startSession).not.toHaveBeenCalled()
  })

  it("takes back the session and the fence an older build left running", async () => {
    mockSessionRunning = true
    mockLegacyFence = true

    await startTracking()

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
    expect(Location.stopGeofencingAsync).toHaveBeenCalledWith("hearth-stationary-geofence")
  })

  it("answers a ping with one Wi-Fi grade fix", async () => {
    await startTracking()

    await answerWake()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(getPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced })
    expect(uploaded()).toHaveLength(1)
    expect(startSession).not.toHaveBeenCalled()
  })

  it("runs a session at a fix a second for the window, and uploads each fix", async () => {
    await startTracking()

    await enterWatched(600)

    expect(startSession).toHaveBeenCalledTimes(1)
    const [, options] = startSession.mock.calls[0] as [string, Location.LocationTaskOptions]
    expect(options).toMatchObject({
      accuracy: Location.Accuracy.High,
      timeInterval: 1_000,
      distanceInterval: 0,
      pausesUpdatesAutomatically: false,
    })

    const now = Date.now()
    await locationTask({ data: { locations: [at(now, 14)] }, error: null })
    await locationTask({ data: { locations: [at(now + 1_000, 14)] }, error: null })
    expect(uploaded()).toHaveLength(2)
    expect(uploaded()[0]).toMatchObject({ activity: "driving" })
  })

  it("labels a fix that measured road speed a drive, whatever the sensor last said", async () => {
    await startTracking()
    useTrackingStore.getState().setLastVerdict("still", Date.now() - 3 * 60 * 60_000)
    await enterWatched(600)

    await locationTask({ data: { locations: [at(Date.now(), 25)] }, error: null })

    expect(uploaded().pop()).toMatchObject({ activity: "driving" })
  })

  it("takes no ping fix while the session is already delivering one a second", async () => {
    await startTracking()
    await enterWatched(600)

    await answerWake()

    expect(getPosition).not.toHaveBeenCalled()
  })

  it("stops the session when the window ends", async () => {
    await startTracking()
    await enterWatched(60)

    jest.advanceTimersByTime(61_000)
    await new Promise((resolve) => setImmediate(resolve))

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
    expect(useTrackingStore.getState().watchedUntil).toBeNull()
  })

  it("stops the session when the server says nobody is watching any more", async () => {
    await startTracking()
    await enterWatched(600)
    jest.advanceTimersByTime(1_000)
    mockUpload.mockImplementation(async (batch: LocationFixInput[]) => reply(batch.length, null))

    await locationTask({ data: { locations: [at(Date.now())] }, error: null })

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
  })

  it("closes a window that ran out while the app was suspended, at the next delivery", async () => {
    await startTracking()
    await enterWatched(60)
    // The timer never fired: iOS suspended the app once the session went quiet.
    jest.setSystemTime(Date.now() + 2 * 60_000)

    await locationTask({ data: { locations: [at(Date.now())] }, error: null })

    expect(useTrackingStore.getState().watchedUntil).toBeNull()
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
  })

  it("stops a session still delivering outside any window", async () => {
    await startTracking()
    mockSessionRunning = true

    await locationTask({ data: { locations: [at(Date.now())] }, error: null })

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  describe("with Core Motion", () => {
    const record = (activity: string, minutesAgo: number, stationary = false) => ({
      activity,
      stationary,
      confidence: 90,
      t: Date.now() - minutesAgo * 60_000,
    })

    beforeEach(async () => {
      await startTracking()
      await answerWake()
      getPosition.mockClear()
      jest.advanceTimersByTime(5 * 60_000)
    })

    it("answers the server's ping with the last fix while the history has the phone still", async () => {
      mockMotionHistory = [record("still", 30, true)]

      await answerWake({ ping: true })

      expect(getPosition).not.toHaveBeenCalled()
      expect(uploaded().pop()).toMatchObject({ activity: "still" })
    })

    it("takes a fresh fix for a ping once the history has the phone walking", async () => {
      mockMotionHistory = [record("still", 30, true), record("walking", 2)]

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("takes a fresh fix where the history cannot be read", async () => {
      mockMotionHistory = null

      await answerWake({ ping: true })

      expect(getPosition).toHaveBeenCalledTimes(1)
    })

    it("begins a drive from a ping that finds the phone in a moving vehicle", async () => {
      useSettingsStore.setState({ incidentDetection: true })
      mockMotionHistory = [record("automotive", 1)]

      await answerWake({ ping: true })

      expect(startDriveSensors).toHaveBeenCalled()
      const [, options] = startSession.mock.calls.pop() as [string, Location.LocationTaskOptions]
      expect(options).toMatchObject({ accuracy: Location.Accuracy.High, distanceInterval: 0 })

      // The drive's fixes are for the detector, and none is uploaded.
      mockUpload.mockClear()
      await locationTask({ data: { locations: [at(Date.now(), 14)] }, error: null })
      expect(mockUpload).not.toHaveBeenCalled()
    })

    it("starts no drive with crash alerts off", async () => {
      mockMotionHistory = [record("automotive", 1)]

      await answerWake({ ping: true })

      expect(startDriveSensors).not.toHaveBeenCalled()
    })
  })

  it("goes Live from an upload reply that names a window, as when the watch push was lost", async () => {
    await startTracking()
    mockUpload.mockImplementation(async (batch: LocationFixInput[]) =>
      reply(batch.length, new Date(Date.now() + 5 * 60_000).toISOString()),
    )

    await answerWake()
    await new Promise((resolve) => setImmediate(resolve))

    expect(startSession).toHaveBeenCalledTimes(1)
  })
})
