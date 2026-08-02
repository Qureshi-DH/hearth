import { boundingBox, metersPerDegreeLat, metersPerDegreeLon, type LatLng } from "@hearth/shared"
import type { Feature, FeatureCollection, Polygon } from "geojson"

/** MapLibre has no circle geometry, so a circle has to be drawn as a polygon. */
export function circlePolygon(center: LatLng, radiusMeters: number, steps = 64): Feature<Polygon> {
  const latStep = radiusMeters / metersPerDegreeLat()
  const lonStep = radiusMeters / Math.max(1, metersPerDegreeLon(center.lat))
  const ring: [number, number][] = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    ring.push([center.lon + Math.cos(angle) * lonStep, center.lat + Math.sin(angle) * latStep])
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }
}

export function circlesCollection(
  circles: Array<{ id: string; center: LatLng; radiusMeters: number; color?: string | null }>,
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: circles.map((circle) => {
      const feature = circlePolygon(circle.center, circle.radiusMeters)
      feature.properties = { id: circle.id, color: circle.color ?? null }
      feature.id = circle.id
      return feature
    }),
  }
}

export function fitBoundsFor(
  points: LatLng[],
  paddingMeters = 150,
): { ne: [number, number]; sw: [number, number] } | null {
  const box = boundingBox(points, paddingMeters)
  if (!box) return null
  // A single point gives a zero-area box, which the camera cannot zoom to.
  if (box.north - box.south < 0.0005 && box.east - box.west < 0.0005) {
    return {
      ne: [box.east + 0.003, box.north + 0.003],
      sw: [box.west - 0.003, box.south - 0.003],
    }
  }
  return { ne: [box.east, box.north], sw: [box.west, box.south] }
}

export function lineString(points: LatLng[]): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
  }
}

export function multiLineString(lines: LatLng[][]): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiLineString",
      coordinates: lines.map((line) => line.map((p) => [p.lon, p.lat])),
    },
  }
}

export function zoomForRadius(radiusMeters: number): number {
  const clamped = Math.min(20_000, Math.max(50, radiusMeters))
  return Math.max(10, Math.min(18, 19.2 - Math.log2(clamped / 50)))
}
