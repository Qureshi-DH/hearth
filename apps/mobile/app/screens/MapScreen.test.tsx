import { AppState, StyleSheet } from "react-native"
import type { CircleMember, MemberPresence } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, render } from "@testing-library/react-native"

import { MapScreen } from "./MapScreen"
import { ThemeProvider } from "../theme/context"

/** userId of every MemberRow body that ran, in order, since the last reset. */
const mockRowRenders: string[] = []

// The screen ties its minute ticker to being on screen, so focus is no longer
// something the test can stub away: it decides whether the clock runs at all.
let mockFocused = true
const mockFocusListeners = new Set<() => void>()
const mockSubscribeFocus = (listener: () => void) => {
  mockFocusListeners.add(listener)
  return () => {
    mockFocusListeners.delete(listener)
  }
}
const mockReadFocused = () => mockFocused

async function setFocused(focused: boolean) {
  await act(async () => {
    mockFocused = focused
    mockFocusListeners.forEach((listener) => listener())
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

let mockPresence: MemberPresence[] = []
const mockPresenceListeners = new Set<() => void>()
const mockSubscribePresence = (listener: () => void) => {
  mockPresenceListeners.add(listener)
  return () => {
    mockPresenceListeners.delete(listener)
  }
}
const mockReadPresence = () => mockPresence

function presenceFor(userId: string, lat: number): MemberPresence {
  return {
    userId,
    lat,
    lon: -0.1,
    accuracyMeters: 10,
    recordedAt: new Date().toISOString(),
    batteryLevel: 0.8,
    isCharging: false,
    activity: "walking",
    speedMps: 1.2,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: false,
    atPlace: null,
    sosAlertId: null,
  }
}

function memberFor(userId: string): CircleMember {
  return {
    userId,
    circleId: "circle-1",
    user: { id: userId, displayName: userId, avatarUrl: null, avatarColor: "#888" },
    role: "member",
    nickname: null,
    sharingState: "precise",
    pausedUntil: null,
    joinedAt: new Date().toISOString(),
    notifications: { muted: [], mutedUntil: null },
  }
}

const mockMembers = ["ana", "ben", "cat", "dee"].map(memberFor)
const mockCircle = {
  id: "circle-1",
  name: "Home",
  emoji: "🏠",
  memberCount: 4,
  unreadEventCount: 0,
}

jest.mock("../components/MemberRow", () => {
  const actual = jest.requireActual("../components/MemberRow")
  const react = require("react")
  return {
    ...actual,
    MemberRow: (props: { member: { userId: string } }) => {
      mockRowRenders.push(props.member.userId)
      return react.createElement(actual.MemberRow, props)
    },
  }
})

// The real map, sheet and marker hosts need native views. Only their tree shape
// matters here, and the FlatList underneath the sheet is the real one because
// its PureComponent cells are half of what is under test.
jest.mock("../components/HearthMap", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    HearthMap: ({ children }: { children?: unknown }) =>
      react.createElement(rn.View, null, children),
    TrailLayer: () => null,
  }
})
jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Marker: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("@gorhom/bottom-sheet", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
    BottomSheetFlatList: rn.FlatList,
  }
})
jest.mock("react-native-gesture-handler", () => {
  const rn = require("react-native")
  return { GestureHandlerRootView: rn.View }
})
jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  const entering = { duration: () => entering }
  return {
    __esModule: true,
    default: {
      View: rn.View,
      Text: rn.Text,
      createAnimatedComponent: (component: unknown) => component,
    },
    createAnimatedComponent: (component: unknown) => component,
    Easing: { linear: (value: number) => value, inOut: (fn: unknown) => fn },
    cancelAnimation: () => {},
    useSharedValue: (initial: number) => react.useRef({ value: initial }).current,
    useAnimatedStyle: (worklet: () => object) => worklet(),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    FadeInUp: entering,
    FadeOutUp: entering,
  }
})

jest.mock("../hooks/queries", () => {
  const react = require("react")
  return {
    useMembers: () => ({ data: mockMembers }),
    usePresence: () => ({
      data: react.useSyncExternalStore(mockSubscribePresence, mockReadPresence),
    }),
    useActiveSos: () => ({ data: [] }),
    useHistory: () => ({ data: null }),
  }
})
jest.mock("../hooks/useActiveCircle", () => ({
  useActiveCircle: () => ({
    circle: mockCircle,
    circles: [mockCircle],
    isLoading: false,
    setActiveCircle: jest.fn(),
  }),
}))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "ana" }, serverInfo: null }),
}))
jest.mock("../stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ units: "metric", showTrails: false }),
}))
jest.mock("../stores/tracking", () => {
  const useTrackingStore = (selector: (state: unknown) => unknown) =>
    selector({ permission: "always", servicesEnabled: true, enabled: true })
  // The focus effect reads the store outside React to record the permission.
  useTrackingStore.getState = () => ({ setPermission: () => {} })
  return { useTrackingStore }
})
jest.mock("../services/location/tracker", () => ({
  currentPermission: jest.fn(async () => "always"),
  flush: jest.fn(async () => {}),
}))
// Close enough to the real thing for what is under test: the effect runs while
// the screen is focused and is torn down when it is not.
jest.mock("@react-navigation/native", () => {
  const react = require("react")
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = react.useSyncExternalStore(mockSubscribeFocus, mockReadFocused)
      react.useEffect(() => (focused ? effect() : undefined), [effect, focused])
    },
  }
})

const navigation = { navigate: jest.fn(), goBack: jest.fn() }

async function renderMap() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <MapScreen navigation={navigation as never} route={{ name: "Map" } as never} />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Icon fonts resolve asynchronously; settling here keeps the update in act.
  await act(async () => {})
  return utils
}

/** Every node in the tree whose flattened style satisfies `match`. */
function styledNodes(node: unknown, match: (style: Record<string, unknown>) => boolean): any[] {
  if (!node || typeof node !== "object") return []
  if (Array.isArray(node)) return node.flatMap((child) => styledNodes(child, match))
  const element = node as { props?: { style?: unknown }; children?: unknown }
  const style = StyleSheet.flatten(element.props?.style as never) as
    Record<string, unknown> | undefined
  const self = style && match(style) ? [{ node: element, style }] : []
  return [...self, ...styledNodes(element.children, match)]
}

describe("MapScreen member sheet", () => {
  beforeEach(() => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockRowRenders.length = 0
    mockFocused = true
    navigation.navigate.mockClear()
    ;(AppState.addEventListener as jest.Mock).mockClear()
  })

  it("re-renders only the member whose presence changed on a location frame", async () => {
    await renderMap()
    expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))

    mockRowRenders.length = 0
    // Exactly what the websocket handler does with a `location` frame: copy the
    // array and replace the one entry, leaving the other objects identical.
    const next = mockPresence.slice()
    next[2] = { ...next[2]!, lat: 52.5 }
    await act(async () => {
      mockPresence = next
      mockPresenceListeners.forEach((listener) => listener())
    })

    expect(mockRowRenders).toEqual(["cat"])
  })

  it("still re-renders a member whose own presence changed", async () => {
    await renderMap()
    mockRowRenders.length = 0
    const next = mockPresence.slice()
    next[0] = { ...next[0]!, batteryLevel: 0.1 }
    await act(async () => {
      mockPresence = next
      mockPresenceListeners.forEach((listener) => listener())
    })
    expect(mockRowRenders).toEqual(["ana"])
  })

  it("keeps the relative time ticking when nobody in the circle moves", async () => {
    jest.useFakeTimers()
    try {
      await renderMap()
      mockRowRenders.length = 0
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops the clock, and its timer, while the user is on another tab", async () => {
    jest.useFakeTimers()
    try {
      await renderMap()
      await setFocused(false)
      mockRowRenders.length = 0

      act(() => {
        jest.advanceTimersByTime(10 * 60_000)
      })

      expect(mockRowRenders).toEqual([])
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("catches every row up on return rather than waiting for the next minute", async () => {
    jest.useFakeTimers()
    try {
      await renderMap()
      await setFocused(false)
      act(() => {
        jest.advanceTimersByTime(10 * 60_000)
      })
      mockRowRenders.length = 0

      await setFocused(true)
      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))

      mockRowRenders.length = 0
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops the clock in the background and runs it again on foreground", async () => {
    jest.useFakeTimers()
    try {
      await renderMap()
      await setAppState("background")
      mockRowRenders.length = 0

      act(() => {
        jest.advanceTimersByTime(10 * 60_000)
      })
      expect(mockRowRenders).toEqual([])
      expect(jest.getTimerCount()).toBe(0)

      await setAppState("active")
      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))

      mockRowRenders.length = 0
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps the clock running through the transitional inactive state", async () => {
    jest.useFakeTimers()
    try {
      await renderMap()
      await setAppState("inactive")
      mockRowRenders.length = 0

      act(() => {
        jest.advanceTimersByTime(60_000)
      })

      expect(new Set(mockRowRenders)).toEqual(new Set(["ana", "ben", "cat", "dee"]))
    } finally {
      jest.useRealTimers()
    }
  })

  it("moves the map controls with a transform rather than a layout offset", async () => {
    const { toJSON } = await renderMap()
    const controls = styledNodes(
      toJSON(),
      (style) => style.position === "absolute" && style.gap != null && style.left == null,
    )
    expect(controls).toHaveLength(1)
    expect(controls[0].style.transform).toEqual([{ translateY: -108 }])
    expect(controls[0].style.top).toBe(0)
  })
})
