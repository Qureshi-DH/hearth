import { DEFAULTS } from "@hearth/shared"
import { sql } from "drizzle-orm"

import { placeMemberships, userPresence } from "../db/schema"

/**
 * The last moment the phone spoke, fix or no fix. greatest() ignores a null,
 * so a row that predates the column reads its last fix as before.
 */
export const heardAt = sql`greatest(${userPresence.recordedAt}, ${userPresence.lastHeardAt})`

/**
 * Whether the phone is parked, judged from everything the server knows and
 * not from the one label the phone may never manage to send. The fix that
 * arrives somewhere is by construction a moving fix: it crossed the fence
 * while the tracker still called the phone "driving", and the stop that
 * would say "still" is the least reliable request the phone makes. So a
 * phone inside a place the family named is parked, and so is one that
 * measured itself standing still with a fix sharp enough to mean it.
 */
export const parked = sql`(
  ${userPresence.activity} = 'still'
  or exists (
    select 1 from ${placeMemberships} inside
    where inside.user_id = ${userPresence.userId} and inside.is_inside
  )
  or (
    ${userPresence.speedMps} is not null
    and ${userPresence.speedMps} < ${DEFAULTS.incidentStoppedSpeedMps}
    and ${userPresence.accuracyMeters} is not null
    and ${userPresence.accuracyMeters} <= ${DEFAULTS.geofenceMaxAccuracyMeters}
  )
)`

/**
 * Silent for longer than the family waits before it is told. A parked phone
 * is expected to go quiet: iOS suspends it, and answers a silent push only
 * when it feels like it. Silence from a parked phone is news after a night,
 * not after an hour. A phone last seen moving that goes quiet is the one
 * worth a word.
 */
export function silentPastCutoff(now: Date) {
  const cutoff = new Date(now.getTime() - DEFAULTS.offlineAfterSeconds * 1000)
  const parkedCutoff = new Date(now.getTime() - DEFAULTS.parkedOfflineAfterSeconds * 1000)
  return sql`${heardAt} < (case when ${parked}
    then ${parkedCutoff.toISOString()}::timestamptz
    else ${cutoff.toISOString()}::timestamptz end)`
}
