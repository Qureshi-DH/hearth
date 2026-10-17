import { AppState } from "react-native"
import { act, renderHook } from "@testing-library/react-native"

import { useAuthStore } from "@/stores/auth"

import { realtime, useRealtimeConnection } from "./realtime"

jest.mock("@/services/api", () => ({
  api: { websocketUrl: () => "wss://hearth.test/api/v1/ws" },
}))
jest.mock("@/services/location/tracker", () => ({ reportNow: jest.fn() }))
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: jest.fn(),
  dismissNotificationAsync: jest.fn(),
  AndroidNotificationPriority: { MAX: "max" },
}))

/** Hands the hook's AppState listener a state change, as the OS would. */
async function setAppState(state: "active" | "background" | "inactive") {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(
    ([, listener]) => listener as (next: string) => void,
  )
  await act(async () => {
    listeners.forEach((listener) => listener(state))
  })
}

beforeEach(() => {
  ;(AppState.addEventListener as jest.Mock).mockClear()
  AppState.currentState = "active"
  useAuthStore.setState({ status: "signed_in", user: { id: "ana" } as never })
})

afterEach(() => {
  realtime.disconnect()
  jest.restoreAllMocks()
})

describe("the screens' socket and the app's state", () => {
  // Pulling down Control Centre on an iPhone makes the app inactive, with
  // the screen still showing. Closing the socket for that dropped Live onto
  // the minute's poll for as long as it took to reopen.
  it("stays open while the app is only inactive", async () => {
    const connect = jest.spyOn(realtime, "connect")
    const disconnect = jest.spyOn(realtime, "disconnect")
    renderHook(() => useRealtimeConnection())
    expect(connect).toHaveBeenCalledTimes(1)

    await setAppState("inactive")
    expect(disconnect).not.toHaveBeenCalled()
    await setAppState("active")
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("closes in the background and opens again on the way back", async () => {
    const connect = jest.spyOn(realtime, "connect")
    const disconnect = jest.spyOn(realtime, "disconnect")
    renderHook(() => useRealtimeConnection())
    await setAppState("inactive")
    await setAppState("background")
    expect(disconnect).toHaveBeenCalledTimes(1)
    await setAppState("active")
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
