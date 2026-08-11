import type { MemberPresence } from "@hearth/shared"
import { act, renderHook } from "@testing-library/react-native"

import {
  changesAhead,
  judgeLiveness,
  LIVE_FRESH_MS,
  LIVE_UNANSWERED_MS,
  useLiveness,
} from "./useLiveness"

const T0 = Date.UTC(2026, 8, 17, 14, 27, 0)

function fixAt(at: number, activity: MemberPresence["activity"] = "driving"): MemberPresence {
  return {
    userId: "sam",
    lat: 33.7,
    lon: 73.05,
    accuracyMeters: 10,
    recordedAt: new Date(at).toISOString(),
    batteryLevel: 0.6,
    isCharging: false,
    activity,
    speedMps: 11,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: false,
    atPlace: null,
    sosAlertId: null,
    issues: [],
  }
}

describe("judgeLiveness", () => {
  const askedAt = T0
  const until = T0 + 600_000

  it("is asking before the viewer has asked at all", () => {
    expect(judgeLiveness(fixAt(T0 - 1000), null, null, T0)).toBe("asking")
  })

  it("is asking while the only fix is from before the ask, however fresh", () => {
    expect(judgeLiveness(fixAt(T0 - 1000), askedAt, until, T0 + 5_000)).toBe("asking")
    expect(judgeLiveness(fixAt(T0), askedAt, until, T0 + 5_000)).toBe("asking")
  })

  it("is asking when the phone has never reported", () => {
    expect(judgeLiveness(undefined, askedAt, until, T0 + 5_000)).toBe("asking")
    expect(judgeLiveness({ ...fixAt(T0), recordedAt: null }, askedAt, until, T0 + 5_000)).toBe(
      "asking",
    )
  })

  it("is live once a fix newer than the ask has arrived and is under thirty seconds old", () => {
    expect(judgeLiveness(fixAt(T0 + 4_000), askedAt, until, T0 + 5_000)).toBe("live")
    expect(judgeLiveness(fixAt(T0 + 4_000), askedAt, until, T0 + 4_000 + LIVE_FRESH_MS)).toBe(
      "live",
    )
  })

  it("stops being live thirty seconds after the last fix, and is asking again", () => {
    expect(judgeLiveness(fixAt(T0 + 4_000), askedAt, until, T0 + 4_000 + LIVE_FRESH_MS + 1)).toBe(
      "asking",
    )
  })

  it("is unanswered two minutes after an ask nothing answered", () => {
    expect(judgeLiveness(fixAt(T0 - 60_000), askedAt, until, T0 + LIVE_UNANSWERED_MS)).toBe(
      "asking",
    )
    expect(judgeLiveness(fixAt(T0 - 60_000), askedAt, until, T0 + LIVE_UNANSWERED_MS + 1)).toBe(
      "unanswered",
    )
    expect(judgeLiveness(undefined, askedAt, until, T0 + LIVE_UNANSWERED_MS + 1)).toBe("unanswered")
  })

  it("counts the silence from the last answer, not from the ask", () => {
    const answered = T0 + 90_000
    expect(judgeLiveness(fixAt(answered), askedAt, until, answered + LIVE_UNANSWERED_MS)).toBe(
      "asking",
    )
    expect(judgeLiveness(fixAt(answered), askedAt, until, answered + LIVE_UNANSWERED_MS + 1)).toBe(
      "unanswered",
    )
  })

  it("has ended once the watch window lapsed without a fresh fix", () => {
    expect(judgeLiveness(fixAt(T0 + 4_000), askedAt, until, until + 1)).toBe("ended")
    expect(judgeLiveness(undefined, askedAt, until, until + 1)).toBe("ended")
  })

  it("is still live after the window when fresh fixes keep coming", () => {
    // Somebody else's watch, or a phone on the move that uploads anyway.
    expect(judgeLiveness(fixAt(until + 10_000), askedAt, until, until + 12_000)).toBe("live")
  })

  it("never ends a watch the server has not granted yet", () => {
    expect(judgeLiveness(undefined, askedAt, null, T0 + 3_600_000)).toBe("unanswered")
  })
})

describe("useLiveness", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(T0)
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("moves from asking to unanswered on its own as time passes", () => {
    const { result } = renderHook(() => useLiveness(fixAt(T0 - 60_000), T0, T0 + 600_000))
    expect(result.current).toBe("asking")

    act(() => {
      jest.advanceTimersByTime(LIVE_UNANSWERED_MS + 5_000)
    })
    expect(result.current).toBe("unanswered")
  })

  it("lets a fix newer than the ask go live at once, and lapse thirty seconds later", () => {
    const { result, rerender } = renderHook(
      ({ entry }: { entry: MemberPresence | undefined }) => useLiveness(entry, T0, T0 + 600_000),
      { initialProps: { entry: undefined as MemberPresence | undefined } },
    )
    act(() => {
      jest.advanceTimersByTime(3_000)
    })
    rerender({ entry: fixAt(T0 + 3_000) })
    expect(result.current).toBe("live")

    act(() => {
      jest.advanceTimersByTime(LIVE_FRESH_MS + 5_000)
    })
    expect(result.current).toBe("asking")
  })

  it("ends when the window lapses", () => {
    const { result } = renderHook(() => useLiveness(undefined, T0, T0 + 20_000))
    act(() => {
      jest.advanceTimersByTime(25_000)
    })
    expect(result.current).toBe("ended")
  })

  it("flips at the exact moment, not on the next tick", () => {
    const { result, rerender } = renderHook(
      ({ entry }: { entry: MemberPresence | undefined }) => useLiveness(entry, T0, T0 + 600_000),
      { initialProps: { entry: undefined as MemberPresence | undefined } },
    )
    act(() => {
      jest.advanceTimersByTime(1_000)
    })
    rerender({ entry: fixAt(T0 + 1_000) })
    act(() => {
      jest.advanceTimersByTime(LIVE_FRESH_MS)
    })
    expect(result.current).toBe("live")
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current).toBe("asking")

    act(() => {
      jest.advanceTimersByTime(LIVE_UNANSWERED_MS - LIVE_FRESH_MS - 1)
    })
    expect(result.current).toBe("asking")
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current).toBe("unanswered")
  })

  it("ends the moment the window lapses", () => {
    const { result } = renderHook(() => useLiveness(fixAt(T0 + 1_000), T0, T0 + 200_000))
    act(() => {
      jest.advanceTimersByTime(200_000)
    })
    expect(result.current).toBe("unanswered")
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current).toBe("ended")
  })
})

describe("changesAhead", () => {
  const at = (ms: number) => new Date(ms).toISOString()

  it("is the end of freshness, then the deadline, then the window, while live", () => {
    expect(changesAhead(at(T0 + 1_000), T0, T0 + 600_000, T0 + 2_000)).toEqual([
      T0 + 1_000 + LIVE_FRESH_MS,
      T0 + 1_000 + LIVE_UNANSWERED_MS,
      T0 + 600_000,
    ])
  })

  it("is the deadline and the window while asking", () => {
    expect(changesAhead(at(T0 - 60_000), T0, T0 + 600_000, T0 + 2_000)).toEqual([
      T0 + LIVE_UNANSWERED_MS,
      T0 + 600_000,
    ])
  })

  it("leaves out what has already passed", () => {
    expect(changesAhead(undefined, T0, T0 + 600_000, T0 + 300_000)).toEqual([T0 + 600_000])
    expect(changesAhead(undefined, T0, T0 + 600_000, T0 + 700_000)).toEqual([])
  })

  it("has no window to end before the server has granted one", () => {
    expect(changesAhead(undefined, T0, null, T0)).toEqual([T0 + LIVE_UNANSWERED_MS])
  })
})
