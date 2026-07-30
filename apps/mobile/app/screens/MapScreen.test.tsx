import { AppState, BackHandler, StyleSheet } from "react-native"
import type { CircleMember, MemberPresence } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { MapScreen } from "./MapScreen"
import { MEMBER_MARKER_LABEL_HEIGHT } from "../components/MemberMarker"
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
    issues: [],
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

/** Whatever the screen last handed the mocked sheet. */
let mockSheetProps: Record<string, any> = {}
const mockSnapToIndex = jest.fn()
let mockMapPress: (() => void) | null = null
let mockMapZoom: ((event: { nativeEvent: { zoom: number } }) => void) | null = null
const mockProject = jest.fn(async (_lngLat: [number, number]): Promise<[number, number]> => [0, 0])
let mockActiveSos: Array<{ id: string; user: { id: string; displayName: string } }> = []

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
    HearthMap: react.forwardRef(function HearthMap(
      {
        children,
        onPress,
        onRegionIsChanging,
      }: {
        children?: unknown
        onPress?: () => void
        onRegionIsChanging?: (event: { nativeEvent: { zoom: number } }) => void
      },
      ref: unknown,
    ) {
      mockMapPress = onPress ?? null
      mockMapZoom = onRegionIsChanging ?? null
      react.useImperativeHandle(ref, () => ({ project: mockProject }))
      return react.createElement(rn.View, null, children)
    }),
    TrailLayer: () => null,
  }
})
// The native marker reports a tap of its own on Android, so the fake exposes
// that path as a pressable host around the children.
jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Marker: ({
      children,
      onPress,
      offset,
      lngLat,
    }: {
      children?: unknown
      onPress?: () => void
      offset?: [number, number]
      lngLat?: [number, number]
    }) =>
      react.createElement(
        rn.Pressable,
        { testID: "native-marker", onPress, offset, lngLat },
        children,
      ),
  }
})
jest.mock("@gorhom/bottom-sheet", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    __esModule: true,
    default: react.forwardRef(({ children, ...props }: { children?: unknown }, ref: unknown) => {
      mockSheetProps = props
      react.useImperativeHandle(ref, () => ({ snapToIndex: mockSnapToIndex }))
      return react.createElement(rn.View, null, children)
    }),
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
    useDerivedValue: (worklet: () => unknown) => ({ value: worklet() }),
    useAnimatedStyle: (worklet: () => object) => worklet(),
    // Runs after every render, so a test that moves the sheet and re-renders
    // sees the reaction fire the way the UI thread mapper would.
    useAnimatedReaction: (
      prepare: () => unknown,
      respond: (next: unknown, previous: unknown) => void,
    ) => {
      const previous = react.useRef(null)
      react.useEffect(() => {
        const next = prepare()
        respond(next, previous.current)
        previous.current = next
      })
    },
    runOnJS: (fn: unknown) => fn,
    // Two stops and always clamped, which is the only way the screen calls it.
    interpolate: (value: number, [from, to]: number[], [low, high]: number[]) => {
      const t = Math.min(Math.max((value - from) / (to - from), 0), 1)
      return low + t * (high - low)
    },
    Extrapolation: { CLAMP: "clamp" },
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
    useActiveSos: () => ({ data: mockActiveSos }),
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
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({ units: "metric" }),
}))
let mockLastFix: { lat: number; lon: number; recordedAt: string; speedMps: number | null } | null =
  null
jest.mock("../stores/tracking", () => {
  const useTrackingStore = (selector: (state: unknown) => unknown) =>
    selector({ permission: "always", servicesEnabled: true, enabled: true, lastFix: mockLastFix })
  // The focus effect reads the store outside React to record the permission.
  useTrackingStore.getState = () => ({ setPermission: () => {} })
  return { useTrackingStore }
})
const mockRefresh = jest.fn(async (_circleId: string) => ({ asked: 0 }))
jest.mock("../services/api", () => ({
  endpoints: { locations: { refresh: (circleId: string) => mockRefresh(circleId) } },
}))
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

function mapTree(statusBar = 0) {
  return (
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: statusBar, left: 0, right: 0, bottom: 0 },
        }}
      >
        <MapScreen navigation={navigation as never} route={{ name: "Map" } as never} />
      </SafeAreaProvider>
    </ThemeProvider>
  )
}

async function renderMap(statusBar = 0) {
  const utils = render(mapTree(statusBar))
  // Icon fonts resolve asynchronously; settling here keeps the update in act.
  await act(async () => {})
  return utils
}

/** Puts the sheet's top edge at `y`, as a drag would, and lets the screen catch up. */
async function moveSheetTo(utils: ReturnType<typeof render>, statusBar: number, y: number) {
  mockSheetProps.animatedPosition.value = y
  await act(async () => {
    utils.rerender(mapTree(statusBar))
  })
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

function mapControls(tree: unknown) {
  const controls = styledNodes(
    tree,
    (style) => style.position === "absolute" && style.gap != null && style.left == null,
  )
  expect(controls).toHaveLength(1)
  return controls[0]
}

function topCluster(tree: unknown) {
  const cluster = styledNodes(
    tree,
    (style) => style.position === "absolute" && style.left != null && style.paddingTop != null,
  )
  expect(cluster).toHaveLength(1)
  return cluster[0]
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
    const utils = await renderMap()
    await moveSheetTo(utils, 0, 600)
    const controls = mapControls(utils.toJSON())
    // The sheet's top edge, less the column's height and the air kept above the edge.
    expect(controls.style.transform).toEqual([{ translateY: 492 }])
    expect(controls.style.top).toBe(0)
    expect(controls.style.opacity).toBe(1)
    expect(controls.node.props.pointerEvents).toBe("box-none")
  })

  it("insets the sheet by the status bar so the top snap meets it", async () => {
    await renderMap(59)
    expect(mockSheetProps.topInset).toBe(59)
    expect(mockSheetProps.snapPoints.at(-1)).toBe("100%")
  })

  it("stops the controls where the top cluster starts instead of under the status bar", async () => {
    const utils = await renderMap(59)
    await moveSheetTo(utils, 59, 59)
    const controls = mapControls(utils.toJSON())
    const cluster = topCluster(utils.toJSON())
    expect(controls.style.transform).toEqual([{ translateY: cluster.style.paddingTop }])
    expect(cluster.style.paddingTop).toBe(67)
  })

  it("takes the controls out of the way while they are faded", async () => {
    const utils = await renderMap(59)
    await moveSheetTo(utils, 59, 59)
    let controls = mapControls(utils.toJSON())
    expect(controls.style.opacity).toBe(0)
    expect(controls.node.props.pointerEvents).toBe("none")
    expect(controls.node.props.accessibilityElementsHidden).toBe(true)

    // Halfway through the fade: visible, but not something a tap can land on.
    await moveSheetTo(utils, 59, 59 + 8 + 108 + 22)
    controls = mapControls(utils.toJSON())
    expect(controls.style.opacity).toBeCloseTo(0.5)
    expect(controls.node.props.pointerEvents).toBe("none")

    await moveSheetTo(utils, 59, 400)
    controls = mapControls(utils.toJSON())
    expect(controls.style.transform).toEqual([{ translateY: 292 }])
    expect(controls.style.opacity).toBe(1)
    expect(controls.node.props.pointerEvents).toBe("box-none")
    expect(controls.node.props.accessibilityElementsHidden).toBe(false)
  })
})

describe("the SOS banner", () => {
  it("says the SOS is yours rather than that you need help", async () => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockActiveSos = [{ id: "sos-1", user: { id: "ana", displayName: "ana" } }]
    const { getByText, queryByText } = await renderMap()
    expect(getByText(/sos:mine/)).toBeTruthy()
    expect(queryByText(/sos:active/)).toBeNull()
    fireEvent.press(getByText(/sos:mine/))
    expect(navigation.navigate).toHaveBeenCalledWith("Sos", { circleId: "circle-1" })
    mockActiveSos = []
  })
})

describe("tapping a member", () => {
  beforeEach(() => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockFocused = true
    mockSnapToIndex.mockClear()
    navigation.navigate.mockClear()
  })

  it("brings the sheet up to name them, and opens their page on the second tap", async () => {
    const { getByTestId, getAllByText, queryAllByTestId } = await renderMap()
    const before = getAllByText("ana").length
    expect(queryAllByTestId("member-marker-halo")).toHaveLength(0)

    fireEvent.press(getByTestId("member-marker-ana"))
    // The resting height, not the collapsed bar, so the card is on screen.
    expect(mockSnapToIndex).toHaveBeenCalledWith(1)
    expect(getAllByText("ana").length).toBe(before + 1)
    // Exactly one face on the map is haloed.
    expect(queryAllByTestId("member-marker-halo")).toHaveLength(1)
    expect(navigation.navigate).not.toHaveBeenCalled()

    // A moment later, past the window that folds a double delivery into one.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    fireEvent.press(getByTestId("member-marker-ana"))
    expect(navigation.navigate).toHaveBeenCalledWith("MemberDetail", {
      circleId: "circle-1",
      userId: "ana",
    })
    ;(Date.now as jest.Mock).mockRestore()
  })

  // Some Android phones deliver the tap through the map's own hit test and
  // never to the Pressable inside the marker.
  it("selects from the native marker press alone", async () => {
    const { getAllByTestId, queryAllByTestId } = await renderMap()
    fireEvent.press(getAllByTestId("native-marker")[0]!)
    expect(mockSnapToIndex).toHaveBeenCalledWith(1)
    expect(queryAllByTestId("member-marker-halo")).toHaveLength(1)
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it("counts one tap once when both the marker and the map report it", async () => {
    const { getByTestId, getAllByTestId } = await renderMap()
    fireEvent.press(getByTestId("member-marker-ana"))
    fireEvent.press(getAllByTestId("native-marker")[0]!)
    // Two deliveries of the first tap must not read as the second tap.
    expect(navigation.navigate).not.toHaveBeenCalled()

    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    fireEvent.press(getByTestId("member-marker-ana"))
    expect(navigation.navigate).toHaveBeenCalledWith("MemberDetail", {
      circleId: "circle-1",
      userId: "ana",
    })
    ;(Date.now as jest.Mock).mockRestore()
  })

  // Android delivers a marker tap to the map as well, a moment later.
  it("keeps the selection when the map reports the same tap", async () => {
    const { getByTestId, getAllByText } = await renderMap()
    fireEvent.press(getByTestId("member-marker-ana"))
    const withCard = getAllByText("ana").length
    act(() => mockMapPress?.())
    expect(getAllByText("ana").length).toBe(withCard)

    // A real tap on empty map, later, does clear it.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    act(() => mockMapPress?.())
    expect(getAllByText("ana").length).toBe(withCard - 1)
    ;(Date.now as jest.Mock).mockRestore()
  })

  it("opens the page from the card and from a list row, which both promise it", async () => {
    const { getByTestId, getAllByText } = await renderMap()
    fireEvent.press(getByTestId("member-marker-ben"))
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    // The marker's own label comes first in the tree, then the card.
    fireEvent.press(getAllByText("ben")[1]!)
    expect(navigation.navigate).toHaveBeenLastCalledWith("MemberDetail", {
      circleId: "circle-1",
      userId: "ben",
    })

    fireEvent.press(getAllByText("cat").at(-1)!)
    expect(navigation.navigate).toHaveBeenLastCalledWith("MemberDetail", {
      circleId: "circle-1",
      userId: "cat",
    })
    ;(Date.now as jest.Mock).mockRestore()
  })
})

describe("people at the same place", () => {
  const nativeMarkers = (utils: { getAllByTestId: (id: string) => any[] }) =>
    utils.getAllByTestId("native-marker")
  // Composite and host nodes both carry the testID, so each face shows twice.
  const facesIn = (marker: any): string[] => [
    ...new Set<string>(
      marker
        .findAll((node: any) => /^member-marker-[a-z]+$/.test(node.props.testID ?? ""))
        .map((node: any) => node.props.testID.replace("member-marker-", "")),
    ),
  ]

  beforeEach(() => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockFocused = true
    mockSnapToIndex.mockClear()
    navigation.navigate.mockClear()
  })

  it("stacks two people at home on one marker with one pill, and leaves the rest alone", async () => {
    mockPresence = [
      presenceFor("ana", 51),
      presenceFor("ben", 51),
      presenceFor("cat", 53),
      presenceFor("dee", 54),
    ]
    const utils = await renderMap()
    const markers = nativeMarkers(utils)
    expect(markers).toHaveLength(3)
    expect(facesIn(markers[0])).toEqual(["ana", "ben"])
    expect(facesIn(markers[1])).toEqual(["cat"])
    expect(utils.getByText("map:pair")).toBeTruthy()
    // The stack sits on the spot they share and the pointer still lands there.
    expect(markers[0].props.offset).toEqual([0, MEMBER_MARKER_LABEL_HEIGHT])
  })

  it("stacks people as the map zooms out and lets them go again on the way in", async () => {
    // Everyone on a different street of one town.
    mockPresence = mockMembers.map((member, index) =>
      presenceFor(member.userId, 51 + index * 0.006),
    )
    const utils = await renderMap()
    expect(nativeMarkers(utils)).toHaveLength(4)

    act(() => mockMapZoom?.({ nativeEvent: { zoom: 10 } }))
    expect(nativeMarkers(utils)).toHaveLength(1)
    expect(facesIn(nativeMarkers(utils)[0])).toEqual(["ana", "ben", "cat", "dee"])

    act(() => mockMapZoom?.({ nativeEvent: { zoom: 16 } }))
    expect(nativeMarkers(utils)).toHaveLength(4)
  })

  it("lets a marker that laid out wide claim a neighbour", async () => {
    // About 150 m apart at zoom 15: clear as two plain faces, not once one
    // of them has measured a name pill 220 points wide.
    mockPresence = [
      presenceFor("ana", 51),
      presenceFor("ben", 51.00135),
      presenceFor("cat", 53),
      presenceFor("dee", 54),
    ]
    const utils = await renderMap()
    act(() => mockMapZoom?.({ nativeEvent: { zoom: 15 } }))
    expect(nativeMarkers(utils)).toHaveLength(4)
    act(() => {
      fireEvent(
        nativeMarkers(utils)[0].findByProps({ testID: "member-marker-ana" }).parent,
        "layout",
        {
          nativeEvent: { layout: { width: 220, height: 80, x: 0, y: 0 } },
        },
      )
    })
    expect(nativeMarkers(utils)).toHaveLength(3)
  })

  it("selects each face of a stack from its own tap, and the pill answers for the selected one", async () => {
    mockPresence = [
      presenceFor("ana", 51),
      presenceFor("ben", 51),
      presenceFor("cat", 53),
      presenceFor("dee", 54),
    ]
    const utils = await renderMap()
    fireEvent.press(utils.getByTestId("member-marker-ben"))
    expect(utils.getAllByTestId("member-marker-halo")).toHaveLength(1)
    expect(mockSnapToIndex).toHaveBeenCalledWith(1)

    // The pill is the second tap on ben, which opens their page.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000)
    fireEvent.press(utils.getByText(/map:pair/))
    expect(navigation.navigate).toHaveBeenCalledWith("MemberDetail", {
      circleId: "circle-1",
      userId: "ben",
    })
    ;(Date.now as jest.Mock).mockRestore()
  })

  it("works out which face a native tap landed on from where it landed", async () => {
    mockPresence = [
      presenceFor("ana", 51),
      presenceFor("ben", 51),
      presenceFor("cat", 53),
      presenceFor("dee", 54),
    ]
    mockProject.mockResolvedValue([200, 300])
    const utils = await renderMap()
    // Two faces are 90 points wide, so the right hand face is centred 17
    // points right of the marker.
    await act(async () => {
      fireEvent.press(nativeMarkers(utils)[0], { nativeEvent: { point: [222, 290] } })
    })
    expect(utils.getAllByTestId("member-marker-halo")).toHaveLength(1)
    expect(
      utils.getByTestId("member-marker-ben").findAllByProps({ testID: "member-marker-halo" })
        .length,
    ).toBeGreaterThan(0)
  })
})

describe("freshness", () => {
  beforeEach(() => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockFocused = true
    mockLastFix = null
    mockRefresh.mockClear()
    ;(AppState.addEventListener as jest.Mock).mockClear()
  })

  it("asks the server for the quiet phones' fixes when the map opens, and again on return", async () => {
    await renderMap()
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockRefresh).toHaveBeenCalledWith("circle-1")

    const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(
      ([, listener]) => listener as (state: string) => void,
    )
    act(() => listeners.forEach((listener) => listener("background")))
    act(() => listeners.forEach((listener) => listener("active")))
    expect(mockRefresh).toHaveBeenCalledTimes(2)
  })

  it("draws the phone's own newest fix before the server has it", async () => {
    // The server's copy of ana is a minute old; the phone has one from now,
    // a street away.
    mockPresence = mockMembers.map((member, index) => ({
      ...presenceFor(member.userId, 51 + index),
      recordedAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    mockLastFix = { lat: 51.01, lon: -0.1, recordedAt: new Date().toISOString(), speedMps: 3 }
    const { getAllByTestId } = await renderMap()
    const [ana] = getAllByTestId("native-marker")
    expect(ana!.props.lngLat).toEqual([-0.1, 51.01])
  })

  it("keeps the server's word when the phone's fix is older", async () => {
    mockLastFix = {
      lat: 51.01,
      lon: -0.1,
      recordedAt: new Date(Date.now() - 120_000).toISOString(),
      speedMps: null,
    }
    const { getAllByTestId } = await renderMap()
    const [ana] = getAllByTestId("native-marker")
    expect(ana!.props.lngLat).toEqual([-0.1, 51])
  })
})

describe("the back button with the sheet up", () => {
  let spy: jest.SpyInstance

  beforeEach(() => {
    mockPresence = mockMembers.map((member, index) => presenceFor(member.userId, 51 + index))
    mockFocused = true
    mockSnapToIndex.mockClear()
    spy = jest.spyOn(BackHandler, "addEventListener")
  })

  afterEach(() => {
    spy.mockRestore()
  })

  /** What the OS does on a press: the newest listener that answers true wins. */
  function pressBack(): boolean {
    const listeners = spy.mock.calls
      .filter(([event]) => event === "hardwareBackPress")
      .map(([, handler]) => handler as () => boolean)
    return listeners.reverse().some((handler) => handler())
  }

  it("brings a raised sheet down to its resting height rather than leaving the app", async () => {
    await renderMap()
    act(() => mockSheetProps.onChange(3))
    expect(pressBack()).toBe(true)
    expect(mockSnapToIndex).toHaveBeenCalledWith(1)
  })

  it("lets the press through when the sheet is already down", async () => {
    await renderMap()
    act(() => mockSheetProps.onChange(1))
    expect(pressBack()).toBe(false)
    act(() => mockSheetProps.onChange(0))
    expect(pressBack()).toBe(false)
    expect(mockSnapToIndex).not.toHaveBeenCalled()
  })
})
