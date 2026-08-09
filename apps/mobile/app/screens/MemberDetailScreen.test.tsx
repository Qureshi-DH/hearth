import type { ActivityType, CircleMember, MemberPresence } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { MemberDetailScreen } from "./MemberDetailScreen"
import { ThemeProvider } from "../theme/context"

function presenceFor(activity: ActivityType): MemberPresence {
  return {
    userId: "omar",
    lat: 33.7,
    lon: 73.05,
    accuracyMeters: 10,
    recordedAt: new Date().toISOString(),
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
  endpoints: { locations: { watch: (...args: unknown[]) => mockWatch(...(args as [])) } },
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
// Sheets sit on reanimated, which has no native side here.
jest.mock("../components/OptionSheet", () => ({ OptionSheet: () => null }))
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

  it("opens the live view", async () => {
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/member:live/))
    expect(mockNavigation.navigate).toHaveBeenCalledWith("Live", {
      circleId: "c1",
      userId: "omar",
    })
  })

  it("leaves their phone alone until the live view is opened", async () => {
    await renderProfile()
    expect(mockWatch).not.toHaveBeenCalled()
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
