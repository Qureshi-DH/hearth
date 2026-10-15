import type { MapStyle, ServerInfo } from "@hearth/shared"

import { useAuthStore } from "@/stores/auth"
import { useSettingsStore, type MapScheme } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"

/** What the server ships by default, for the moments before the app has heard from one. */
export const FALLBACK_STYLE_URLS: Record<MapScheme, string> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
}

export function mapStylesFor(info: ServerInfo | null, scheme: MapScheme): MapStyle[] {
  return (info?.mapStyles ?? []).filter((style) => style.scheme === scheme)
}

/** A picker with one row per theme would offer nothing to pick. */
export function offersMapStyleChoice(info: ServerInfo | null): boolean {
  return mapStylesFor(info, "light").length > 1 || mapStylesFor(info, "dark").length > 1
}

export interface ResolvedMapStyle {
  /**
   * Set for the default too, so the picker can tick it. Null when the default
   * is not in the server's list, as on a server from before the list.
   */
  id: string | null
  name: string | null
  url: string
}

export function resolveMapStyle(
  info: ServerInfo | null,
  scheme: MapScheme,
  chosenId: string | null,
): ResolvedMapStyle {
  const styles = mapStylesFor(info, scheme)
  const chosen = chosenId ? styles.find((style) => style.id === chosenId) : undefined
  if (chosen) return { id: chosen.id, name: chosen.name, url: chosen.url }

  const url =
    (scheme === "dark" ? (info?.mapStyleUrlDark ?? info?.mapStyleUrl) : info?.mapStyleUrl) ??
    FALLBACK_STYLE_URLS[scheme]
  const listed = styles.find((style) => style.url === url)
  return { id: listed?.id ?? null, name: listed?.name ?? null, url }
}

/**
 * A list with no dark style draws a light one in dark mode, so the light pick
 * is the one to follow there. A server from before the list keeps its own
 * dark default.
 */
function drawnScheme(info: ServerInfo | null, scheme: MapScheme): MapScheme {
  if (scheme === "light" || !info?.mapStyles?.length) return scheme
  return mapStylesFor(info, "dark").length > 0 ? "dark" : "light"
}

export function useChosenMapStyle(scheme: MapScheme): ResolvedMapStyle {
  const info = useAuthStore((state) => state.serverInfo)
  const drawn = drawnScheme(info, scheme)
  const chosenId = useSettingsStore((state) =>
    drawn === "dark" ? state.mapStyleDark : state.mapStyleLight,
  )
  return resolveMapStyle(info, drawn, chosenId)
}

/**
 * The style URL every map should draw. A light basemap under a dark UI is the
 * most jarring thing on the screen, so it follows the app's theme unless a
 * scheme is passed, which the picker does to preview the other one.
 */
export function useMapStyleUrl(scheme?: MapScheme): string {
  const { theme } = useAppTheme()
  return useChosenMapStyle(scheme ?? (theme.isDark ? "dark" : "light")).url
}
