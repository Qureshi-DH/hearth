import type { ReactNode } from "react"
import type { MapStyle, ServerInfo } from "@hearth/shared"
import { act, renderHook } from "@testing-library/react-native"

import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"

import {
  FALLBACK_STYLE_URLS,
  mapStylesFor,
  offersMapStyleChoice,
  resolveMapStyle,
  useMapStyleUrl,
} from "./useMapStyle"
import { ThemeProvider } from "../theme/context"

const styles: MapStyle[] = [
  { id: "liberty", name: "Liberty", url: "https://tiles.example/liberty", scheme: "light" },
  { id: "positron", name: "Positron", url: "https://tiles.example/positron", scheme: "light" },
  { id: "dark", name: "Dark", url: "https://tiles.example/dark", scheme: "dark" },
  { id: "fiord", name: "Fiord", url: "https://tiles.example/fiord", scheme: "dark" },
]

function info(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return {
    serverName: "Hearth",
    version: "1.3.0",
    apiVersion: "v1",
    registrationMode: "invite",
    pushProvider: "none",
    mapStyleUrl: "https://tiles.example/liberty",
    mapStyleUrlDark: "https://tiles.example/dark",
    mapStyles: styles,
    mapAttribution: "© OpenStreetMap contributors",
    features: {
      places: true,
      history: true,
      trips: true,
      sos: true,
      checkIns: true,
      avatars: false,
    },
    ...overrides,
  }
}

describe("mapStylesFor", () => {
  it("lists only the styles drawn under the given theme", () => {
    expect(mapStylesFor(info(), "light").map((style) => style.id)).toEqual(["liberty", "positron"])
    expect(mapStylesFor(info(), "dark").map((style) => style.id)).toEqual(["dark", "fiord"])
  })

  it("is empty for a server from before the list", () => {
    expect(mapStylesFor(info({ mapStyles: undefined }), "light")).toEqual([])
    expect(mapStylesFor(null, "dark")).toEqual([])
  })
})

describe("offersMapStyleChoice", () => {
  it("is true once either theme has more than one style", () => {
    expect(offersMapStyleChoice(info())).toBe(true)
    expect(offersMapStyleChoice(info({ mapStyles: styles.slice(1) }))).toBe(true)
  })

  it("is false when there is one style per theme, as with an operator's own tiles", () => {
    expect(offersMapStyleChoice(info({ mapStyles: [styles[0]!, styles[2]!] }))).toBe(false)
    expect(offersMapStyleChoice(info({ mapStyles: undefined }))).toBe(false)
  })
})

describe("resolveMapStyle", () => {
  it("uses the style this phone chose", () => {
    expect(resolveMapStyle(info(), "light", "positron")).toEqual({
      id: "positron",
      name: "Positron",
      url: "https://tiles.example/positron",
    })
  })

  it("falls back to the server's default when the chosen style is no longer offered", () => {
    expect(resolveMapStyle(info(), "light", "gone")).toEqual({
      id: "liberty",
      name: "Liberty",
      url: "https://tiles.example/liberty",
    })
  })

  it("never draws a dark style under the light theme, even when its id was chosen", () => {
    expect(resolveMapStyle(info(), "light", "fiord").url).toBe("https://tiles.example/liberty")
  })

  it("uses the server's dark default, then its light one, under the dark theme", () => {
    expect(resolveMapStyle(info(), "dark", null).url).toBe("https://tiles.example/dark")
    expect(
      resolveMapStyle(info({ mapStyleUrlDark: undefined, mapStyles: undefined }), "dark", null),
    ).toEqual({ id: null, name: null, url: "https://tiles.example/liberty" })
  })

  it("draws OpenFreeMap before the app has heard from any server", () => {
    expect(resolveMapStyle(null, "light", "positron").url).toBe(FALLBACK_STYLE_URLS.light)
    expect(resolveMapStyle(null, "dark", null).url).toBe(FALLBACK_STYLE_URLS.dark)
  })
})

describe("useMapStyleUrl", () => {
  beforeEach(() => {
    useAuthStore.setState({ serverInfo: info() })
    useSettingsStore.setState({ mapStyleLight: null, mapStyleDark: null })
  })

  function wrapper(theme: "light" | "dark") {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <ThemeProvider initialContext={theme}>{children}</ThemeProvider>
    }
  }

  it("follows the app's theme", () => {
    useSettingsStore.setState({ mapStyleLight: "positron", mapStyleDark: "fiord" })

    expect(renderHook(() => useMapStyleUrl(), { wrapper: wrapper("light") }).result.current).toBe(
      "https://tiles.example/positron",
    )
    expect(renderHook(() => useMapStyleUrl(), { wrapper: wrapper("dark") }).result.current).toBe(
      "https://tiles.example/fiord",
    )
  })

  it("answers for a theme other than the app's when asked", () => {
    useSettingsStore.setState({ mapStyleDark: "fiord" })

    const { result } = renderHook(() => useMapStyleUrl("dark"), { wrapper: wrapper("light") })

    expect(result.current).toBe("https://tiles.example/fiord")
  })

  // The server draws such a list's first light style under the dark theme,
  // and the picker offers no dark section to choose from, so the light pick
  // is the only choice the phone's owner could have made.
  it("draws the light pick in dark mode when the server lists no dark styles", () => {
    const lightOnly = styles.filter((style) => style.scheme === "light")
    useAuthStore.setState({
      serverInfo: info({ mapStyles: lightOnly, mapStyleUrlDark: "https://tiles.example/liberty" }),
    })
    useSettingsStore.setState({ mapStyleLight: "positron" })

    const { result } = renderHook(() => useMapStyleUrl(), { wrapper: wrapper("dark") })

    expect(result.current).toBe("https://tiles.example/positron")
  })

  it("keeps a server's own dark default when it sends no list at all", () => {
    useAuthStore.setState({ serverInfo: info({ mapStyles: undefined }) })
    useSettingsStore.setState({ mapStyleLight: "positron" })

    const { result } = renderHook(() => useMapStyleUrl(), { wrapper: wrapper("dark") })

    expect(result.current).toBe("https://tiles.example/dark")
  })

  it("changes as soon as a new style is picked", () => {
    const { result } = renderHook(() => useMapStyleUrl(), { wrapper: wrapper("light") })
    expect(result.current).toBe("https://tiles.example/liberty")

    act(() => useSettingsStore.getState().setMapStyle("light", "positron"))

    expect(result.current).toBe("https://tiles.example/positron")
  })
})
