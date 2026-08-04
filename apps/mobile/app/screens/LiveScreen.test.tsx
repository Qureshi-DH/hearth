import type { ActivityType, CircleMember, MemberPresence } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, render } from "@testing-library/react-native"

import { LiveScreen } from "./LiveScreen"
import { ThemeProvider } from "../theme/context"

function presenceFor(
  activity: ActivityType,
  at: { lat: number; lon: number },
  speedMps: number,
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
    issues: [],
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

async function move(presence: MemberPresence) {
  await act(async () => {
    mockPresence = [presence]
    mockPresenceListeners.forEach((listener) => listener())
  })
}

const mockTrailProps: Array<{
  points?: Array<{ lat: number; lon: number }>
  segments?: Array<Array<{ lat: number; lon: number }>>
}> = []
const mockGapProps: Array<{ gaps: unknown[] }> = []
const mockFlyTo = jest.fn()
const mockWatch = jest.fn(async () => ({ watching: true, seconds: 600 }))
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
jest.mock("../stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ units: "metric", streetNames: true }),
}))
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
  mockTrailProps.length = 0
  mockGapProps.length = 0
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

describe("the live view", () => {
  it("asks the phone to go live at once, and again each minute to stay so", async () => {
    await renderLive()
    expect(mockWatch).toHaveBeenCalledTimes(1)
    expect(mockWatch).toHaveBeenCalledWith("c1", "sam")

    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockWatch).toHaveBeenCalledTimes(2)
  })

  it("shows the speed they are doing and where they are", async () => {
    const screen = await renderLive()
    expect(screen.getByText(/40 km\/h/)).toBeTruthy()
    // Translations are keys under test, so the street shows as the "near"
    // line and the lookup is checked by what it was asked about.
    expect(screen.getByText(/map:near/)).toBeTruthy()
    expect(mockNearby).toHaveBeenCalledWith(START.lat, START.lon)
  })

  it("draws the trail as the fixes arrive", async () => {
    await renderLive()
    await move(presenceFor("driving", { lat: 33.702, lon: 73.05 }, 12))
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
    await move(presenceFor("driving", { lat: 33.702, lon: 73.05 }, 12))
    // Twenty minutes and three kilometres later: the app was in the
    // background and the socket closed. The road between is a guess.
    await act(async () => {
      jest.advanceTimersByTime(20 * 60_000)
    })
    await move(presenceFor("driving", { lat: 33.73, lon: 73.05 }, 12))
    await move(presenceFor("driving", { lat: 33.732, lon: 73.05 }, 12))

    const trail = mockTrailProps[mockTrailProps.length - 1]!
    expect(trail.segments).toHaveLength(2)
    const gaps = mockGapProps[mockGapProps.length - 1]!
    expect(gaps.gaps).toHaveLength(1)
  })

  it("keeps the viewer's zoom after the first fix", async () => {
    await renderLive()
    await move(presenceFor("driving", { lat: 33.702, lon: 73.05 }, 12))
    await move(presenceFor("driving", { lat: 33.704, lon: 73.05 }, 12))

    const calls = mockFlyTo.mock.calls.map(([options]) => options as { zoom?: number })
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls[0]!.zoom).toBeDefined()
    expect(calls.slice(1).every((call) => call.zoom === undefined)).toBe(true)
  })

  it("says so when they stop", async () => {
    const screen = await renderLive()
    await move(presenceFor("still", { lat: 33.704, lon: 73.05 }, 0))
    expect(screen.getByText(/live:stopped/)).toBeTruthy()
  })

  it("says paused rather than stopped when they paused sharing", async () => {
    const screen = await renderLive()
    await move({ ...presenceFor("driving", START, 11.1), sharingState: "paused" })
    expect(screen.queryByText(/live:stopped/)).toBeNull()
    expect(screen.getByText(/map:paused/)).toBeTruthy()
  })

  it("says the phone has gone quiet rather than stopped when the fix is stale", async () => {
    const screen = await renderLive()
    await move({ ...presenceFor("driving", START, 11.1), stale: true })
    expect(screen.queryByText(/live:stopped/)).toBeNull()
    expect(screen.getByText(/map:stale/)).toBeTruthy()
  })
})
