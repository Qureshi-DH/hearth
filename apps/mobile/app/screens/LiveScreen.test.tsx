import type {
  ActivityType,
  CircleMember,
  MemberPresence,
  PresenceIssue,
  WatchResponse,
} from "@hearth/shared"
import { AppState, RefreshControl } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { LiveScreen } from "./LiveScreen"
import { ThemeProvider } from "../theme/context"

function presenceFor(
  activity: ActivityType,
  at: { lat: number; lon: number },
  speedMps: number,
  issues: PresenceIssue[] = [],
): MemberPresence {
  return {
    userId: "sam",
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: 10,
    recordedAt: new Date().toISOString(),
    batteryLevel: 0.6,
    isCharging: false,
    activity,
    speedMps,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: false,
    atPlace: null,
    sosAlertId: null,
    issues,
  }
}

const mockMember: CircleMember = {
  userId: "sam",
  circleId: "c1",
  user: { id: "sam", displayName: "Sam", avatarUrl: null, avatarColor: "#888" },
  role: "member",
  nickname: null,
  sharingState: "precise",
  pausedUntil: null,
  joinedAt: new Date().toISOString(),
  notifications: { muted: [], mutedUntil: null },
}

let mockPresence: MemberPresence[] = []
const mockPresenceListeners = new Set<() => void>()
const mockSubscribePresence = (listener: () => void) => {
  mockPresenceListeners.add(listener)
  return () => {
    mockPresenceListeners.delete(listener)
  }
}
const mockReadPresence = () => mockPresence

/** A fix from the phone, a second on so it is newer than whatever was asked. */
async function move(presence: MemberPresence) {
  await act(async () => {
    jest.advanceTimersByTime(1_000)
    mockPresence = [{ ...presence, recordedAt: new Date().toISOString() }]
    mockPresenceListeners.forEach((listener) => listener())
  })
}

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}

/** Hands the screen's own AppState listeners a state change, as the OS would. */
async function setAppState(state: "active" | "background" | "inactive") {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(
    ([, listener]) => listener as (next: string) => void,
  )
  await act(async () => {
    listeners.forEach((listener) => listener(state))
  })
}

const mockTrailProps: Array<{
  points?: Array<{ lat: number; lon: number }>
  segments?: Array<Array<{ lat: number; lon: number }>>
}> = []
const mockGapProps: Array<{ gaps: unknown[] }> = []
const mockFlyTo = jest.fn()
let mockWatchResponse: WatchResponse
const mockWatch = jest.fn(async () => mockWatchResponse)
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock("../hooks/queries", () => {
  const react = require("react")
  return {
    useMember: () => mockMember,
    usePresence: () => ({
      data: react.useSyncExternalStore(mockSubscribePresence, mockReadPresence),
    }),
    usePlaces: () => ({ data: [] }),
  }
})
const mockNearby = jest.fn(() => "E-8")
jest.mock("../hooks/useNearby", () => ({
  useNearby: (...args: unknown[]) => mockNearby(...(args as [])),
}))
jest.mock("../services/api", () => ({
  endpoints: { locations: { watch: (...args: unknown[]) => mockWatch(...(args as [])) } },
}))
jest.mock("../stores/settings", () => {
  const state = { units: "metric", streetNames: true, hapticsEnabled: false }
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state)
  // A press reads the haptics setting outside React.
  useSettingsStore.getState = () => state
  return { useSettingsStore }
})
jest.mock("../components/HearthMap", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    HearthMap: react.forwardRef(function HearthMap(
      { children, cameraRef }: { children?: unknown; cameraRef?: { current: unknown } },
      _ref: unknown,
    ) {
      if (cameraRef) cameraRef.current = { flyTo: mockFlyTo }
      return react.createElement(rn.View, null, children)
    }),
    PlaceLayers: () => null,
    TrailLayer: (props: { points?: unknown; segments?: unknown }) => {
      mockTrailProps.push(props as never)
      return null
    },
    TrailGapLayer: (props: { gaps: unknown[] }) => {
      mockGapProps.push(props)
      return null
    },
  }
})
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
// The screen is not inside a navigator here, and its header is chrome.
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
jest.mock("../components/MemberMarker", () => ({
  MemberMarker: () => null,
  MEMBER_MARKER_LABEL_HEIGHT: 0,
}))
jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Marker: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("@react-navigation/native", () => {
  const react = require("react")
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      react.useEffect(() => effect(), [effect])
    },
  }
})

const START = { lat: 33.7, lon: 73.05 }
const ON = { lat: 33.702, lon: 73.05 }

async function renderLive() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <LiveScreen
          navigation={mockNavigation as never}
          route={{ name: "Live", params: { circleId: "c1", userId: "sam" } } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return utils
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockWatch.mockImplementation(async () => mockWatchResponse)
  ;(AppState.addEventListener as jest.Mock).mockClear()
  mockTrailProps.length = 0
  mockGapProps.length = 0
  mockWatchResponse = {
    watching: true,
    seconds: 600,
    pushed: "sent",
    lastFixAt: new Date().toISOString(),
    lastHeardAt: new Date().toISOString(),
    activity: "driving",
    issues: [],
  }
  mockPresence = [presenceFor("driving", START, 11.1)]
})

/** The points of the last drawn trail, whichever prop carried them. */
const lastTrail = () => {
  const last = mockTrailProps[mockTrailProps.length - 1]
  if (!last) return []
  return last.segments ? last.segments.flat() : (last.points ?? [])
}

afterEach(() => {
  jest.useRealTimers()
})

describe("asking the phone", () => {
  it("asks the phone to go live at once, and again each minute to stay so", async () => {
    await renderLive()
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockWatch).toHaveBeenCalledWith("c1", "sam")

    await wait(60_000)
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  it("asks again when the app comes back to the foreground", async () => {
    await renderLive()
    await setAppState("background")
    await wait(60_000)
    expect(mockWatch).toHaveBeenCalledTimes(1)

    await setAppState("active")
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  it("asks again on a pull, and judges the phone afresh from that ask", async () => {
    const screen = await renderLive()
    await move(presenceFor("driving", ON, 12))
    expect(screen.getByTestId("liveness-live")).toBeTruthy()

    await act(async () => {
      await screen.UNSAFE_getByType(RefreshControl).props.onRefresh()
    })
    expect(mockWatch).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/live:asking/)).toBeTruthy()
  })
})

describe("what the page claims", () => {
  it("is asking until a fix newer than the ask arrives, and shows only when it last saw them", async () => {
    const screen = await renderLive()
    expect(screen.getByText(/live:asking/)).toBeTruthy()
    expect(screen.getByTestId("liveness-asking")).toBeTruthy()
    expect(screen.queryByText(/km\/h/)).toBeNull()
    expect(screen.getByText(/live:lastSeen/)).toBeTruthy()
    expect(screen.getByText(/±10 m/)).toBeTruthy()
  })

  it("goes live on a fix newer than the ask, with their speed and street", async () => {
    const screen = await renderLive()
    await move(presenceFor("driving", ON, 12))
    expect(screen.getByTestId("liveness-live")).toBeTruthy()
    expect(screen.getByText("Sam")).toBeTruthy()
    expect(screen.getByText("43 km/h")).toBeTruthy()
    // Translations are keys under test, so the street shows as the "near"
    // line and the lookup is checked by what it was asked about.
    expect(screen.getByText(/map:near/)).toBeTruthy()
    expect(mockNearby).toHaveBeenCalledWith(ON.lat, ON.lon)
  })

  it("never shows a speed older than thirty seconds as what they are doing now", async () => {
    const screen = await renderLive()
    await move(presenceFor("driving", ON, 12))
    expect(screen.getByText("43 km/h")).toBeTruthy()

    await wait(31_000)
    expect(screen.queryByText("43 km/h")).toBeNull()
    // Translations render as bare keys under test, so the line is checked
    // by its key and the speed by its absence as a heading.
    expect(screen.getByText(/live:wasDoing/)).toBeTruthy()
    expect(screen.getByTestId("liveness-asking")).toBeTruthy()
  })

  it("says so when they stop", async () => {
    const screen = await renderLive()
    await move(presenceFor("still", ON, 0))
    expect(screen.getByText(/live:stopped/)).toBeTruthy()
  })

  it("does not call a phone stopped for a fix it had before asking", async () => {
    mockPresence = [{ ...presenceFor("still", START, 0), stale: true }]
    const screen = await renderLive()
    expect(screen.queryByText(/live:stopped/)).toBeNull()
    expect(screen.getByText(/live:asking/)).toBeTruthy()
  })

  it("says paused rather than anything else when they paused sharing", async () => {
    const screen = await renderLive()
    await move({ ...presenceFor("driving", START, 11.1), sharingState: "paused" })
    expect(screen.queryByText(/live:stopped/)).toBeNull()
    expect(screen.queryByText(/live:asking/)).toBeNull()
    expect(screen.getByText(/map:paused/)).toBeTruthy()
  })
})

describe("a phone that does not answer", () => {
  it.each([
    ["sent", "live:reason_sent"],
    ["held", "live:reason_sent"],
    ["no_device", "live:reason_no_device"],
    ["unsupported", "live:reason_unsupported"],
  ] as const)("after two minutes says so, and why (%s)", async (pushed, reason) => {
    mockWatchResponse = { ...mockWatchResponse, pushed }
    const screen = await renderLive()
    await wait(119_000)
    expect(screen.queryByText(/live:notAnswering/)).toBeNull()

    await wait(2_000)
    expect(screen.getByText(/live:notAnswering/)).toBeTruthy()
    expect(screen.getByText(new RegExp(reason))).toBeTruthy()
    expect(screen.getByTestId("liveness-unanswered")).toBeTruthy()
    expect(screen.queryByText(/km\/h/)).toBeNull()
  })

  it("names what the phone itself said is wrong", async () => {
    mockPresence = [presenceFor("driving", START, 11.1, ["service_stopped", "low_power_mode"])]
    const screen = await renderLive()
    await wait(121_000)
    expect(screen.getByText(/map:issue_service_stopped/)).toBeTruthy()
    expect(screen.getByText(/map:issue_low_power_mode/)).toBeTruthy()
  })

  it("says when the server itself could not be reached", async () => {
    mockWatch.mockRejectedValue(new Error("Network request failed"))
    const screen = await renderLive()
    await wait(121_000)
    expect(screen.getByText(/live:notAnswering/)).toBeTruthy()
    expect(screen.getByText(/live:reason_unreachable/)).toBeTruthy()
  })

  it("counts the silence from the last answer", async () => {
    const screen = await renderLive()
    await wait(100_000)
    await move(presenceFor("driving", ON, 12))
    await wait(100_000)
    expect(screen.queryByText(/live:notAnswering/)).toBeNull()

    await wait(21_000)
    expect(screen.getByText(/live:notAnswering/)).toBeTruthy()
  })
})

describe("the watch window", () => {
  it("says live ended when the holds stopped reaching the server, and starts again on request", async () => {
    const screen = await renderLive()
    mockWatch.mockRejectedValue(new Error("Network request failed"))
    await wait(601_000)
    expect(screen.getByText(/live:ended/)).toBeTruthy()
    expect(screen.queryByText(/live:notAnswering/)).toBeNull()

    mockWatch.mockResolvedValue(mockWatchResponse)
    fireEvent.press(screen.getByText(/live:startAgain/))
    await act(async () => {})
    expect(screen.queryByText(/live:ended/)).toBeNull()
    expect(screen.getByText(/live:asking/)).toBeTruthy()
  })

  it("is asked for afresh when the app comes back after the window lapsed", async () => {
    const screen = await renderLive()
    await setAppState("background")
    await wait(11 * 60_000)

    await setAppState("active")
    expect(screen.queryByText(/live:ended/)).toBeNull()
    expect(screen.getByText(/live:asking/)).toBeTruthy()
  })
})

describe("the trail", () => {
  it("draws the trail as the fixes arrive", async () => {
    await renderLive()
    await move(presenceFor("driving", ON, 12))
    await move(presenceFor("driving", { lat: 33.704, lon: 73.05 }, 12))

    const points = lastTrail()
    expect(points).toHaveLength(3)
    expect(points[0]).toMatchObject(START)
    expect(points[2]).toMatchObject({ lat: 33.704, lon: 73.05 })
  })

  it("does not draw a fix twice", async () => {
    await renderLive()
    await move(presenceFor("driving", START, 11.1))
    expect(lastTrail().length < 2).toBe(true)
  })

  it("dashes a stretch the phone was quiet for", async () => {
    await renderLive()
    await move(presenceFor("driving", ON, 12))
    // Twenty minutes and three kilometres later: the app was in the
    // background and the socket closed. The road between is a guess.
    await wait(20 * 60_000)
    await move(presenceFor("driving", { lat: 33.73, lon: 73.05 }, 12))
    await move(presenceFor("driving", { lat: 33.732, lon: 73.05 }, 12))

    const trail = mockTrailProps[mockTrailProps.length - 1]!
    expect(trail.segments).toHaveLength(2)
    const gaps = mockGapProps[mockGapProps.length - 1]!
    expect(gaps.gaps).toHaveLength(1)
  })

  it("keeps the viewer's zoom after the first fix", async () => {
    await renderLive()
    await move(presenceFor("driving", ON, 12))
    await move(presenceFor("driving", { lat: 33.704, lon: 73.05 }, 12))

    const calls = mockFlyTo.mock.calls.map(([options]) => options as { zoom?: number })
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls[0]!.zoom).toBeDefined()
    expect(calls.slice(1).every((call) => call.zoom === undefined)).toBe(true)
  })
})
