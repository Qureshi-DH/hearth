import * as Localization from "expo-localization"

/**
 * The time zone and clock this phone keeps. The server reads quiet hours on
 * it, and the time a late notification gives.
 */
export function phoneClock(): { timeZone?: string; clock?: "12h" | "24h" } {
  let calendar: Localization.Calendar | undefined
  try {
    calendar = Localization.getCalendars()[0]
  } catch {
    // An old build without the native module. Intl still knows the zone.
  }
  const timeZone = calendar?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const uses24 = calendar?.uses24hourClock
  return {
    ...(timeZone ? { timeZone } : {}),
    ...(uses24 == null ? {} : { clock: uses24 ? "24h" : "12h" }),
  }
}
