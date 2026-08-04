import { render } from "@testing-library/react-native"

import { TrailGapLayer, TrailLayer } from "./HearthMap"
import { ThemeProvider } from "../theme/context"

const mockSources: Array<{ id: string; data: any }> = []

jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    MapView: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
    Camera: () => null,
    Layer: () => null,
    GeoJSONSource: ({ id, data, children }: { id: string; data: unknown; children?: unknown }) => {
      mockSources.push({ id, data })
      return react.createElement(rn.View, null, children)
    },
  }
})
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ serverInfo: null }),
}))

const a = { lat: 51.45, lon: -2.58 }
const b = { lat: 51.451, lon: -2.58 }
const c = { lat: 51.47, lon: -2.58 }
const d = { lat: 51.471, lon: -2.58 }

beforeEach(() => {
  mockSources.length = 0
})

describe("TrailLayer", () => {
  it("draws each reported stretch as a line of its own", () => {
    // MapLibre computes the metrics a line gradient needs per LineString
    // feature and not for the parts of a MultiLineString.
    render(
      <ThemeProvider>
        <TrailLayer
          id="t"
          segments={[
            [a, b],
            [c, d],
          ]}
        />
      </ThemeProvider>,
    )
    const source = mockSources.find((entry) => entry.id === "t")!
    expect(source.data.type).toBe("FeatureCollection")
    expect(source.data.features).toHaveLength(2)
    expect(source.data.features.every((f: any) => f.geometry.type === "LineString")).toBe(true)
  })

  it("draws one continuous line from points", () => {
    render(
      <ThemeProvider>
        <TrailLayer id="t" points={[a, b, c]} />
      </ThemeProvider>,
    )
    const source = mockSources.find((entry) => entry.id === "t")!
    expect(source.data.features).toHaveLength(1)
    expect(source.data.features[0].geometry.coordinates).toHaveLength(3)
  })
})

describe("TrailGapLayer", () => {
  it("draws nothing when there is no silence", () => {
    render(
      <ThemeProvider>
        <TrailGapLayer id="g" gaps={[]} />
      </ThemeProvider>,
    )
    expect(mockSources.find((entry) => entry.id === "g")).toBeUndefined()
  })
})
