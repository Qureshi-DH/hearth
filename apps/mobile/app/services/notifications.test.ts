import { Platform } from "react-native"

import { NOTIFICATION_WAKE_TASK, pushType, setupChannels } from "./notifications"

const mockSetChannel = jest.fn()

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: (...args: unknown[]) => mockSetChannel(...args),
  AndroidImportance: { MIN: 3, LOW: 4, DEFAULT: 5, HIGH: 6, MAX: 7 },
}))
jest.mock("expo-application", () => ({ applicationId: "com.binary.rewind.hearth" }))
type TaskBody = (body: { data: unknown; error: unknown }) => Promise<void>
// Imports are hoisted above any const here, and the tracker defines its task
// the moment it loads, so the registry has to live somewhere already there.
jest.mock("expo-task-manager", () => ({
  defineTask: (name: string, body: TaskBody) => {
    const shared = globalThis as { __wakeTasks?: Map<string, TaskBody> }
    ;(shared.__wakeTasks ??= new Map()).set(name, body)
  },
}))
const mockTasks = () => (globalThis as { __wakeTasks?: Map<string, TaskBody> }).__wakeTasks!
const mockReportNow = jest.fn(async (..._args: unknown[]): Promise<null> => null)
jest.mock("expo-device", () => ({ isDevice: true }))
jest.mock("@/services/api", () => ({ endpoints: {} }))
jest.mock("@/services/location/tracker", () => ({
  BACKGROUND_LOCATION_TASK: "hearth-background-location",
  reportNow: (...args: unknown[]) => mockReportNow(...args),
}))

describe("setupChannels", () => {
  beforeEach(() => {
    mockSetChannel.mockClear()
    Platform.OS = "android"
  })

  // expo-location derives the channel from the package and the task name and
  // only creates it when it does not exist. If either half drifts, the service
  // makes its own channel at low importance and the notification is back in
  // the status bar with nothing failing.
  it("claims the foreground service channel at minimum importance", async () => {
    await setupChannels()
    expect(mockSetChannel).toHaveBeenCalledWith(
      "com.binary.rewind.hearth:hearth-background-location",
      expect.objectContaining({ importance: 3 }),
    )
  })

  // Any string is read as a bundled sound file, so a "default" sound is a
  // missing file and a silent channel. The system default comes from leaving
  // the key out.
  it("never names a sound file for the SOS channel", async () => {
    await setupChannels()
    const sos = mockSetChannel.mock.calls.find(([id]) => id === "sos")?.[1] as Record<
      string,
      unknown
    >
    expect(sos).toBeDefined()
    expect("sound" in sos).toBe(false)
  })

  it("does nothing on iOS", async () => {
    Platform.OS = "ios"
    await setupChannels()
    expect(mockSetChannel).not.toHaveBeenCalled()
  })
})

describe("the wake task", () => {
  const task = () => mockTasks().get(NOTIFICATION_WAKE_TASK)!

  beforeEach(() => {
    mockReportNow.mockClear()
  })

  it("is defined when the module loads, before anything mounts", () => {
    expect(mockTasks().has(NOTIFICATION_WAKE_TASK)).toBe(true)
  })

  // The three shapes a data-only push arrives in: Android's string fields,
  // iOS's JSON string, and Expo's envelope.
  it("reads the type from whichever shape the platform hands over", () => {
    expect(pushType({ data: { type: "wake" } })).toBe("wake")
    expect(pushType({ data: { dataString: JSON.stringify({ type: "wake" }) } })).toBe("wake")
    expect(pushType({ data: { body: JSON.stringify({ type: "nudge_requested" }) } })).toBe(
      "nudge_requested",
    )
    expect(pushType({ data: { body: "not json" } })).toBeNull()
    expect(pushType(undefined)).toBeNull()
  })

  it("answers a wake with a fix, and a nudge the same way", async () => {
    await task()({ data: { data: { type: "wake" } }, error: null })
    await task()({ data: { data: { dataString: '{"type":"nudge_requested"}' } }, error: null })
    expect(mockReportNow).toHaveBeenCalledTimes(2)
    expect(mockReportNow).toHaveBeenCalledWith("nudge")
  })

  it("ignores every other push, and an error", async () => {
    await task()({ data: { data: { type: "arrive" } }, error: null })
    await task()({ data: { data: { type: "wake" } }, error: { message: "no" } })
    expect(mockReportNow).not.toHaveBeenCalled()
  })
})
