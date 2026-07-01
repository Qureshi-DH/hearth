import { Platform } from "react-native"

import { setupChannels } from "./notifications"

const mockSetChannel = jest.fn()

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: (...args: unknown[]) => mockSetChannel(...args),
  AndroidImportance: { MIN: 3, LOW: 4, DEFAULT: 5, HIGH: 6, MAX: 7 },
}))
jest.mock("expo-application", () => ({ applicationId: "com.binary.rewind.hearth" }))
jest.mock("expo-device", () => ({ isDevice: true }))
jest.mock("@/services/api", () => ({ endpoints: {} }))
jest.mock("@/services/location/tracker", () => ({
  BACKGROUND_LOCATION_TASK: "hearth-background-location",
  reportNow: jest.fn(),
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

  it("does nothing on iOS", async () => {
    Platform.OS = "ios"
    await setupChannels()
    expect(mockSetChannel).not.toHaveBeenCalled()
  })
})
