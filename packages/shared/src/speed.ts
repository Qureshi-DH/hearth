import type { ActivityType } from "./constants"
import { haversineMeters } from "./geo"

/** How far apart two neighbouring speeds can be and still be one measurement. */
const AGREEMENT_TOLERANCE = 0.1
/** A fix this sharp came from the GPS, so its position can vouch for a speed. */
const GPS_CLASS_ACCURACY_METERS = 30
/** Closer than this and the error circles swamp the ground covered. */
const MIN_CHORD_SECONDS = 5
/**
 * How hard a car is allowed to brake and pick up again between two fixes
 * before the ground they cover is said to contradict their speeds. Firmer
 * than everyday driving, so a real change of pace is never the contradiction.
 */
const MAX_ACCELERATION_MPS2 = 4

export interface SpeedFix {
  recordedAt: string | Date
  lat: number
  lon: number
  speedMps: number | null
  accuracyMeters?: number | null
}

/**
 * What two neighbouring fixes support between them. A Doppler speed carries a
 * few percent of noise, so a pair this close is one measurement read twice and
 * the faster of the two is a number both fixes stand behind. Further apart
 * than that and only the slower is supported, which keeps the lone impossible
 * velocity a provider switch emits out of anything that quotes it.
 */
export function agreedSpeedMps(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null || b == null) return null
  const faster = Math.max(a, b)
  const slower = Math.min(a, b)
  return faster - slower <= faster * AGREEMENT_TOLERANCE ? faster : slower
}

/**
 * The fastest speed a run of fixes can be said to have reached. The speed
 * alert and the trip card both quote it, so a drive announced at 92 km/h
 * cannot be filed at 21.
 *
 * Each fix that measured a speed is paired with the speed-bearing neighbour
 * on either side of it within `gapMs`, whatever measured nothing in between:
 * a network fix mid-drive carries no speed and must not stand between two
 * readings that agree. The answer is the highest agreed speed, floored at the
 * fastest ground covered between consecutive GPS-class fixes, since 250 m in
 * 10 s is 90 km/h whatever the Doppler reading said. Positions cap it too. Two
 * readings that agree on a speed the ground between them cannot support are
 * one artefact read twice, and Live's fix a second produces them in pairs.
 */
export function agreedMaxSpeedMps(points: SpeedFix[], gapMs: number): number | null {
  const sorted = points
    .map((point) => ({ ...point, at: toMs(point.recordedAt) }))
    .filter((point) => Number.isFinite(point.at))
    .sort((a, b) => a.at - b.at)

  let agreedMax: number | null = null
  let previous: (typeof sorted)[number] | null = null
  for (const point of sorted) {
    if (point.speedMps == null || !Number.isFinite(point.speedMps)) continue
    if (previous && point.at - previous.at <= gapMs) {
      const agreed = agreedSpeedMps(previous.speedMps, point.speedMps)
      const supported =
        agreed === null ? null : Math.min(agreed, supportableMps(previous, point) ?? agreed)
      if (supported !== null && (agreedMax === null || supported > agreedMax)) agreedMax = supported
    }
    previous = point
  }

  let chordMax: number | null = null
  for (let i = 1; i < sorted.length; i += 1) {
    const from = sorted[i - 1]!
    const to = sorted[i]!
    if (!isGpsClass(from) || !isGpsClass(to)) continue
    const seconds = (to.at - from.at) / 1000
    if (seconds <= MIN_CHORD_SECONDS) continue
    const covered =
      haversineMeters(from, to) - (from.accuracyMeters ?? 0) - (to.accuracyMeters ?? 0)
    if (covered <= 0) continue
    const chord = covered / seconds
    if (chordMax === null || chord > chordMax) chordMax = chord
  }

  if (agreedMax === null) return chordMax
  if (chordMax === null) return agreedMax
  return Math.max(agreedMax, chordMax)
}

/**
 * The fastest a car can have been going at both ends of the time between two
 * sharp fixes, given the most ground the positions allow between them. Holding
 * v for t covers v·t, and braking then picking up again saves at most a·t²/4,
 * or the whole lot when there is time to stop. A second apart that is the
 * ground covered and a metre a second to spare. Thirty seconds apart a car
 * could have done anything in between, and the bound says nothing.
 */
function supportableMps(from: SpeedFix & { at: number }, to: SpeedFix & { at: number }) {
  if (!isGpsClass(from) || !isGpsClass(to)) return null
  const seconds = (to.at - from.at) / 1000
  if (seconds <= 0) return null
  const reach = haversineMeters(from, to) + from.accuracyMeters! + to.accuracyMeters!
  const a = MAX_ACCELERATION_MPS2
  return reach < (a * seconds * seconds) / 4
    ? Math.sqrt(a * reach)
    : reach / seconds + (a * seconds) / 4
}

function isGpsClass(point: SpeedFix): boolean {
  return point.accuracyMeters != null && point.accuracyMeters <= GPS_CLASS_ACCURACY_METERS
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/**
 * Beyond these, the motion classifier's label is the one that is wrong. It
 * lags a change of pace, and a phone held in a hand on a bus still swings
 * like a walker's, but nobody on foot keeps up 30 km/h and no family member
 * on a bicycle does 70.
 */
const MAX_PLAUSIBLE_KMH: Partial<Record<ActivityType, number>> = {
  walking: 30,
  running: 30,
  cycling: 70,
}

/** The phone's activity label, unless the speed measured alongside it rules it out. */
export function plausibleActivity<T extends ActivityType | null | undefined>(
  activity: T,
  speedMps: number | null | undefined,
): T | "driving" {
  if (activity == null || speedMps == null) return activity
  const ceiling = MAX_PLAUSIBLE_KMH[activity]
  return ceiling != null && speedMps * 3.6 > ceiling ? "driving" : activity
}
