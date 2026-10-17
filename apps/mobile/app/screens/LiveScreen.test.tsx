import type {
  ActivityType,
  CircleMember,
  MemberPresence,
  PresenceIssue,
  WatchResponse,
} from "@hearth/shared"
import { AppState, RefreshControl } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react-native"

import { LiveScreen } from "./LiveScreen"
import { queryKeys } from "../hooks/queryKeys"
import { queryClient } from "../services/queryClient"
import { ThemeProvider } from "../theme/context"
import { mergeTrail } from "../utils/trail"

function presenceFor(
  activity: ActivityType,
  at: { lat: number; lon: number },
  speedMps: number,
  issues: PresenceIssue[] = [],
  /** How long ago the fix was taken. A page is opened on a fix from a while ago. */
  ageMs = 0,
): MemberPresence {
  return {
    userId: "sam",
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: 10,
    recordedAt: new Date(Date.now() - ageMs).toISOString(),
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
const mockEaseTo = jest.fn()
let mockMapProps: { onRegionWillChange?: (event: unknown) => void } = {}
let mockWatchResponse: WatchResponse
const mockWatch = jest.fn(async () => mockWatchResponse)
const mockUnwatch = jest.fn(async (..._args: unknown[]) => ({ ok: true }))
const mockLiveTrail = jest.fn(async (..._args: unknown[]) => [] as unknown[])
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }
const mockStopWatchingClosely = jest.fn()
const mockWatchClosely = jest.fn(() => mockStopWatchingClosely)

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
  endpoints: {
    locations: {
      watch: (...args: unknown[]) => mockWatch(...(args as [])),
      unwatch: (...args: unknown[]) => mockUnwatch(...args),
      liveTrail: (...args: unknown[]) => mockLiveTrail(...args),
    },
  },
}))
jest.mock("../services/realtime", () => ({
  realtime: {
    watchClosely: () => mockWatchClosely(),
    downSince: null,
    onStatusChange: () => () => {},
  },
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
      { children, cameraRef, ...props }: { children?: unknown; cameraRef?: { current: unknown } },
      _ref: unknown,
    ) {
      if (cameraRef) cameraRef.current = { flyTo: mockFlyTo, easeTo: mockEaseTo }
      mockMapProps = props
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
const mockActivateKeepAwake = jest.fn(async () => {})
const mockDeactivateKeepAwake = jest.fn(async () => {})
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: (...args: unknown[]) => mockActivateKeepAwake(...(args as [])),
  deactivateKeepAwake: (...args: unknown[]) => mockDeactivateKeepAwake(...(args as [])),
}))
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
    <QueryClientProvider client={queryClient}>
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
      </ThemeProvider>
    </QueryClientProvider>,
  )
  await act(async () => {})
  return utils
}

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters: number | null
}

/** Fixes a location frame carried, written where the socket writes them. */
async function socketFixes(fixes: Fix[]) {
  await act(async () => {
    queryClient.setQueryData<Fix[]>(queryKeys.liveTrail("c1", "sam"), (current) =>
      mergeTrail(current ?? [], fixes),
    )
    jest.advanceTimersByTime(0)
  })
}

const fixAt = (secondsAgo: number, lat: number, accuracyMeters: number | null = 5): Fix => ({
  lat,
  lon: START.lon,
  recordedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  accuracyMeters,
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  queryClient.clear()
  mockMapProps = {}
  mockWatch.mockImplementation(async () => mockWatchResponse)
  mockLiveTrail.mockImplementation(async () => [])
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
    supports: { release: true, trail: true },
  }
  // What is on the map when the page opens: where they were a minute ago.
  mockPresence = [presenceFor("driving", START, 11.1, [], 60_000)]
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

    // Half a minute on, that fix is no longer where they are now.
    await wait(31_000)
    await act(async () => {
      await screen.UNSAFE_getByType(RefreshControl).props.onRefresh()
    })
    expect(mockWatch).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/live:asking/)).toBeTruthy()
  })
})

describe("the screen itself", () => {
  it("holds the display on while it is open, and lets it sleep again when it closes", async () => {
    // Following someone along a road is watching, not reading: a screen
    // that dims after fifteen seconds is the page not working.
    const screen = await renderLive()
    expect(mockActivateKeepAwake).toHaveBeenCalledTimes(1)
    expect(mockDeactivateKeepAwake).not.toHaveBeenCalled()
    screen.unmount()
    expect(mockDeactivateKeepAwake).toHaveBeenCalledTimes(1)
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
    mockPresence = [{ ...presenceFor("still", START, 0, [], 20 * 60_000), stale: true }]
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

  it("does not draw a grid cell into the trail when they turn to approximate", async () => {
    await renderLive()
    await move(presenceFor("driving", ON, 12))
    await move({
      ...presenceFor("driving", { lat: 33.71, lon: 73.06 }, 0),
      approximate: true,
      sharingState: "approximate",
    })
    expect(lastTrail().map((point) => point.lat)).not.toContain(33.71)
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

    const calls = mockEaseTo.mock.calls.map(([options]) => options as { zoom?: number })
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls[0]!.zoom).toBeDefined()
    expect(calls.slice(1).every((call) => call.zoom === undefined)).toBe(true)
  })

  // An upload carries several fixes, and only the newest moved the dot.
  it("draws every fix the socket carried, not one per upload", async () => {
    await renderLive()
    await socketFixes([fixAt(3, 33.7005), fixAt(2, 33.701), fixAt(1, 33.7015)])
    const lats = lastTrail().map((point) => point.lat)
    expect(lats).toEqual(expect.arrayContaining([33.7005, 33.701, 33.7015]))
  })

  it("keeps a fix far looser than the ones around it out of the trail", async () => {
    await renderLive()
    await socketFixes([
      fixAt(5, 33.7005),
      fixAt(4, 33.701),
      fixAt(3, 33.7015),
      fixAt(2, 33.709, 250),
      fixAt(1, 33.702),
    ])
    expect(lastTrail().map((point) => point.lat)).not.toContain(33.709)
  })

  it("fills in what it missed when the app comes back to the front", async () => {
    await renderLive()
    await socketFixes([fixAt(30, 33.701)])
    await setAppState("background")
    await wait(20_000)
    mockLiveTrail.mockResolvedValueOnce([fixAt(15, 33.703), fixAt(10, 33.705)])
    await setAppState("active")
    await wait(0)

    expect(mockLiveTrail).toHaveBeenCalledWith("c1", "sam", expect.any(String))
    expect(lastTrail().map((point) => point.lat)).toEqual(
      expect.arrayContaining([33.701, 33.703, 33.705]),
    )
  })

  it("does not ask a server without the fill for one", async () => {
    mockWatchResponse = { ...mockWatchResponse, supports: undefined }
    await renderLive()
    await socketFixes([fixAt(30, 33.701)])
    await setAppState("background")
    await setAppState("active")
    await wait(0)
    expect(mockLiveTrail).not.toHaveBeenCalled()
  })
})

describe("following them on the map", () => {
  it("glides to each fix in a straight line, quickly", async () => {
    await renderLive()
    await move(presenceFor("driving", ON, 12))
    const last = mockEaseTo.mock.calls.at(-1)![0] as { easing?: string; duration?: number }
    expect(last.easing).toBe("linear")
    expect(last.duration).toBeLessThanOrEqual(1_000)
    expect(mockFlyTo).not.toHaveBeenCalled()
  })

  it("stops following once the viewer moves the map, and follows again when asked", async () => {
    const screen = await renderLive()
    await move(presenceFor("driving", ON, 12))
    await act(async () => {
      mockMapProps.onRegionWillChange?.({ nativeEvent: { userInteraction: true } })
    })
    mockEaseTo.mockClear()
    await move(presenceFor("driving", { lat: 33.704, lon: 73.05 }, 12))
    expect(mockEaseTo).not.toHaveBeenCalled()

    fireEvent.press(screen.getByLabelText(/live:follow/))
    expect(mockEaseTo).toHaveBeenCalledTimes(1)
    await move(presenceFor("driving", { lat: 33.706, lon: 73.05 }, 12))
    expect(mockEaseTo).toHaveBeenCalledTimes(2)
  })

  it("keeps following when the map moved on its own", async () => {
    await renderLive()
    await act(async () => {
      mockMapProps.onRegionWillChange?.({ nativeEvent: { userInteraction: false } })
    })
    mockEaseTo.mockClear()
    await move(presenceFor("driving", ON, 12))
    expect(mockEaseTo).toHaveBeenCalledTimes(1)
  })
})

describe("letting go of their phone", () => {
  // Nothing ended a watch, so the phone stayed on a fix a second for up to
  // ten minutes after the viewer left.
  it("releases the watch when the page closes", async () => {
    const screen = await renderLive()
    screen.unmount()
    await wait(0)
    expect(mockUnwatch).toHaveBeenCalledWith("c1", "sam")
  })

  it("releases it in the background and asks afresh on the way back", async () => {
    await renderLive()
    await setAppState("background")
    expect(mockUnwatch).toHaveBeenCalledTimes(1)
    await wait(30_000)
    await setAppState("active")
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  // Pulling down Control Centre makes the app inactive with the page still
  // on screen.
  it("goes on holding while the app is only inactive", async () => {
    await renderLive()
    await setAppState("inactive")
    await wait(60_000)
    expect(mockUnwatch).not.toHaveBeenCalled()
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  it("does not send a release to a server that cannot take one", async () => {
    mockWatchResponse = { ...mockWatchResponse, supports: undefined }
    const screen = await renderLive()
    screen.unmount()
    await wait(0)
    expect(mockUnwatch).not.toHaveBeenCalled()
  })

  it("asks again at once on coming back to the page, after letting go", async () => {
    let answer: (value: { ok: boolean }) => void = () => {}
    mockUnwatch.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => (answer = resolve)),
    )
    await renderLive()
    await setAppState("background")
    await setAppState("active")
    // The ask waits for the release, so the two land in order.
    expect(mockWatch).toHaveBeenCalledTimes(1)
    await act(async () => answer({ ok: true }))
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  it("checks its socket closely while open, and stops when it closes", async () => {
    const screen = await renderLive()
    expect(mockWatchClosely).toHaveBeenCalledTimes(1)
    screen.unmount()
    expect(mockStopWatchingClosely).toHaveBeenCalledTimes(1)
  })
})

describe("asking often", () => {
  // The server takes sixty asks in ten minutes, and a 429 is a 4xx a
  // firewall in front of it can lock the household out for.
  it("asks at most once in ten seconds, however often the viewer pulls", async () => {
    const screen = await renderLive()
    await wait(11_000)
    for (let n = 0; n < 5; n += 1) {
      await act(async () => {
        await screen.UNSAFE_getByType(RefreshControl).props.onRefresh()
      })
    }
    expect(mockWatch).toHaveBeenCalledTimes(2)
    await wait(10_000)
    expect(mockWatch).toHaveBeenCalledTimes(3)
  })

  it("says the server is busy rather than unreachable when it says too many", async () => {
    mockWatch.mockRejectedValue(Object.assign(new Error("Too many requests"), { status: 429 }))
    const screen = await renderLive()
    expect(screen.getByText(/live:reason_busy/)).toBeTruthy()
    expect(screen.queryByText(/live:reason_unreachable/)).toBeNull()
  })
})
