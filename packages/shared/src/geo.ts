import { COARSE_GRID_METERS } from "./constants"

export const EARTH_RADIUS_M = 6_371_008.8

export interface LatLng {
  lat: number
  lon: number
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const sinDLat = Math.sin(dLat / 2)
  const sinDLon = Math.sin(dLon / 2)
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing, degrees clockwise from north, 0 to 360. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLon = toRad(b.lon - a.lon)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

export function isInsideCircle(point: LatLng, center: LatLng, radiusMeters: number): boolean {
  return haversineMeters(point, center) <= radiusMeters
}

/**
 * Entering uses the raw radius. Leaving requires clearing the radius plus
 * `exitBufferMeters`, because a device sitting on the boundary would otherwise
 * emit an endless arrive/leave storm.
 */
export function evaluateGeofence(options: {
  point: LatLng
  center: LatLng
  radiusMeters: number
  wasInside: boolean
  exitBufferMeters?: number
}): boolean {
  const { point, center, radiusMeters, wasInside, exitBufferMeters = 0 } = options
  const distance = haversineMeters(point, center)
  if (wasInside) return distance <= radiusMeters + exitBufferMeters
  return distance <= radiusMeters
}

export function metersPerDegreeLon(lat: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(toRad(lat))
}

/** Takes no latitude, unlike the longitude case, because it barely varies. */
export function metersPerDegreeLat(): number {
  return (Math.PI / 180) * EARTH_RADIUS_M
}

/**
 * Snaps to a fixed grid so "approximate" sharing reveals a neighbourhood
 * rather than a doorstep. The grid is deterministic instead of random jitter.
 * A stationary person must not appear to wander, and repeated samples must not
 * let a viewer average the noise away.
 */
export function coarsenLocation(point: LatLng, gridMeters: number = COARSE_GRID_METERS): LatLng {
  const latStep = gridMeters / metersPerDegreeLat()
  const lat = Math.round(point.lat / latStep) * latStep
  // Derive the longitude step from the snapped latitude. From the raw one, two
  // neighbours a few metres apart in latitude get different cell widths and can
  // land in different cells.
  const lonStep = gridMeters / Math.max(1, metersPerDegreeLon(lat))
  const lon = Math.round(point.lon / lonStep) * lonStep
  return { lat: roundTo(lat, 6), lon: roundTo(lon, 6) }
}

export function boundingBox(
  points: LatLng[],
  paddingMeters = 0,
): { north: number; south: number; east: number; west: number } | null {
  if (points.length === 0) return null
  let north = -90
  let south = 90
  let east = -180
  let west = 180
  for (const p of points) {
    if (p.lat > north) north = p.lat
    if (p.lat < south) south = p.lat
    if (p.lon > east) east = p.lon
    if (p.lon < west) west = p.lon
  }
  if (paddingMeters > 0) {
    const latPad = paddingMeters / metersPerDegreeLat()
    const midLat = (north + south) / 2
    const lonPad = paddingMeters / Math.max(1, metersPerDegreeLon(midLat))
    north = Math.min(90, north + latPad)
    south = Math.max(-90, south - latPad)
    east = Math.min(180, east + lonPad)
    west = Math.max(-180, west - lonPad)
  }
  return { north, south, east, west }
}

export function pathDistanceMeters(points: LatLng[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const curr = points[i]
    if (!prev || !curr) continue
    total += haversineMeters(prev, curr)
  }
  return total
}

export function isValidLatLng(point: Partial<LatLng>): point is LatLng {
  return (
    typeof point.lat === "number" &&
    typeof point.lon === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  )
}

export function metersPerSecondToKmh(mps: number): number {
  return mps * 3.6
}

export function metersPerSecondToMph(mps: number): number {
  return mps * 2.236936
}

export function formatDistance(meters: number, units: "metric" | "imperial" = "metric"): string {
  if (!Number.isFinite(meters)) return "—"
  if (units === "imperial") {
    const feet = meters * 3.28084
    if (feet < 1000) return `${Math.round(feet)} ft`
    return `${(feet / 5280).toFixed(feet / 5280 < 10 ? 1 : 0)} mi`
  }
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters / 1000 < 10 ? 1 : 0)} km`
}

/**
 * Thresholds are conservative. A wrong "driving" badge is worse than an
 * "unknown" one.
 */
export function activityFromSpeed(
  speedMps: number | null | undefined,
): "unknown" | "still" | "walking" | "running" | "cycling" | "driving" {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) return "unknown"
  if (speedMps < 0.3) return "still"
  if (speedMps < 2.0) return "walking"
  if (speedMps < 3.6) return "running"
  if (speedMps < 7.0) return "cycling"
  return "driving"
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
