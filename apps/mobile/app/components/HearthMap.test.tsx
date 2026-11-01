import type { ServerInfo } from "@hearth/shared"
import { View } from "react-native"
import { act, render } from "@testing-library/react-native"

import { HearthMap, TrailGapLayer, TrailLayer } from "./HearthMap"
import { useSettingsStore } from "../stores/settings"
import { ThemeProvider } from "../theme/context"

const mockSources: Array<{ id: string; data: any }> = []
const mockMapStyles: string[] = []
/** What HearthMap last handed the native map, load handlers included. */
let mockMapProps: Record<string, any> = {}
let mockServerInfo: Partial<ServerInfo> | null = null

jest.mock("@maplibre/maplibre-react-native", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Map: (props: { children?: unknown; mapStyle: string }) => {
      mockMapStyles.push(props.mapStyle)
      mockMapProps = props
      return react.createElement(rn.View, null, props.children)
    },
    Camera: () => null,
    Layer: () => null,
    GeoJSONSource: ({ id, data, children }: { id: string; data: unknown; children?: unknown }) => {
      mockSources.push({ id, data })
      return react.createElement(rn.View, null, children)
    },
  }
})
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ serverInfo: mockServerInfo }),
}))

const a = { lat: 51.45, lon: -2.58 }
const b = { lat: 51.451, lon: -2.58 }
const c = { lat: 51.47, lon: -2.58 }
const d = { lat: 51.471, lon: -2.58 }

beforeEach(() => {
  mockSources.length = 0
  mockMapStyles.length = 0
  mockServerInfo = null
})

describe("HearthMap", () => {
  beforeEach(() => {
    mockServerInfo = {
      mapStyleUrl: "https://tiles.example/liberty",
      mapStyleUrlDark: "https://tiles.example/dark",
      mapStyles: [
        { id: "liberty", name: "Liberty", url: "https://tiles.example/liberty", scheme: "light" },
        {
          id: "positron",
          name: "Positron",
          url: "https://tiles.example/positron",
          scheme: "light",
        },
      ],
    }
    useSettingsStore.setState({ mapStyleLight: null, mapStyleDark: null })
  })

  it("draws the style this phone picked for the theme", () => {
    useSettingsStore.setState({ mapStyleLight: "positron" })

    render(
      <ThemeProvider initialContext="light">
        <HearthMap />
      </ThemeProvider>,
    )

    expect(mockMapStyles.at(-1)).toBe("https://tiles.example/positron")
  })

  it("draws a style it is handed over the picked one, for a preview", () => {
    useSettingsStore.setState({ mapStyleLight: "positron" })

    render(
      <ThemeProvider initialContext="light">
        <HearthMap styleUrl="https://tiles.example/dark" />
      </ThemeProvider>,
    )

    expect(mockMapStyles.at(-1)).toBe("https://tiles.example/dark")
  })

  describe("loading", () => {
    const withMarker = (styleUrl?: string) => (
      <ThemeProvider initialContext="light">
        <HearthMap styleUrl={styleUrl}>
          <View testID="marker" />
        </HearthMap>
      </ThemeProvider>
    )
    const load = (event: string) => act(() => mockMapProps[event]({ nativeEvent: null }))

    // iOS drops marker views added before the style has loaded, and a screen
    // with its data cached renders its markers first.
    it("holds the markers back until the style has loaded", () => {
      const { queryByTestId } = render(withMarker())
      expect(queryByTestId("marker")).toBeNull()

      load("onDidFinishLoadingStyle")
      expect(queryByTestId("marker")).not.toBeNull()
    })

    it("takes them out while the style loads again, as on a theme change", () => {
      const { queryByTestId } = render(withMarker())
      load("onDidFinishLoadingStyle")

      load("onWillStartLoadingMap")
      expect(queryByTestId("marker")).toBeNull()
      load("onDidFinishLoadingStyle")
      expect(queryByTestId("marker")).not.toBeNull()
    })

    it("takes them out as soon as it is handed another style", () => {
      const { queryByTestId, rerender } = render(withMarker())
      load("onDidFinishLoadingStyle")

      rerender(withMarker("https://tiles.example/dark"))
      expect(queryByTestId("marker")).toBeNull()
      load("onDidFinishLoadingStyle")
      expect(queryByTestId("marker")).not.toBeNull()
    })

    // Offline with no cached style, or a bad style URL, the map would
    // otherwise never show anyone.
    it("lets them in when the style fails to load", () => {
      const { queryByTestId } = render(withMarker())
      load("onDidFailLoadingMap")
      expect(queryByTestId("marker")).not.toBeNull()
    })

    it("still hands each load event to the screen", () => {
      const handlers = {
        onWillStartLoadingMap: jest.fn(),
        onDidFinishLoadingStyle: jest.fn(),
        onDidFailLoadingMap: jest.fn(),
      }
      render(
        <ThemeProvider initialContext="light">
          <HearthMap {...handlers} />
        </ThemeProvider>,
      )
      load("onWillStartLoadingMap")
      load("onDidFinishLoadingStyle")
      load("onDidFailLoadingMap")
      Object.values(handlers).forEach((handler) => expect(handler).toHaveBeenCalledTimes(1))
    })
  })
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
