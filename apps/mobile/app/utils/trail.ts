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
 * apart than this are a silence, and a line across it would be a guess at
 * the road, so the silence is handed back separately for drawing as one.
 */
export const TRAIL_MAX_STEP_METERS = 500

export function splitTrail<T extends { lat: number; lon: number }>(
  points: T[],
  maxStepMeters = TRAIL_MAX_STEP_METERS,
): { drawn: T[][]; gaps: Array<[T, T]> } {
  const drawn: T[][] = []
  const gaps: Array<[T, T]> = []
  let run: T[] = []
  for (const point of points) {
    const last = run[run.length - 1]
    if (last && haversineMeters(last, point) > maxStepMeters) {
      gaps.push([last, point])
      if (run.length > 1) drawn.push(run)
      run = []
    }
    run.push(point)
  }
  if (run.length > 1) drawn.push(run)
  return { drawn, gaps }
}
