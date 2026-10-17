import { DEFAULTS } from "@hearth/shared"

import { load, save } from "@/utils/storage"

const MINUTE = 60 * 1000

/**
 * A count of presses of something the server rate limits, kept so the
 * person is told to wait here rather than sent a 429. A firewall in front of
 * a home server can read a 429 as an attack and lock every phone in the
 * house out. Kept in storage so closing and reopening the app does not hand
 * out a fresh allowance.
 *
 * The returned function takes a press and answers 0, or answers how long
 * until one frees up and takes nothing.
 */
export function createBudget(key: string, allowed: number, windowMs: number) {
  return (now = Date.now()): number => {
    const recent = (load<number[]>(key) ?? []).filter(
      (at) => typeof at === "number" && at > now - windowMs && at <= now,
    )
    if (recent.length >= allowed) return Math.min(...recent) + windowMs - now
    save(key, [...recent, now])
    return 0
  }
}

/** Every nudge and quick message from this phone, whoever it is to. */
export const takeNudge = createBudget(
  "nudge-budget",
  DEFAULTS.phoneNudgesPerTenMinutes,
  10 * MINUTE,
)

// The server takes three exports in ten minutes from one account. Two leaves
// room for one that failed on the way and still counted.
export const takeExport = createBudget("export-budget", 2, 10 * MINUTE)

// The server takes five tests in five minutes from one account, and the
// admin portal keeps the other two for itself.
export const takePushTest = createBudget("push-test-budget", 3, 5 * MINUTE)

/** Whole minutes to say in "try again in", never zero. */
export const minutesToWait = (waitMs: number) => Math.max(1, Math.ceil(waitMs / MINUTE))

const takeMapRefreshes = createBudget("map-refresh-budget", 60, 10 * MINUTE)

/**
 * Whether the map may ask the server to wake a circle's quiet phones.
 * The server holds every phone to one ask in ten minutes and leaves alone
 * one heard from in the last two, so a second ask for a circle inside half a
 * minute changes nothing. Opening the map, switching circles and coming back
 * to the front can still add up to the route's limit and a 429, so the asks
 * are counted across circles too.
 */
export function takeMapRefresh(circleId: string, now = Date.now()): boolean {
  if (createBudget(`map-refresh-${circleId}`, 1, 30 * 1000)(now) > 0) return false
  return takeMapRefreshes(now) === 0
}
