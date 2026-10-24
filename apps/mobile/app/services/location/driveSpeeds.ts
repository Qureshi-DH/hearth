import type { LocationFixInput, SpeedReading } from "@hearth/shared"

/**
 * Every GPS speed of the last couple of minutes, as fixes arrive, whenever
 * they arrive. A fix often lands after the samples it describes, and by then
 * no sample can carry it, but the impact detector reads the speed before a
 * jolt and the speed after it from here.
 */
const SPEED_MEMORY_MS = 2 * 60_000
let speeds: SpeedReading[] = []

export function noteDriveFix(fix: LocationFixInput): void {
  if (fix.speedMps == null) return
  const t = Date.parse(fix.recordedAt)
  if (!Number.isFinite(t)) return
  speeds.push({ t, speedMps: fix.speedMps, accuracyMeters: fix.accuracyMeters ?? null })
  const cutoff = Date.now() - SPEED_MEMORY_MS
  if (speeds[0]!.t < cutoff) speeds = speeds.filter((reading) => reading.t >= cutoff)
}

export function recentSpeeds(): SpeedReading[] {
  return speeds
}
