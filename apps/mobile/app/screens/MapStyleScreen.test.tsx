import type { MapStyle } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { MapStyleScreen } from "./MapStyleScreen"
import { useAuthStore } from "../stores/auth"
import { useSettingsStore } from "../stores/settings"
import { ThemeProvider } from "../theme/context"

const mockPreviews: Array<string | undefined> = []

jest.mock("../components/HearthMap", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    HearthMap: ({ styleUrl }: { styleUrl?: string }) => {
      mockPreviews.push(styleUrl)
      return react.createElement(rn.View)
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
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

const styles: MapStyle[] = [
  { id: "liberty", name: "Liberty", url: "https://tiles.example/liberty", scheme: "light" },
  { id: "positron", name: "Positron", url: "https://tiles.example/positron", scheme: "light" },
  { id: "dark", name: "Dark", url: "https://tiles.example/dark", scheme: "dark" },
  { id: "fiord", name: "Fiord", url: "https://tiles.example/fiord", scheme: "dark" },
]

function serve(mapStyles: MapStyle[]) {
  useAuthStore.setState({
    serverInfo: {
      serverName: "Hearth",
      version: "1.3.0",
      apiVersion: "v1",
      registrationMode: "invite",
      pushProvider: "none",
      mapStyleUrl: "https://tiles.example/liberty",
      mapStyleUrlDark: "https://tiles.example/dark",
      mapStyles,
      mapAttribution: "© OpenStreetMap contributors",
      features: {
        places: true,
        history: true,
        trips: true,
        sos: true,
        checkIns: true,
        avatars: false,
      },
    },
  })
}

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

async function renderScreen(theme: "light" | "dark" = "light") {
  const view = render(
    <ThemeProvider initialContext={theme}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <MapStyleScreen
          navigation={navigation as never}
          route={{ key: "map-style", name: "MapStyle" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Row icons load their font asynchronously, and settling that here keeps the
  // update inside act.
  await act(async () => {})
  return view
}

describe("MapStyleScreen", () => {
  beforeEach(() => {
    mockPreviews.length = 0
    serve(styles)
    useSettingsStore.setState({ mapStyleLight: null, mapStyleDark: null, hapticsEnabled: false })
  })

  it("ticks the server's default for each theme while nothing has been picked", async () => {
    const { getByRole } = await renderScreen()

    expect(getByRole("radio", { name: "Liberty" }).props.accessibilityState).toMatchObject({
      checked: true,
    })
    expect(getByRole("radio", { name: "Positron" }).props.accessibilityState).toMatchObject({
      checked: false,
    })
    expect(getByRole("radio", { name: "Dark" }).props.accessibilityState).toMatchObject({
      checked: true,
    })
    expect(mockPreviews.at(-1)).toBe("https://tiles.example/liberty")
  })

  it("remembers a pick for its own theme and previews it", async () => {
    const { getByRole } = await renderScreen()

    fireEvent.press(getByRole("radio", { name: "Positron" }))

    expect(useSettingsStore.getState().mapStyleLight).toBe("positron")
    expect(useSettingsStore.getState().mapStyleDark).toBeNull()
    expect(getByRole("radio", { name: "Positron" }).props.accessibilityState).toMatchObject({
      checked: true,
    })
    expect(mockPreviews.at(-1)).toBe("https://tiles.example/positron")
  })

  it("previews a dark style while the app is light, so it can be seen before dark comes on", async () => {
    const { getByRole } = await renderScreen("light")

    fireEvent.press(getByRole("radio", { name: "Fiord" }))

    expect(useSettingsStore.getState().mapStyleDark).toBe("fiord")
    expect(mockPreviews.at(-1)).toBe("https://tiles.example/fiord")
  })

  it("opens on the style for the theme the app is in", async () => {
    useSettingsStore.setState({ mapStyleDark: "fiord" })

    await renderScreen("dark")

    expect(mockPreviews.at(-1)).toBe("https://tiles.example/fiord")
  })

  it("ticks the default again once the picked style is no longer offered", async () => {
    useSettingsStore.setState({ mapStyleLight: "retired" })

    const { getByRole } = await renderScreen()

    expect(getByRole("radio", { name: "Liberty" }).props.accessibilityState).toMatchObject({
      checked: true,
    })
  })

  it("leaves out a theme the server has nothing for", async () => {
    serve(styles.filter((style) => style.scheme === "light"))

    const { queryByText, getByText } = await renderScreen()

    expect(getByText(/^mapStyle:light/)).toBeTruthy()
    expect(queryByText(/^mapStyle:dark/)).toBeNull()
  })
})
