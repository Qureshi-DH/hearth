import { forwardRef, useMemo, type ReactNode, type Ref } from "react"
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import type { Place } from "@hearth/shared"
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  type CameraRef,
  type MapProps,
  type MapRef,
} from "@maplibre/maplibre-react-native"

import { useAuthStore } from "@/stores/auth"
import { useAppTheme } from "@/theme/context"
import { circlesCollection, multiLineString } from "@/utils/map"

export interface HearthMapProps extends Omit<MapProps, "mapStyle" | "style"> {
  style?: StyleProp<ViewStyle>
  cameraRef?: Ref<CameraRef>
  initialCenter?: [number, number]
  initialZoom?: number
  children?: ReactNode
}

/**
 * Every map in the app goes through here, so swapping tile providers stays a
 * server-side setting and the ornaments stay consistent.
 */
export const HearthMap = forwardRef<MapRef, HearthMapProps>(function HearthMap(
  { style, cameraRef, initialCenter, initialZoom = 13, children, ...rest },
  ref,
) {
  const { theme } = useAppTheme()
  const info = useAuthStore((state) => state.serverInfo)
  // A light basemap under a dark UI is the most jarring thing on the screen,
  // so follow the app's theme when the server offers a dark style.
  const styleUrl =
    (theme.isDark ? (info?.mapStyleUrlDark ?? info?.mapStyleUrl) : info?.mapStyleUrl) ??
    (theme.isDark
      ? "https://tiles.openfreemap.org/styles/dark"
      : "https://tiles.openfreemap.org/styles/liberty")

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceElevated }, style]}>
      <Map
        ref={ref}
        mapStyle={styleUrl}
        style={StyleSheet.absoluteFill}
        attribution
        attributionPosition={{ bottom: 8, left: 8 }}
        logo={false}
        compass={false}
        touchPitch={false}
        androidView="texture"
        {...rest}
      >
        <Camera
          ref={cameraRef}
          initialViewState={
            initialCenter ? { center: initialCenter, zoom: initialZoom } : { zoom: initialZoom }
          }
        />
        {children}
      </Map>
    </View>
  )
})

export function PlaceLayers({
  places,
  highlightId,
}: {
  places: Place[]
  highlightId?: string | null
}) {
  const { theme } = useAppTheme()
  const shape = useMemo(
    () =>
      circlesCollection(
        places.map((place) => ({
          id: place.id,
          center: { lat: place.lat, lon: place.lon },
          radiusMeters: place.radiusMeters,
          color: place.color,
        })),
      ),
    [places],
  )

  if (places.length === 0) return null

  return (
    <GeoJSONSource id="places" data={shape}>
      <Layer
        id="places-fill"
        type="fill"
        paint={{
          "fill-color": ["coalesce", ["get", "color"], theme.colors.tint],
          "fill-opacity": ["case", ["==", ["get", "id"], highlightId ?? ""], 0.28, 0.14],
        }}
      />
      <Layer
        id="places-outline"
        type="line"
        paint={{
          "line-color": ["coalesce", ["get", "color"], theme.colors.tint],
          "line-width": ["case", ["==", ["get", "id"], highlightId ?? ""], 2.5, 1.5],
          "line-opacity": 0.8,
        }}
      />
    </GeoJSONSource>
  )
}

export function TrailLayer({
  id,
  points,
  segments,
  color,
  width = 4,
}: {
  id: string
  /** One continuous line. */
  points?: Array<{ lat: number; lon: number }>
  /** The stretches the phone reported, drawn as separate lines. */
  segments?: Array<Array<{ lat: number; lon: number }>>
  color?: string
  width?: number
}) {
  const { theme } = useAppTheme()
  const lines = useMemo(
    () => (segments ?? (points ? [points] : [])).filter((line) => line.length > 1),
    [points, segments],
  )
  const shape = useMemo(() => multiLineString(lines), [lines])
  if (lines.length === 0) return null
  return (
    <GeoJSONSource id={id} data={shape} lineMetrics>
      <Layer
        id={`${id}-casing`}
        type="line"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": theme.isDark ? "#000000" : "#FFFFFF",
          "line-width": width + 3,
          "line-opacity": 0.5,
        }}
      />
      <Layer
        id={`${id}-line`}
        type="line"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": color ?? theme.colors.path,
          "line-width": width,
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            "rgba(95,168,255,0.25)",
            1,
            color ?? theme.colors.path,
          ],
        }}
      />
    </GeoJSONSource>
  )
}

/**
 * A silence between two fixes, dashed. The road between them is a guess,
 * and drawing the guess as a road is how a trail came to look like a
 * ruler laid across town.
 */
export function TrailGapLayer({
  id,
  gaps,
  color,
}: {
  id: string
  gaps: Array<[{ lat: number; lon: number }, { lat: number; lon: number }]>
  color?: string
}) {
  const { theme } = useAppTheme()
  const shape = useMemo(() => multiLineString(gaps), [gaps])
  if (gaps.length === 0) return null
  return (
    <GeoJSONSource id={id} data={shape}>
      <Layer
        id={`${id}-line`}
        type="line"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": color ?? theme.colors.path,
          "line-width": 3,
          "line-opacity": 0.55,
          "line-dasharray": [1, 2.5],
        }}
      />
    </GeoJSONSource>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: "hidden" },
})
