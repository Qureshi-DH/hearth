import type { ActivityType, CircleMember, MemberPresence } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { MemberDetailScreen } from "./MemberDetailScreen"
import { ThemeProvider } from "../theme/context"

function presenceFor(activity: ActivityType, ageMs = 0): MemberPresence {
  return {
    userId: "omar",
    lat: 33.7,
    lon: 73.05,
    accuracyMeters: 10,
    recordedAt: new Date(Date.now() - ageMs).toISOString(),
    batteryLevel: 0.6,
    isCharging: false,
    activity,
    speedMps: activity === "driving" ? 11 : 0,
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
  userId: "omar",
  circleId: "c1",
  user: { id: "omar", displayName: "Omar", avatarUrl: null, avatarColor: "#888" },
  role: "member",
  nickname: null,
  sharingState: "precise",
  pausedUntil: null,
  joinedAt: new Date().toISOString(),
  notifications: { muted: [], mutedUntil: null },
}

let mockPresence: MemberPresence[] = []
let mockHistory: Array<{ lat: number; lon: number; recordedAt: string }> | null = null
const mockTrailProps: unknown[] = []
const mockWatch = jest.fn(async () => ({ watching: true, seconds: 600 }))
const mockRefreshMember = jest.fn(async () => ({ asked: "socket" }))
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock("../hooks/queries", () => ({
  useCircle: () => ({ id: "c1", name: "Family", role: "member", settings: { allowHistory: true } }),
  useMember: () => mockMember,
  usePresence: () => ({ data: mockPresence }),
  usePlaces: () => ({ data: [] }),
  useTrips: () => ({ data: [] }),
  useHistory: () => ({ data: mockHistory }),
  useNudge: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateMember: () => ({ mutate: jest.fn() }),
  useRemoveMember: () => ({ mutateAsync: jest.fn() }),
}))
jest.mock("../hooks/useNearby", () => ({ useNearby: () => null }))
jest.mock("../services/api", () => ({
  endpoints: {
    locations: {
      watch: (...args: unknown[]) => mockWatch(...(args as [])),
      refreshMember: (...args: unknown[]) => mockRefreshMember(...(args as [])),
    },
  },
}))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "ana" } }),
}))
jest.mock("../stores/settings", () => {
  const state = { units: "metric", streetNames: false, haptics: true }
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
      { children }: { children?: unknown },
      _ref: unknown,
    ) {
      return react.createElement(rn.View, null, children)
    }),
    PlaceLayers: () => null,
    TrailLayer: (props: unknown) => {
      mockTrailProps.push(props)
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
// Sheets sit on reanimated, which has no native side here. The options are
// drawn as plain buttons so a test can pick one.
jest.mock("../components/OptionSheet", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    OptionSheet: ({
      visible,
      options,
    }: {
      visible: boolean
      options: Array<{ key: string; label?: string; onPress: () => void }>
    }) =>
      visible
        ? react.createElement(
            rn.View,
            null,
            options.map((option) =>
              react.createElement(
                rn.Pressable,
                { key: option.key, testID: `option-${option.key}`, onPress: option.onPress },
                react.createElement(rn.Text, null, option.label ?? option.key),
              ),
            ),
          )
        : null,
  }
})
jest.mock("../components/PromptDialog", () => ({ PromptDialog: () => null }))
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

async function renderProfile() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <MemberDetailScreen
          navigation={mockNavigation as never}
          route={{ name: "MemberDetail", params: { circleId: "c1", userId: "omar" } } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return utils
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTrailProps.length = 0
  mockHistory = null
  mockPresence = [presenceFor("driving")]
})

describe("saving where they are as a place", () => {
  it("is offered when they are settled somewhere the family has not named", async () => {
    mockPresence = [presenceFor("still")]
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/member:savePlace/))
    expect(mockNavigation.navigate).toHaveBeenCalledWith("PlaceEditor", {
      circleId: "c1",
      lat: 33.7,
      lon: 73.05,
      name: undefined,
    })
  })

  it("is not offered where they already are somewhere named", async () => {
    mockPresence = [
      { ...presenceFor("still"), atPlace: { id: "p1", name: "Home", icon: "home", since: null } },
    ]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:savePlace/)).toBeNull()
  })

  it("is not offered while they are travelling, since they are not anywhere yet", async () => {
    mockPresence = [presenceFor("driving")]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:savePlace/)).toBeNull()
  })

  it("is not offered when nothing is known about where they are", async () => {
    mockPresence = []
    const screen = await renderProfile()
    expect(screen.queryByText(/member:savePlace/)).toBeNull()
  })
})

describe("Live on a member's profile", () => {
  it("is offered while the member is on the move", async () => {
    const screen = await renderProfile()
    expect(screen.getByText(/member:live/)).toBeTruthy()
  })

  it("is not offered while they are parked", async () => {
    mockPresence = [presenceFor("still")]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:live/)).toBeNull()
  })

  // A phone that is travelling uploads every half minute. One that has said
  // nothing for minutes is out of signal or asleep, and asking it to go live
  // only spins on "asking". The button is a promise that it will work.
  it("is not offered when their phone has said nothing for minutes, however it was last moving", async () => {
    mockPresence = [presenceFor("driving", 5 * 60_000)]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:live/)).toBeNull()
  })

  it("is offered on a fix from moments ago", async () => {
    mockPresence = [presenceFor("driving", 20_000)]
    const screen = await renderProfile()
    expect(screen.getByText(/member:live/)).toBeTruthy()
  })

  it("opens the live view", async () => {
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/member:live/))
    expect(mockNavigation.navigate).toHaveBeenCalledWith("Live", {
      circleId: "c1",
      userId: "omar",
    })
  })

  it("does not put their phone on live updates just for being opened", async () => {
    await renderProfile()
    expect(mockWatch).not.toHaveBeenCalled()
  })

  it("asks their phone for one fresh fix the moment it opens", async () => {
    await renderProfile()
    expect(mockRefreshMember).toHaveBeenCalledTimes(1)
    expect(mockRefreshMember).toHaveBeenCalledWith("c1", "omar")
  })

  it("asks even before any presence has arrived for them", async () => {
    mockPresence = []
    await renderProfile()
    expect(mockRefreshMember).toHaveBeenCalledTimes(1)
  })
})

describe("what a quiet phone says about itself", () => {
  it("is named under the member, in the words the map uses", async () => {
    mockPresence = [
      {
        ...presenceFor("unknown"),
        recordedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
        stale: true,
        issues: ["background_restricted"],
      },
    ]
    const screen = await renderProfile()
    expect(screen.getByText(/map:issue_background_restricted/)).toBeTruthy()
    // A phone the OS holds back is not on the move, whatever it last said.
    expect(screen.queryByText(/member:live/)).toBeNull()
  })
})

describe("the profile map", () => {
  it("does not draw the day's trail", async () => {
    mockHistory = [
      { lat: 33.7, lon: 73.05, recordedAt: new Date().toISOString() },
      { lat: 33.71, lon: 73.05, recordedAt: new Date().toISOString() },
      { lat: 33.72, lon: 73.05, recordedAt: new Date().toISOString() },
    ]
    await renderProfile()
    expect(mockTrailProps).toHaveLength(0)
  })
})

describe("a quick message", () => {
  it("says which message went, not that a location was asked for", async () => {
    const { useToastStore } = require("../stores/toast") as typeof import("../stores/toast")
    const { getByText, getByTestId } = await renderProfile()
    fireEvent.press(getByText(/messages:messageMember/))
    fireEvent.press(getByTestId("option-slow_down"))
    await act(async () => {})
    const shown = useToastStore.getState().current
    expect(shown?.tone).toBe("success")
    // The translation layer is a stub here, so the key is what can be read.
    expect(shown?.message).toContain("member:messageSent")
    expect(shown?.message).not.toContain("nudged")
  })
})
