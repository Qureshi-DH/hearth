import { DEFAULTS } from "@hearth/shared"
import { sql } from "drizzle-orm"

import { placeMemberships, sessions, userPresence } from "../db/schema"

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
 * How long a quiet phone is given before each silent wake. The first is
 * counted from when it was last heard, the rest from the wake before. A phone last
 * seen moving that goes quiet is the one worth finding quickly. A parked
 * phone is expected to be quiet, and iOS drops silent pushes past a few an
 * hour, so it is asked at a walking pace. After the last gap the server
 * stops asking. A phone that ignored three wakes will not answer a fourth.
 */
export const WAKE_GAPS_MOVING_MS = [10, 10, 20].map((minutes) => minutes * 60 * 1000)
export const WAKE_GAPS_PARKED_MS = [30, 30, 30].map((minutes) => minutes * 60 * 1000)
/** How long a woken phone gets to answer before the offline sweep may go ahead. */
export const WAKE_GRACE_MS = 10 * 60 * 1000

/**
 * A parked Android phone reports every quarter of an hour and answers a
 * wake even from Doze, so one that let every wake of the parked schedule go
 * by is not coming back on its own. Where no wake can be sent, the same
 * wait is six missed reports.
 */
export const PARKED_ANDROID_OFFLINE_MS =
  WAKE_GAPS_PARKED_MS.reduce((total, gap) => total + gap, 0) + WAKE_GRACE_MS

/**
 * Every phone the account is signed in on runs Android. An iPhone among
 * them may be the one doing the reporting, and its wakes are the ones iOS
 * holds back, so it keeps the night.
 */
const androidOnly = sql`(
  exists (
    select 1 from ${sessions} phone
    where phone.user_id = ${userPresence.userId}
      and phone.revoked_at is null and phone.platform = 'android'
  )
  and not exists (
    select 1 from ${sessions} phone
    where phone.user_id = ${userPresence.userId}
      and phone.revoked_at is null and phone.platform = 'ios'
  )
)`

/**
 * Silent for longer than the family waits before it is told. A parked
 * iPhone is expected to go quiet. iOS suspends it, and answers a silent push
 * only when it feels like it, so its silence is news after a night. A
 * parked Android phone has no such excuse once its wakes have gone
 * unanswered. A phone last seen moving that goes quiet is the one worth a
 * word soonest.
 */
export function silentPastCutoff(now: Date) {
  const cutoff = new Date(now.getTime() - DEFAULTS.offlineAfterSeconds * 1000)
  const parkedCutoff = new Date(now.getTime() - DEFAULTS.parkedOfflineAfterSeconds * 1000)
  const parkedAndroidCutoff = new Date(now.getTime() - PARKED_ANDROID_OFFLINE_MS)
  return sql`${heardAt} < (case
    when ${parked} and ${androidOnly} then ${parkedAndroidCutoff.toISOString()}::timestamptz
    when ${parked} then ${parkedCutoff.toISOString()}::timestamptz
    else ${cutoff.toISOString()}::timestamptz end)`
}
