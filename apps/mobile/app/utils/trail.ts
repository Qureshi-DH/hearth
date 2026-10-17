import { haversineMeters } from "@hearth/shared"

/**
 * A phone indoors draws a scribble: Wi-Fi fixes wander a few metres each
 * way and every wobble became a line on the map. Nothing under this many
 * metres from the last kept point is a movement worth drawing.
 */
export const TRAIL_MIN_STEP_METERS = 30

export function simplifyTrail<T extends { lat: number; lon: number }>(
  points: T[],
  minStepMeters = TRAIL_MIN_STEP_METERS,
): T[] {
  const kept: T[] = []
  for (const point of points) {
    const last = kept[kept.length - 1]
    if (!last || haversineMeters(last, point) >= minStepMeters) kept.push(point)
  }
  // The newest point is where they are now, and it stays even when it is a
  // wobble away from the one before it.
  const newest = points[points.length - 1]
  if (newest && kept[kept.length - 1] !== newest) kept.push(newest)
  return kept
}

/**
 * A trail is drawn only where the phone reported it. Two fixes further
 * apart than this, and longer apart in time than a phone on the move takes
 * between fixes, are a silence, and a line across it would be a guess at
 * the road, so the silence is handed back separately for drawing as one.
 * A silence needs both: the driving tier's upload gate lets a fix through
 * every 300 m at speed, which with a late fix is 450 m in 30 s, so a gated
 * drive clears neither limit; and a crawl that took minutes over a few
 * hundred metres has no road unreported, only a jam.
 */
export const TRAIL_MAX_STEP_METERS = 500
export const TRAIL_MAX_STEP_SECONDS = 60

function isSilence(
  from: { lat: number; lon: number; recordedAt?: string },
  to: { lat: number; lon: number; recordedAt?: string },
  maxStepMeters: number,
): boolean {
  if (haversineMeters(from, to) <= maxStepMeters) return false
  if (!from.recordedAt || !to.recordedAt) return true
  return Date.parse(to.recordedAt) - Date.parse(from.recordedAt) > TRAIL_MAX_STEP_SECONDS * 1000
}

export function splitTrail<T extends { lat: number; lon: number; recordedAt?: string }>(
  points: T[],
  maxStepMeters = TRAIL_MAX_STEP_METERS,
): { drawn: T[][]; gaps: Array<[T, T]> } {
  const drawn: T[][] = []
  const gaps: Array<[T, T]> = []
  let run: T[] = []
  for (const point of points) {
    const last = run[run.length - 1]
    if (last && isSilence(last, point, maxStepMeters)) {
      gaps.push([last, point])
      if (run.length > 1) drawn.push(run)
      run = []
    }
    run.push(point)
  }
  if (run.length > 1) drawn.push(run)
  return { drawn, gaps }
}

/** One point of a Live trail, as the socket and the refill both carry it. */
export interface LiveTrailPoint {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters: number | null
}

/**
 * At a fix a second that is under an hour of driving, and hours on foot,
 * where most fixes are a step from the last. A longer watch drops its
 * oldest point.
 */
export const LIVE_TRAIL_MAX_POINTS = 3_000

/** Every point once, in the order the phone recorded them, however they arrived. */
export function mergeTrail<T extends { recordedAt: string }>(
  current: T[],
  incoming: T[],
  max = LIVE_TRAIL_MAX_POINTS,
): T[] {
  if (incoming.length === 0) return current
  const last = current[current.length - 1]
  const ordered = incoming.every((point, i) =>
    i === 0
      ? !last || point.recordedAt > last.recordedAt
      : point.recordedAt > incoming[i - 1]!.recordedAt,
  )
  if (ordered) return [...current, ...incoming].slice(-max)
  const byTime = new Map<string, T>()
  for (const point of [...current, ...incoming]) byTime.set(point.recordedAt, point)
  return [...byTime.values()]
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
    .slice(-max)
}

/** Live fixes closer than this to the last drawn point are the same spot. */
export const LIVE_TRAIL_MIN_STEP_METERS = 5
/**
 * A fix this much looser than the last few, and looser than the floor, is
 * not where the phone went. On a parked Android phone the Wi-Fi grade
 * request keeps delivering under the live one, and drawn, each of its fixes
 * is a spike off the road and back. Three in a row are the phone's new
 * normal, indoors or under trees, and are drawn.
 */
const OUTLIER_RATIO = 3
const OUTLIER_FLOOR_METERS = 40
const OUTLIER_SAMPLE = 5
const OUTLIER_STREAK = 3

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** The points of a Live trail worth drawing as the road. */
export function liveTrailToDraw<T extends LiveTrailPoint>(points: T[]): T[] {
  const kept: T[] = []
  let recent: number[] = []
  let streak: T[] = []
  for (const point of points) {
    const accuracy = point.accuracyMeters
    if (accuracy != null && recent.length >= 3) {
      const limit = Math.max(OUTLIER_FLOOR_METERS, OUTLIER_RATIO * median(recent))
      if (accuracy > limit) {
        streak.push(point)
        if (streak.length < OUTLIER_STREAK) continue
        recent = streak.map((loose) => loose.accuracyMeters!)
        streak = []
      }
    }
    streak = []
    if (accuracy != null) recent = [...recent, accuracy].slice(-OUTLIER_SAMPLE)
    const last = kept[kept.length - 1]
    if (last && haversineMeters(last, point) < LIVE_TRAIL_MIN_STEP_METERS) continue
    kept.push(point)
  }
  return kept
}
