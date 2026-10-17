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

let mockMember: CircleMember = {
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
let mockCircle = {
  id: "c1",
  name: "Family",
  role: "member",
  settings: { allowHistory: true },
}
const mockUseTrips = jest.fn((..._args: unknown[]) => ({ data: [] }))
let mockNudgeAnswer: unknown = { ok: true }
const mockNudge = jest.fn(async (..._args: unknown[]) => mockNudgeAnswer)
const mockTrailProps: unknown[] = []
const mockWatch = jest.fn(async () => ({ watching: true, seconds: 600 }))
const mockRefreshMember = jest.fn(async () => ({ asked: "socket" }))
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock("../hooks/queries", () => ({
  useCircle: () => mockCircle,
  useMember: () => mockMember,
  usePresence: () => ({ data: mockPresence }),
  usePlaces: () => ({ data: [] }),
  useTrips: (...args: unknown[]) => mockUseTrips(...args),
  useNudge: () => ({ mutateAsync: mockNudge, isPending: false }),
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

async function renderProfile(userId = "omar") {
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
          route={{ name: "MemberDetail", params: { circleId: "c1", userId } } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return utils
}

const memberAsFirstSeen = mockMember

beforeEach(() => {
  jest.clearAllMocks()
  mockTrailProps.length = 0
  mockPresence = [presenceFor("driving")]
  mockMember = memberAsFirstSeen
  mockCircle = { id: "c1", name: "Family", role: "member", settings: { allowHistory: true } }
  mockNudgeAnswer = { ok: true }
  const { remove } = require("../utils/storage") as typeof import("../utils/storage")
  remove("nudge-budget")
})

const lastToast = () =>
  (require("../stores/toast") as typeof import("../stores/toast")).useToastStore.getState().current

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

  // A parked phone goes live too, a fix a second, and somebody waiting at
  // the door for a child to come out of school wants to see the moment the
  // dot moves.
  it("is offered while they are parked", async () => {
    mockPresence = [presenceFor("still")]
    const screen = await renderProfile()
    expect(screen.getByText(/member:live/)).toBeTruthy()
  })

  // The Live page says when a phone does not answer, and why.
  it("is offered when their phone has said nothing for minutes", async () => {
    mockPresence = [presenceFor("driving", 5 * 60_000)]
    const screen = await renderProfile()
    expect(screen.getByText(/member:live/)).toBeTruthy()
  })

  it("is not offered while they share approximately", async () => {
    mockPresence = [{ ...presenceFor("still"), approximate: true, sharingState: "approximate" }]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:live/)).toBeNull()
  })

  it("is not offered while they are paused", async () => {
    mockPresence = [{ ...presenceFor("still"), lat: null, lon: null, sharingState: "paused" }]
    const screen = await renderProfile()
    expect(screen.queryByText(/member:live/)).toBeNull()
  })

  it("is never offered on your own profile", async () => {
    mockPresence = [{ ...presenceFor("driving"), userId: "ana" }]
    const screen = await renderProfile("ana")
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

  // Somebody removed from the circle while on this page would be refused
  // with a 403 for asking.
  it("does not ask for a circle the list no longer holds", async () => {
    mockCircle = null as never
    await renderProfile()
    expect(mockRefreshMember).not.toHaveBeenCalled()
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
  })
})

describe("a phone allowed only approximate location", () => {
  // Its positions keep coming, kilometres wide, and nothing said why.
  it("says so on the profile while its fixes are fresh", async () => {
    mockPresence = [{ ...presenceFor("still"), issues: ["precise_location"] }]
    const screen = await renderProfile()
    expect(screen.getByText(/map:preciseOff/)).toBeTruthy()
  })
})

describe("the profile map", () => {
  it("does not draw the day's trail", async () => {
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

describe("their trips", () => {
  const asked = () => [...new Set(mockUseTrips.mock.calls.map((call) => call[2]))]

  it("are asked for while they share precisely with a circle that keeps history", async () => {
    await renderProfile()
    expect(asked()).toEqual([true])
  })

  // The server answers these with an empty list, and asking at all is a
  // request a firewall in front of it may count against the household.
  it("are not asked for while they share approximately", async () => {
    mockPresence = [{ ...presenceFor("still"), approximate: true, sharingState: "approximate" }]
    await renderProfile()
    expect(asked()).toEqual([false])
  })

  it("are not asked for while they are paused", async () => {
    mockPresence = [{ ...presenceFor("still"), lat: null, lon: null, sharingState: "paused" }]
    await renderProfile()
    expect(asked()).toEqual([false])
  })

  it("are not asked for in a circle that has history turned off", async () => {
    mockCircle = { ...mockCircle, settings: { allowHistory: false } }
    await renderProfile()
    expect(asked()).toEqual([false])
  })
})

describe("asking for their location", () => {
  it("says what became of the ask rather than that it worked", async () => {
    mockNudgeAnswer = { ok: true, notified: "sent", asked: "no_device" }
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/map:nudge/))
    await act(async () => {})
    expect(lastToast()?.message).toContain("member:askedNoDevice")
  })

  it("says the phone is updating when its channel carried the ask", async () => {
    mockNudgeAnswer = { ok: true, notified: "sent", asked: "socket" }
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/map:nudge/))
    await act(async () => {})
    expect(lastToast()).toMatchObject({ tone: "success" })
    expect(lastToast()?.message).toContain("member:askedSocket")
  })

  it("says they had already been asked, when the server held a repeat", async () => {
    mockNudgeAnswer = { ok: true, notified: "held", asked: "held" }
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/map:nudge/))
    await act(async () => {})
    expect(lastToast()?.message).toContain("member:nudgeHeld")
  })

  it("says they are no longer in the circle when they have left it", async () => {
    mockNudgeAnswer = { ok: true, notified: "gone", asked: "unsupported" }
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/map:nudge/))
    await act(async () => {})
    expect(lastToast()?.message).toContain("member:nudgeGone")
  })

  it("says the same of a message to somebody who has left", async () => {
    mockNudgeAnswer = { ok: true, notified: "gone", asked: null }
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/messages:messageMember/))
    fireEvent.press(screen.getByTestId("option-call_me"))
    await act(async () => {})
    expect(lastToast()?.message).toContain("member:nudgeGone")
  })

  it("keeps the old words for a server that only says it is fine", async () => {
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/map:nudge/))
    await act(async () => {})
    expect(lastToast()?.message).toContain("map:nudged")
  })

  it("tells a person tapping to wait, before the server would refuse them", async () => {
    const { DEFAULTS } = require("@hearth/shared") as typeof import("@hearth/shared")
    const screen = await renderProfile()
    for (let i = 0; i <= DEFAULTS.phoneNudgesPerTenMinutes; i += 1) {
      fireEvent.press(screen.getByText(/map:nudge/))
      await act(async () => {})
    }
    expect(mockNudge).toHaveBeenCalledTimes(DEFAULTS.phoneNudgesPerTenMinutes)
    expect(lastToast()?.message).toContain("member:nudgeWait")
  })

  it("shares one budget with quick messages", async () => {
    const { DEFAULTS } = require("@hearth/shared") as typeof import("@hearth/shared")
    const screen = await renderProfile()
    for (let i = 0; i < DEFAULTS.phoneNudgesPerTenMinutes; i += 1) {
      fireEvent.press(screen.getByText(/map:nudge/))
      await act(async () => {})
    }
    fireEvent.press(screen.getByText(/messages:messageMember/))
    fireEvent.press(screen.getByTestId("option-call_me"))
    await act(async () => {})
    expect(mockNudge).toHaveBeenCalledTimes(DEFAULTS.phoneNudgesPerTenMinutes)
    expect(lastToast()?.message).toContain("member:nudgeWait")
  })
})

describe("a member who has paused sharing", () => {
  it("can still be sent a message, though not asked for a location", async () => {
    mockPresence = [{ ...presenceFor("still"), lat: null, lon: null, sharingState: "paused" }]
    const screen = await renderProfile()
    fireEvent.press(screen.getByText(/messages:messageMember/))
    fireEvent.press(screen.getByTestId("option-call_me"))
    await act(async () => {})
    expect(mockNudge).toHaveBeenCalledWith({ userId: "omar", quickKey: "call_me" })
  })
})

describe("removing a member", () => {
  it("is not offered to an admin for another admin, which only the owner may do", async () => {
    mockCircle = { ...mockCircle, role: "admin" }
    mockMember = { ...memberAsFirstSeen, role: "admin" }
    const screen = await renderProfile()
    expect(screen.queryByText(/member:remove/)).toBeNull()
  })

  it("is offered to an admin for a plain member", async () => {
    mockCircle = { ...mockCircle, role: "admin" }
    const screen = await renderProfile()
    expect(screen.getByText(/member:remove/)).toBeTruthy()
  })

  it("is offered to the owner for an admin", async () => {
    mockCircle = { ...mockCircle, role: "owner" }
    mockMember = { ...memberAsFirstSeen, role: "admin" }
    const screen = await renderProfile()
    expect(screen.getByText(/member:remove/)).toBeTruthy()
  })
})
