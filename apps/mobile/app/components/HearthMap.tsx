import { forwardRef, useMemo, useState, type ReactNode, type Ref } from "react"
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

import { useMapStyleUrl } from "@/hooks/useMapStyle"
import { useAppTheme } from "@/theme/context"
import type { FeatureCollection } from "geojson"

import { circlesCollection, lineString, multiLineString } from "@/utils/map"

export interface HearthMapProps extends Omit<MapProps, "mapStyle" | "style"> {
  style?: StyleProp<ViewStyle>
  cameraRef?: Ref<CameraRef>
  initialCenter?: [number, number]
  initialZoom?: number
  /** Draws this style in place of the one picked for the theme, for a preview. */
  styleUrl?: string
  children?: ReactNode
}

/**
 * Every map in the app goes through here, so swapping tile providers stays a
 * server-side setting, the style picked on the You screen reaches every map,
 * and the ornaments stay consistent.
 */
export const HearthMap = forwardRef<MapRef, HearthMapProps>(function HearthMap(
  {
    style,
    cameraRef,
    initialCenter,
    initialZoom = 13,
    styleUrl,
    children,
    onWillStartLoadingMap,
    onDidFinishLoadingStyle,
    onDidFailLoadingMap,
    ...rest
  },
  ref,
) {
  const { theme } = useAppTheme()
  const pickedStyleUrl = useMapStyleUrl()
  const mapStyle = styleUrl ?? pickedStyleUrl
  // iOS drops marker views added before the style has loaded, and a screen
  // with its data cached renders its markers first, so the map came up with
  // nobody on it. The children go in once this style is in and come out
  // while another loads. A style that fails to load lets them in anyway, or
  // a phone offline with no cached style would never show anyone.
  const [loadedStyle, setLoadedStyle] = useState<string | null>(null)

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceElevated }, style]}>
      <Map
        ref={ref}
        mapStyle={mapStyle}
        style={StyleSheet.absoluteFill}
        attribution
        attributionPosition={{ bottom: 8, left: 8 }}
        logo={false}
        compass={false}
        touchPitch={false}
        androidView="texture"
        {...rest}
        onWillStartLoadingMap={(event) => {
          setLoadedStyle(null)
          onWillStartLoadingMap?.(event)
        }}
        onDidFinishLoadingStyle={(event) => {
          setLoadedStyle(mapStyle)
          onDidFinishLoadingStyle?.(event)
        }}
        onDidFailLoadingMap={(event) => {
          setLoadedStyle(mapStyle)
          onDidFailLoadingMap?.(event)
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={
            initialCenter ? { center: initialCenter, zoom: initialZoom } : { zoom: initialZoom }
          }
        />
        {loadedStyle === mapStyle ? children : null}
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
  // One LineString feature per stretch, not one MultiLineString: MapLibre
  // computes the metrics the gradient reads per LineString and the parts
  // of a multi-line get none, so their gradient never draws.
  const shape = useMemo<FeatureCollection>(
    () => ({ type: "FeatureCollection", features: lines.map(lineString) }),
    [lines],
  )
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
