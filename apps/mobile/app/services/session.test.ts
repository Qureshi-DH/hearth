import { AppState } from "react-native"

import { useAuthStore } from "@/stores/auth"
import { useTrackingStore } from "@/stores/tracking"

import { sessionExpired } from "./session"

const mockSchedule = jest.fn(async (..._args: unknown[]) => "id")
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
}))

const mockStopTracking = jest.fn(async () => {})
jest.mock("@/services/location/tracker", () => ({
  stopTracking: () => mockStopTracking(),
}))

jest.mock("@/services/queryClient", () => ({ queryClient: { clear: jest.fn() } }))

/**
 * A phone signs itself out only when the server refuses its refresh token.
 * That happened to a phone on the road whose refresh answer was lost, and
 * it stopped reporting for two hours with nobody told. The server no longer
 * refuses that retry, and whatever the reason, the sign-out is never silent.
 */
describe("a session ending", () => {
  beforeEach(() => {
    mockSchedule.mockClear()
    mockStopTracking.mockClear()
    useAuthStore.getState().setServer("https://hearth.test", null as never)
    useAuthStore.getState().signedIn({ id: "u1" } as never)
    useTrackingStore.getState().setEnabled(true)
    useTrackingStore.getState().setMode("stationary")
  })

  it("stops the tracker, signs out, and says so on the shade when the app is not open", async () => {
    AppState.currentState = "background"
    await sessionExpired()
    expect(mockStopTracking).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().status).toBe("signed_out")
    expect(mockSchedule).toHaveBeenCalledTimes(1)
    const request = mockSchedule.mock.calls[0]![0] as {
      content: { title: string; body: string; data: { type: string } }
    }
    expect(request.content.data.type).toBe("signed_out")
    expect(request.content.title.length).toBeGreaterThan(0)
  })

  it("lets the tracker finish stopping before it clears the queue", async () => {
    useTrackingStore.getState().enqueue([
      {
        lat: 51.4545,
        lon: -2.5879,
        recordedAt: new Date().toISOString(),
        accuracyMeters: 10,
        source: "background",
      },
    ])
    const queuedWhenStopped: number[] = []
    mockStopTracking.mockImplementationOnce(async () => {
      await Promise.resolve()
      queuedWhenStopped.push(useTrackingStore.getState().queue.length)
    })
    await sessionExpired()
    expect(queuedWhenStopped).toEqual([1])
    expect(useTrackingStore.getState().queue).toHaveLength(0)
  })

  it("says nothing on the shade when the app is open, where the sign-in screen says it", async () => {
    AppState.currentState = "active"
    await sessionExpired()
    expect(useAuthStore.getState().status).toBe("signed_out")
    expect(mockSchedule).not.toHaveBeenCalled()
  })
})
