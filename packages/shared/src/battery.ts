import type { PresenceIssue } from "./constants"

/** At or below this, a phone that went quiet most likely ran out. */
export const BATTERY_RAN_OUT_LEVEL = 0.05

/**
 * Whether a phone that has gone quiet most likely ran out of battery. The
 * caller decides it is quiet. A phone on the charger is not running out,
 * whatever it last read.
 */
export function batteryRanOut(
  level: number | null | undefined,
  charging: boolean | null | undefined,
): boolean {
  return level != null && level <= BATTERY_RAN_OUT_LEVEL && charging !== true
}

/**
 * What a phone said that a flat battery explains better, once it has gone
 * quiet on one. A dying phone turns power saving on by itself, and whatever
 * starved the tracker no longer matters to a phone that is off. The switches
 * before these in PRESENCE_ISSUES are things somebody turned off, which a
 * parent can put right, so they still come first.
 */
export const issuesBatteryExplains: readonly PresenceIssue[] = [
  "battery_optimisation",
  "low_power_mode",
  "background_restricted",
  "service_stopped",
]
