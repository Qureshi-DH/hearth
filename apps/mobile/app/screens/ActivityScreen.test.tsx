import type { FeedEvent } from "@hearth/shared"
import { RefreshControl } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { ActivityScreen } from "./ActivityScreen"
import { ThemeProvider } from "../theme/context"

// Grouping is by local calendar day, so the assertions below only mean anything
// on a clock that is not UTC. Node re-reads this on every Date operation.
process.env.TZ = "America/Los_Angeles"

/** Every iso passed to dayLabel / formatClock since the last reset. */
const mockDayLabelCalls: string[] = []
const mockClockCalls: string[] = []

jest.mock("../utils/time", () => {
  const actual = jest.requireActual("../utils/time")
  return {
    ...actual,
    dayLabel: (iso: string, now?: Date) => {
      mockDayLabelCalls.push(iso)
      return actual.dayLabel(iso, now)
    },
    formatClock: (iso: string) => {
      mockClockCalls.push(iso)
      return actual.formatClock(iso)
    },
  }
})

type MockCircle = {
  id: string
  name: string
  emoji: string
  memberCount: number
  unreadEventCount: number
}
const homeCircle: MockCircle = {
  id: "circle-1",
  name: "Home",
  emoji: "🏠",
  memberCount: 2,
  unreadEventCount: 0,
}
let mockCircle: MockCircle | null = homeCircle
let mockEventsData: { pages: { items: FeedEvent[] }[] } | undefined = { pages: [] }
/** What TanStack Query reports about the feed and the circles beside the data. */
let mockEventsStatus = { isLoading: false, isError: false }
let mockCirclesStatus = { isLoading: false, isError: false }
const mockRefetchEvents = jest.fn()
const mockRefetchCircles = jest.fn()
const mockListeners = new Set<() => void>()
const mockSubscribe = (listener: () => void) => {
  mockListeners.add(listener)
  return () => {
    mockListeners.delete(listener)
  }
}
const mockReadEvents = () => mockEventsData
const mockReadCircle = () => mockCircle

/** What the websocket handler and a page fetch both do: a fresh data object. */
function publish(next: () => void) {
  act(() => {
    next()
    mockListeners.forEach((listener) => listener())
  })
}

jest.mock("../hooks/queries", () => {
  const react = require("react")
  return {
    useEvents: () => ({
      data: react.useSyncExternalStore(mockSubscribe, mockReadEvents),
      ...mockEventsStatus,
      isRefetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      refetch: mockRefetchEvents,
      fetchNextPage: jest.fn(),
    }),
    useMarkFeedRead: () => ({ mutate: jest.fn() }),
  }
})
jest.mock("../hooks/useActiveCircle", () => {
  const react = require("react")
  return {
    useActiveCircle: () => ({
      circle: react.useSyncExternalStore(mockSubscribe, mockReadCircle),
      circles: mockCircle ? [mockCircle] : [],
      ...mockCirclesStatus,
      refetch: mockRefetchCircles,
      setActiveCircle: jest.fn(),
    }),
  }
})
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ serverUrl: "https://hearth.test", user: { id: "ana" } }),
}))
// The screen is not inside a navigator here, and the focus effect only marks
// the feed read, which the queries mock above swallows.
jest.mock("@react-navigation/native", () => ({ useFocusEffect: () => {} }))
// The loading skeleton pulses on reanimated, which has no native side here.
jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    __esModule: true,
    default: { View: rn.View },
    Easing: { inOut: (fn: unknown) => fn, quad: (value: number) => value },
    useReducedMotion: () => false,
    useSharedValue: (initial: number) => react.useRef({ value: initial }).current,
    useAnimatedStyle: (worklet: () => object) => worklet(),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  }
})
// Screen pulls this in for its scrolling preset. It reaches for a native module
// at import time, so it has to be the library's own jest double.
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest"),
)

let nextEventId = 0
function eventAt(occurredAt: string): FeedEvent {
  nextEventId += 1
  const id = `event-${nextEventId}`
  return {
    id,
    circleId: "circle-1",
    type: "check_in",
    actor: { id: "ana", displayName: "Ana", avatarUrl: null, avatarColor: "#888" },
    occurredAt,
    payload: { userId: "ana" },
    summary: `summary ${id}`,
  }
}

const navigation = { navigate: jest.fn(), goBack: jest.fn() }

async function renderActivity() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <ActivityScreen navigation={navigation as never} route={{ name: "Activity" } as never} />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Icon fonts resolve asynchronously; settling here keeps the update in act.
  await act(async () => {})
  return utils
}

describe("ActivityScreen feed", () => {
  beforeEach(() => {
    nextEventId = 0
    mockCircle = { ...homeCircle }
    mockEventsData = { pages: [] }
    mockEventsStatus = { isLoading: false, isError: false }
    mockCirclesStatus = { isLoading: false, isError: false }
    mockDayLabelCalls.length = 0
    mockClockCalls.length = 0
    navigation.navigate.mockClear()
  })

  it("labels each day once rather than once per event", async () => {
    const day1 = ["T09:00:00.000Z", "T10:00:00.000Z", "T11:00:00.000Z"].map((time) =>
      eventAt(`2026-09-01${time}`),
    )
    const day2 = ["T09:00:00.000Z", "T10:00:00.000Z", "T11:00:00.000Z"].map((time) =>
      eventAt(`2026-09-02${time}`),
    )
    mockEventsData = { pages: [{ items: [...day2, ...day1] }] }

    const { getByText } = await renderActivity()

    expect(mockDayLabelCalls).toEqual([day2[0]!.occurredAt, day1[0]!.occurredAt])
    for (const event of [...day1, ...day2]) expect(getByText(event.summary)).toBeTruthy()
  })

  it("keeps one local evening in one section when it straddles UTC midnight", async () => {
    // Both of these are the evening of 7 Sep in Los Angeles, but they carry
    // different UTC dates, so an ISO-prefix key would split the section.
    const evening = eventAt("2026-09-08T02:15:00.000Z")
    const afternoon = eventAt("2026-09-07T22:30:00.000Z")
    const nextDay = eventAt("2026-09-08T20:00:00.000Z")
    mockEventsData = { pages: [{ items: [nextDay, evening, afternoon] }] }

    await renderActivity()

    expect(mockDayLabelCalls).toEqual([nextDay.occurredAt, evening.occurredAt])
  })

  it("does not re-render rows when only the unread count changes", async () => {
    mockEventsData = {
      pages: [
        { items: [eventAt("2026-09-01T09:00:00.000Z"), eventAt("2026-09-01T10:00:00.000Z")] },
      ],
    }

    await renderActivity()
    expect(mockClockCalls.length).toBeGreaterThan(0)

    mockClockCalls.length = 0
    // A feed frame invalidates the circles query, which lands here even while
    // the user is looking at another tab.
    publish(() => {
      mockCircle = { ...homeCircle, unreadEventCount: 3 }
    })

    expect(mockClockCalls).toEqual([])
  })

  it("re-renders only the row a new feed event added", async () => {
    const existing = [eventAt("2026-09-01T09:00:00.000Z"), eventAt("2026-09-01T10:00:00.000Z")]
    mockEventsData = { pages: [{ items: existing }] }

    await renderActivity()
    mockClockCalls.length = 0

    const arrived = eventAt("2026-09-01T11:00:00.000Z")
    // Exactly what realtime.ts does with an `event` frame: rebuild page 0 with
    // the new event in front, leaving every other event's identity alone.
    publish(() => {
      mockEventsData = { pages: [{ items: [arrived, ...existing] }] }
    })

    expect(mockClockCalls).toEqual([arrived.occurredAt])
  })
})

describe("ActivityScreen while loading and after a failure", () => {
  beforeEach(() => {
    mockCircle = { ...homeCircle }
    mockEventsData = undefined
    mockEventsStatus = { isLoading: false, isError: false }
    mockCirclesStatus = { isLoading: false, isError: false }
    mockRefetchEvents.mockClear()
    mockRefetchCircles.mockClear()
  })

  it("shows a skeleton, not the empty state, while the feed loads", async () => {
    mockEventsStatus = { isLoading: true, isError: false }

    const { getByLabelText, queryByText } = await renderActivity()

    expect(getByLabelText(/^activity:loading/)).toBeTruthy()
    expect(queryByText(/^activity:empty( |$)/)).toBeNull()
  })

  it("shows the skeleton while it does not yet know which circle to load", async () => {
    // The feed query waits on the circle, and a query that is waiting is
    // not loading as far as TanStack Query is concerned.
    mockCircle = null
    mockCirclesStatus = { isLoading: true, isError: false }

    const { getByLabelText, queryByText } = await renderActivity()

    expect(getByLabelText(/^activity:loading/)).toBeTruthy()
    expect(queryByText(/^activity:empty( |$)/)).toBeNull()
  })

  it("says the feed could not load and tries again when asked", async () => {
    mockEventsStatus = { isLoading: false, isError: true }

    const { getByText, getByRole, queryByText, queryByLabelText } = await renderActivity()

    expect(getByText(/^activity:failed( |$)/)).toBeTruthy()
    expect(queryByText(/^activity:empty( |$)/)).toBeNull()
    expect(queryByLabelText(/^activity:loading/)).toBeNull()

    fireEvent.press(getByRole("button", { name: /^common:retry/ }))
    expect(mockRefetchEvents).toHaveBeenCalledTimes(1)
  })

  it("retries the circles when those are what failed", async () => {
    mockCircle = null
    mockCirclesStatus = { isLoading: false, isError: true }

    const { getByRole, queryByText } = await renderActivity()

    expect(queryByText(/^activity:empty( |$)/)).toBeNull()
    fireEvent.press(getByRole("button", { name: /^common:retry/ }))
    expect(mockRefetchCircles).toHaveBeenCalledTimes(1)
  })

  // With no circle the feed's query has no id, and refetching it anyway asks
  // the server for /circles/null/events. That is a 400, which a firewall in
  // front of the server can answer by locking the whole household out.
  it("pulls the circles again rather than a feed it has no circle for", async () => {
    mockCircle = null
    mockCirclesStatus = { isLoading: false, isError: true }

    const { UNSAFE_getByType } = await renderActivity()
    await act(async () => {
      UNSAFE_getByType(RefreshControl).props.onRefresh()
    })

    expect(mockRefetchCircles).toHaveBeenCalledTimes(1)
    expect(mockRefetchEvents).not.toHaveBeenCalled()
  })

  it("keeps the events it has when a later refresh fails", async () => {
    const kept = eventAt("2026-09-01T09:00:00.000Z")
    mockEventsData = { pages: [{ items: [kept] }] }
    mockEventsStatus = { isLoading: false, isError: true }

    const { getByText, queryByText } = await renderActivity()

    expect(getByText(kept.summary)).toBeTruthy()
    expect(queryByText(/^activity:failed( |$)/)).toBeNull()
  })

  it("shows the empty state once a load comes back with nothing", async () => {
    mockEventsData = { pages: [{ items: [] }] }

    const { getByText, queryByLabelText, queryByText } = await renderActivity()

    expect(getByText(/^activity:empty( |$)/)).toBeTruthy()
    expect(queryByLabelText(/^activity:loading/)).toBeNull()
    expect(queryByText(/^activity:failed( |$)/)).toBeNull()
  })
})
