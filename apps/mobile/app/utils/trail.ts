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
