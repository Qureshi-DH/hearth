import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, render } from "@testing-library/react-native"

import { TripDetailScreen } from "./TripDetailScreen"
import { ThemeProvider } from "../theme/context"

type Point = { recordedAt: string; lat: number; lon: number; speedMps: number | null }

const at = (lat: number, minutesIn: number): Point => ({
  recordedAt: new Date(Date.UTC(2026, 8, 15, 9, minutesIn)).toISOString(),
  lat,
  lon: 73.05,
  speedMps: 10,
})

let mockPath: Point[] = []
const mockTrailProps: Array<{ segments?: unknown; points?: unknown }> = []
const mockGapProps: Array<{ gaps: unknown }> = []
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock("../hooks/queries", () => ({
  useTrip: () => ({
    data: {
      id: "t1",
      userId: "sam",
      startedAt: mockPath[0]!.recordedAt,
      endedAt: mockPath[mockPath.length - 1]!.recordedAt,
      distanceMeters: 2400,
      durationSeconds: 300,
      maxSpeedMps: 11,
      avgSpeedMps: 8,
      pointCount: mockPath.length,
      startLat: mockPath[0]!.lat,
      startLon: 73.05,
      endLat: mockPath[mockPath.length - 1]!.lat,
      endLon: 73.05,
      startPlaceName: "Home",
      endPlaceName: null,
      path: mockPath,
    },
  }),
}))
jest.mock("../hooks/useNearby", () => ({ useNearby: () => null }))
jest.mock("../stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({ units: "metric" }),
}))
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
    TrailLayer: (props: { segments?: unknown; points?: unknown }) => {
      mockTrailProps.push(props)
      return null
    },
    TrailGapLayer: (props: { gaps: unknown }) => {
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
jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Marker: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => mockNavigation,
}))

async function renderTrip() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <TripDetailScreen
          navigation={mockNavigation as never}
          route={{ name: "TripDetail", params: { tripId: "t1" } } as never}
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
  mockGapProps.length = 0
})

describe("a trip's trail", () => {
  it("draws only the stretches the phone reported, and marks the silence", async () => {
    // Three fixes a hundred metres apart, two kilometres of nothing, two more.
    mockPath = [at(33.7, 0), at(33.701, 1), at(33.702, 2), at(33.72, 10), at(33.721, 11)]
    await renderTrip()

    const trail = mockTrailProps[mockTrailProps.length - 1]!
    expect(trail.segments).toEqual([
      [mockPath[0], mockPath[1], mockPath[2]],
      [mockPath[3], mockPath[4]],
    ])
    const gap = mockGapProps[mockGapProps.length - 1]!
    expect(gap.gaps).toEqual([[mockPath[2], mockPath[3]]])
  })

  it("is one line when every step was reported", async () => {
    mockPath = [at(33.7, 0), at(33.701, 1), at(33.702, 2)]
    await renderTrip()

    const trail = mockTrailProps[mockTrailProps.length - 1]!
    expect(trail.segments).toEqual([mockPath])
    expect(mockGapProps.length === 0 || (mockGapProps.at(-1)!.gaps as unknown[]).length === 0).toBe(
      true,
    )
  })
})
