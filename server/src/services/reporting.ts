import { DEFAULTS } from "@hearth/shared"
import { sql } from "drizzle-orm"

import { circleMembers, circles, placeMemberships, sessions, userPresence } from "../db/schema"

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
 * A phone takes no fix of its own between Live windows. The server asks it
 * for one, by silent push, on the interval of the strictest circle it is in,
 * counted from when it was last heard. Never more often than every two
 * minutes, whatever a circle says, since each ask is a push and a fix, and
 * never less often than every ten, past which a phone on the move reads as
 * out of date on the map between one ask and the next.
 */
export const PING_MIN_INTERVAL_MS = 2 * 60 * 1000
export const PING_MAX_INTERVAL_MS = 10 * 60 * 1000
/**
 * A phone that goes on not answering is asked at a walk once it has let an
 * hour of asks go by, and every few hours once a day of them has. It is off
 * or out of reach, and most of those asks are pushes nobody reads, but it is
 * never given up on, since nothing else would bring back a phone that was
 * only flat.
 */
export const PING_BACKOFF_AFTER = 12
export const PING_BACKOFF_MS = 30 * 60 * 1000
export const PING_SLOW_AFTER = 60
export const PING_SLOW_MS = 3 * 60 * 60 * 1000

/** One circle's interval in seconds. A setting that is missing or not a number is the default. */
const circleIntervalSeconds = sql`(case
  when jsonb_typeof(c.settings->'minUpdateIntervalSeconds') = 'number'
    then (c.settings->>'minUpdateIntervalSeconds')::numeric
  else ${DEFAULTS.minUpdateIntervalSeconds}::numeric end)`

/**
 * The interval a phone is asked on, in milliseconds, from the circles it is
 * in. A phone in none is not asked at all, see wakeQuietPhones.
 */
export const pingIntervalMs = sql<number>`(least(
  ${PING_MAX_INTERVAL_MS / 1000}::numeric,
  greatest(
    ${PING_MIN_INTERVAL_MS / 1000}::numeric,
    coalesce(
      (select min(${circleIntervalSeconds})
         from ${circleMembers} m join ${circles} c on c.id = m.circle_id
         where m.user_id = ${userPresence.userId}),
      ${DEFAULTS.minUpdateIntervalSeconds}::numeric
    )
  )
) * 1000)::float8`

/** The same interval in JavaScript, in seconds, for the upload reply that tells the phone. */
export function pingIntervalSeconds(
  settings: Array<{ minUpdateIntervalSeconds?: unknown }>,
): number {
  const set = settings.map((row) =>
    typeof row.minUpdateIntervalSeconds === "number" &&
    Number.isFinite(row.minUpdateIntervalSeconds)
      ? row.minUpdateIntervalSeconds
      : DEFAULTS.minUpdateIntervalSeconds,
  )
  const strictest = set.length > 0 ? Math.min(...set) : DEFAULTS.minUpdateIntervalSeconds
  return Math.min(PING_MAX_INTERVAL_MS / 1000, Math.max(PING_MIN_INTERVAL_MS / 1000, strictest))
}

/** What the phone's last fix said it was doing, when that was going somewhere. */
const onTheMove = sql`coalesce(${userPresence.activity} in ('walking', 'running', 'cycling', 'driving'), false)`

/**
 * How long after the last ask, or after the last word when none is out, the
 * next one is due. A phone last seen on the move is asked a little sooner,
 * on the server's moving interval, but never sooner than the floor and
 * never later than its circle would ask a phone at rest.
 */
function pingGapMs(movingIntervalMs: number) {
  const interval = sql<number>`(case when ${onTheMove}
    then least(${pingIntervalMs}, greatest(${movingIntervalMs}::float8, ${PING_MIN_INTERVAL_MS}::float8))
    else ${pingIntervalMs} end)`
  return sql<number>`(case
    when ${userPresence.wakeCount} < ${PING_BACKOFF_AFTER} then ${interval}
    when ${userPresence.wakeCount} < ${PING_SLOW_AFTER}
      then greatest(${interval}, ${PING_BACKOFF_MS}::float8)
    else ${PING_SLOW_MS}::float8 end)`
}

export function pingDueAt(movingIntervalMs: number) {
  return sql`((case
    when ${userPresence.wakeCount} = 0 then ${heardAt}
    else coalesce(${userPresence.wakeRequestedAt}, ${heardAt}) end)
    + make_interval(secs => ${pingGapMs(movingIntervalMs)} / 1000))`
}

/**
 * The phone said its owner switched sharing off, and has sent no fix since.
 * It answers no ask, and asking it every few minutes is a push for nothing.
 * The server writes reportedAt itself, so it always reads as a time.
 */
export const sharingSwitchedOffSql = sql`coalesce(
  ${userPresence.health}->>'sharingEnabled' = 'false'
  and (
    ${userPresence.health}->>'reportedAt' is null
    or ${userPresence.recordedAt} <= (${userPresence.health}->>'reportedAt')::timestamptz
  ),
  false
)`

/** In at least one circle, so a fix from it is something somebody can see. */
export const inACircle = sql`exists (
  select 1 from ${circleMembers} member where member.user_id = ${userPresence.userId}
)`

/**
 * A parked Android phone answers an ask even from Doze, so one that let an
 * hour and a half of them go by is not coming back on its own. Where no ask
 * can be sent, the same wait is the verdict.
 */
export const PARKED_ANDROID_OFFLINE_MS = 100 * 60 * 1000

/**
 * Every phone the account is signed in on runs Android. An iPhone among
 * them may be the one doing the reporting, and its asks are the ones iOS
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
 * parked Android phone has no such excuse once its asks have gone
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
