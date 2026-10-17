import { act, renderHook } from "@testing-library/react-native"

import { REALTIME_DOWN_NOTICE_MS, useRealtimeDown } from "./useRealtimeDown"

let mockDownSince: number | null = null
const mockListeners = new Set<() => void>()
jest.mock("@/services/realtime", () => ({
  realtime: {
    get downSince() {
      return mockDownSince
    },
    onStatusChange: (listener: () => void) => {
      mockListeners.add(listener)
      return () => mockListeners.delete(listener)
    },
  },
}))

function goDown(at: number | null) {
  mockDownSince = at
  mockListeners.forEach((listener) => listener())
}

beforeEach(() => {
  jest.useFakeTimers()
  mockDownSince = null
})

afterEach(() => {
  jest.useRealTimers()
})

describe("whether to say the connection is down", () => {
  // A phone changing cell drops its socket for a second, and saying so
  // every time would teach people to ignore it.
  it("waits a few seconds before saying so", () => {
    const { result } = renderHook(() => useRealtimeDown())
    act(() => goDown(Date.now()))
    expect(result.current).toBe(false)
    act(() => {
      jest.advanceTimersByTime(REALTIME_DOWN_NOTICE_MS + 10)
    })
    expect(result.current).toBe(true)
  })

  it("stops saying so the moment it is back", () => {
    const { result } = renderHook(() => useRealtimeDown())
    act(() => goDown(Date.now() - REALTIME_DOWN_NOTICE_MS - 1))
    expect(result.current).toBe(true)
    act(() => goDown(null))
    expect(result.current).toBe(false)
  })
})
