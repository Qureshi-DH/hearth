import { Linking, Platform } from "react-native"

export type DirectionsApp = "apple" | "google"

/**
 * Android hands a geo: URL to whatever map apps are installed and lets the
 * user pick, so it needs no help. iOS opens Apple Maps for maps:// and only
 * reaches Google Maps through its own scheme, which the app has to be
 * allowed to ask about in Info.plist (LSApplicationQueriesSchemes).
 */
export function directionsUrl(app: DirectionsApp, lat: number, lon: number, label: string): string {
  if (Platform.OS === "android") {
    return `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`
  }
  return app === "google"
    ? `comgooglemaps://?daddr=${lat},${lon}&directionsmode=driving`
    : `maps://?daddr=${lat},${lon}`
}

/** The apps a directions button can offer on this phone. One means open it straight away. */
export async function availableDirectionsApps(): Promise<DirectionsApp[]> {
  if (Platform.OS !== "ios") return ["google"]
  const hasGoogle = await Linking.canOpenURL("comgooglemaps://").catch(() => false)
  return hasGoogle ? ["apple", "google"] : ["apple"]
}

export function openDirections(
  app: DirectionsApp,
  lat: number,
  lon: number,
  label: string,
): Promise<void> {
  return Linking.openURL(directionsUrl(app, lat, lon, label)).then(() => undefined)
}
