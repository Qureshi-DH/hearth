import { DEFAULTS, type DeviceHealth, type FeedEvent } from "@hearth/shared"
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import type { FastifyBaseLogger } from "fastify"

import { getSql, type Database } from "../db/client"
import { circleMembers, events, sessions, userPresence, users } from "../db/schema"
import type { AppConfig } from "../env"
import { getPushDriver } from "../runtime"
import { broadcastEvent, recordEvent } from "../services/feed"
import { effectiveSharingState } from "../services/presence"
import {
  drainOutbox,
  enqueuePush,
  listenForOutbox,
  pruneOutbox,
  requeueStuckSends,
  type PushDriver,
} from "../services/push"
import { getServerSettings } from "../services/settings"
import { detectTripsForUser, type PendingBroadcast } from "../services/trips"

export interface JobReport {
  prunedPoints: number
  prunedOutbox: number
  prunedSessions: number
  pushSent: number
  pushFailed: number
  pushSkipped: number
  tripsDetected: number
  offlineFlagged: number
  phonesWoken: number
  devicesReturned: number
  pausesResumed: number
}

/**
 * A user's breadcrumbs are kept for as long as the most generous circle they
 * belong to asks for, capped by the server-wide maximum. Someone in no circle
 * at all falls back to the default window rather than being kept forever.
 */
async function pruneLocationHistory(db: Database, config: AppConfig): Promise<number> {
  // The ceiling an admin set through the API, not the one the process booted
  // with. Reading the env value here meant changing the cap from the app
  // persisted a number that then swept nothing.
  const settings = await getServerSettings(db)
  const ceilingDays = settings.maxHistoryRetentionDays ?? config.MAX_HISTORY_RETENTION_DAYS
  // Bounded batches. One unbounded DELETE over months of breadcrumbs holds
  // locks for minutes and starves everything queued behind it.
  const BATCH = 5000
  const MAX_BATCHES_PER_USER = 20

  // Resolve each household member's window here and sweep one user at a time.
  // Joining the window to the breadcrumbs instead puts the cutoff in the join
  // predicate, where it cannot be an index qual, so the planner seq-scans the
  // whole of location_points on every tick just to learn there is nothing old
  // enough to delete. Users are few, breadcrumbs are not.
  const windows = (await db.execute(sql`
    select
      u.id as user_id,
      least(
        coalesce(max((c.settings ->> 'historyRetentionDays')::int), ${DEFAULTS.historyRetentionDays}),
        ${ceilingDays}
      ) as days
    from users u
    left join circle_members cm on cm.user_id = u.id
    left join circles c on c.id = cm.circle_id
    group by u.id
  `)) as unknown as { user_id: string; days: number }[]

  let total = 0
  for (const row of windows) {
    // Budgeted per user rather than per tick. Shared, one account with years of
    // backlog absorbed the whole tick and everybody behind it in an unordered
    // result waited for it to drain.
    let batches = 0
    const cutoff = new Date(Date.now() - row.days * 24 * 60 * 60 * 1000)
    while (batches < MAX_BATCHES_PER_USER) {
      batches += 1
      const result = await db.execute(sql`
        delete from location_points
        where id in (
          select id
          from location_points
          where user_id = ${row.user_id}::uuid
            and recorded_at < ${cutoff.toISOString()}::timestamptz
          limit ${BATCH}
        )
      `)
      const deleted = readCount(result)
      total += deleted
      if (deleted < BATCH) break
    }
  }
  return total
}

/** Expired and long-revoked sessions are dead weight and a stale attack surface. */
async function pruneSessions(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const deleted = await db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, new Date()),
        and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, cutoff)),
      ),
    )
    .returning({ id: sessions.id })
  return deleted.length
}

/**
 * Enough phones that most of them being quiet at the same moment is evidence
 * about the server rather than a coincidence between households.
 */
const OUTAGE_MIN_REPORTING = 8

/**
 * How long a phone is left quiet before it is asked for a fix, silently. A
 * high priority push reaches an Android phone even in Doze, and posting a
 * notification for it, which the app does, is what keeps FCM treating the
 * app's pushes as high priority, so Android can be asked often. iOS delivers
 * a silent push a few times an hour at most and drops the rest, so an
 * iPhone is asked at half the offline window and no more.
 */
const WAKE_AFTER_ANDROID_MS = 15 * 60 * 1000
const WAKE_AFTER_MS = (DEFAULTS.offlineAfterSeconds * 1000) / 2
/** How long a woken phone gets to answer before the offline sweep may go ahead. */
const WAKE_GRACE_MS = 10 * 60 * 1000

/**
 * The phone's own heartbeat is the first line: the resting watch reports
 * every quarter hour. This is the second. Neither OS lets an app set a timer
 * it can count on in the background, and both wake an app for a data-only
 * push, Android even from Doze, so a phone that has missed two heartbeats is
 * pinged once per silence. Only the expo provider can send one.
 */
async function wakeQuietPhones(db: Database, driver: PushDriver | null): Promise<number> {
  if (driver?.provider !== "expo") return 0
  const quietSince = new Date(Date.now() - WAKE_AFTER_MS)
  const androidQuietSince = new Date(Date.now() - WAKE_AFTER_ANDROID_MS)
  const unanswered = or(
    isNull(userPresence.wakeRequestedAt),
    lt(userPresence.wakeRequestedAt, userPresence.recordedAt),
  )
  const hasAndroid = sql`exists (
    select 1 from ${sessions}
    where ${sessions.userId} = ${userPresence.userId}
      and ${sessions.revokedAt} is null
      and ${sessions.pushToken} is not null
      and ${sessions.platform} = 'android'
  )`
  const quiet = await db
    .select({ userId: userPresence.userId })
    .from(userPresence)
    .innerJoin(users, eq(users.id, userPresence.userId))
    .where(
      and(
        eq(users.isActive, true),
        isNotNull(userPresence.recordedAt),
        sql`${userPresence.recordedAt} < (case when ${hasAndroid}
          then ${androidQuietSince.toISOString()}::timestamptz
          else ${quietSince.toISOString()}::timestamptz end)`,
        // Once per silence: a wake newer than the last fix is still pending.
        unanswered,
      ),
    )
    .limit(200)
  if (quiet.length === 0) return 0

  const now = new Date()
  let woken = 0
  for (const row of quiet) {
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(userPresence)
        .set({ wakeRequestedAt: now })
        .where(and(eq(userPresence.userId, row.userId), unanswered))
        .returning({ userId: userPresence.userId })
      if (claimed.length === 0) return
      await enqueuePush(tx as unknown as Database, [
        { userId: row.userId, title: "", body: "", silent: true, data: { type: "wake" } },
      ])
      woken += 1
    })
  }
  return woken
}

/** The first thing the phone said stands between it and reporting, in words. */
export function healthReason(health: DeviceHealth | null | undefined): string | null {
  if (!health) return null
  if (health.locationPermission !== "always" && health.locationPermission !== "unknown") {
    return "location permission is not set to Always"
  }
  if (!health.locationServices) return "location services are off"
  if (health.backgroundRefresh && health.backgroundRefresh !== "available") {
    return "Background App Refresh is off"
  }
  if (health.batteryOptimised) return "battery optimisation is still on"
  if (health.lowPowerMode) return "power saving mode is on"
  if (health.backgroundRestricted) return "background activity is restricted"
  if (health.serviceStopped) return "location service was stopped"
  return null
}

/**
 * A phone that went quiet says more than one that is merely stationary, so
 * this is the alert families care about most. Each circle hears it once per
 * outage: not once per tick, and not never because a sibling circle happened
 * to be paused on the tick that first noticed.
 */
async function flagOfflineDevices(
  db: Database,
  log: FastifyBaseLogger,
  driver: PushDriver | null,
): Promise<number> {
  const cutoff = new Date(Date.now() - DEFAULTS.offlineAfterSeconds * 1000)
  // A phone whose last word was that it had parked is expected to go quiet:
  // iOS suspends it, and answers a silent push only when it feels like it.
  // Silence from a parked phone is news after a night, not after an hour.
  // A phone last seen moving that goes quiet is the one worth a word.
  const parkedCutoff = new Date(Date.now() - DEFAULTS.parkedOfflineAfterSeconds * 1000)
  const quietFor = sql`${userPresence.recordedAt} < (case when ${userPresence.activity} = 'still'
    then ${parkedCutoff.toISOString()}::timestamptz
    else ${cutoff.toISOString()}::timestamptz end)`
  // A phone that was never asked cannot have failed to answer. Where no wake
  // can be sent the silence alone has to do, as it always did.
  const canWake = driver?.provider === "expo"
  const graceCutoff = new Date(Date.now() - WAKE_GRACE_MS)

  const [totals] = await db
    .select({
      reporting: sql<number>`count(*) filter (where ${userPresence.recordedAt} is not null)::int`,
      stale: sql<number>`count(*) filter (where ${quietFor})::int`,
      fresh: sql<number>`count(*) filter (where ${userPresence.recordedAt} is not null and not (${quietFor}))::int`,
    })
    .from(userPresence)
  if (!totals || totals.stale === 0) return 0

  // Most of the server quiet at once is evidence about the server, not about
  // any one phone, and the first handset to come back is the outage ending
  // rather than proof the rest have broken. Keying this on nothing at all
  // being fresh meant one phone reconnecting told every other family their
  // phone was dead. So the guard holds while the quiet outnumber the reporting
  // and lifts as the crowd returns, which is also when a phone still dark has
  // stopped having an excuse. It needs a server big enough for a majority to
  // mean anything: in a family of three, all three being quiet says nothing,
  // and one phone that genuinely went dark must never be silenced by two
  // siblings who merely missed a background window.
  if (totals.reporting >= OUTAGE_MIN_REPORTING && totals.stale > totals.fresh) {
    log.warn(
      { reporting: totals.reporting, stale: totals.stale, fresh: totals.fresh },
      "offline alerts withheld; most of the server has stopped reporting",
    )
    return 0
  }

  // Every stale device, not just the ones nothing has been said about yet. The
  // outage outlives the pause that hid it: a circle that was paused during the
  // first sweep is still owed the alert when it comes back, and the row-level
  // mark cannot express "told Friends, still owe Family". Unnotified first, so
  // a server past the batch limit still works through the new outages.
  const stale = await db
    .select({
      userId: userPresence.userId,
      displayName: users.displayName,
      notifiedAt: userPresence.offlineNotifiedAt,
      health: userPresence.health,
    })
    .from(userPresence)
    .innerJoin(users, eq(users.id, userPresence.userId))
    .where(
      and(
        // A deactivated account's sessions are all revoked, so its phone
        // cannot report by design. Telling the circle it stopped reporting
        // describes an admin's decision as a malfunction.
        eq(users.isActive, true),
        isNotNull(userPresence.recordedAt),
        quietFor,
        ...(canWake
          ? [
              isNotNull(userPresence.wakeRequestedAt),
              gt(userPresence.wakeRequestedAt, userPresence.recordedAt),
              lt(userPresence.wakeRequestedAt, graceCutoff),
            ]
          : []),
      ),
    )
    .orderBy(sql`${userPresence.offlineNotifiedAt} asc nulls first`, userPresence.userId)
    .limit(200)

  if (stale.length === 0) return 0

  const staleIds = stale.map((row) => row.userId)
  const memberships = await db
    .select({
      userId: circleMembers.userId,
      circleId: circleMembers.circleId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      resumeToState: circleMembers.resumeToState,
    })
    .from(circleMembers)
    .where(inArray(circleMembers.userId, staleIds))

  const told = await alreadyToldThisOutage(db, staleIds)

  const now = new Date()
  let flagged = 0

  for (const row of stale) {
    // A circle the member paused sharing with hears nothing. "Their phone went
    // quiet" is still a presence signal about someone who opted out of sharing
    // with them, the way low-battery alerts skip paused circles.
    const visible = memberships.filter(
      (m) =>
        m.userId === row.userId &&
        effectiveSharingState(m.sharingState, m.pausedUntil, now, m.resumeToState) !== "paused",
    )

    // Not the send latch any more. It marks when this outage was first swept,
    // which is what the per-circle marks below are measured against, and the
    // next fix clears it. Postgres supplies the timestamp because the feed rows
    // compared against it are stamped by Postgres too.
    if (row.notifiedAt === null) {
      const claimed = await db
        .update(userPresence)
        .set({ offlineNotifiedAt: sql`now()` })
        .where(and(eq(userPresence.userId, row.userId), isNull(userPresence.offlineNotifiedAt)))
        .returning({ userId: userPresence.userId })
      flagged += claimed.length
    }

    const pending = visible.filter((m) => !told.has(outageKey(row.userId, m.circleId)))
    if (pending.length === 0) continue

    // One user at a time, under that user's own lock, and the circles are
    // re-read inside it. The latch used to be a single conditional UPDATE, and
    // two replicas ticking together still must not both announce one outage.
    const broadcasts: { circleId: string; event: FeedEvent }[] = []
    await db.transaction(async (tx) => {
      const [lock] = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext(${"hearth:offline:" + row.userId})) as ok`,
      )) as unknown as { ok: boolean }[]
      if (!lock?.ok) return

      const confirmed = await alreadyToldThisOutage(tx as unknown as Database, [row.userId])
      for (const membership of pending) {
        if (confirmed.has(outageKey(row.userId, membership.circleId))) continue
        // The phone may have said why it cannot report, and that is the
        // useful sentence: "Sami's location permission is off" is something
        // a parent can act on, "phone offline" is a worry.
        const reason = healthReason(row.health)
        const event = await recordEvent(tx as unknown as Database, {
          deferBroadcast: true,
          circleId: membership.circleId,
          type: "device_offline",
          actorUserId: row.userId,
          summary: reason
            ? `${row.displayName}'s phone cannot report: ${reason}`
            : `${row.displayName}'s phone stopped reporting`,
          notify: {
            title: reason ? "Phone cannot report" : "Phone offline",
            body: reason
              ? `${row.displayName}'s phone says its ${reason}.`
              : `${row.displayName}'s phone has not reported in for a while.`,
            channel: "alerts",
          },
        })
        broadcasts.push({ circleId: membership.circleId, event })
      }
    })

    for (const { circleId, event } of broadcasts) {
      await broadcastEvent(circleId, event)
    }
  }

  return flagged
}

const outageKey = (userId: string, circleId: string) => `${userId}:${circleId}`

/**
 * Which circles have already been told about the outage each of these devices
 * is currently in. The feed row is the mark, and offline_notified_at is where
 * the outage starts, so a fix that clears that column retires every mark at
 * once and the next silence is a new outage to announce.
 */
async function alreadyToldThisOutage(db: Database, userIds: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ userId: events.actorUserId, circleId: events.circleId })
    .from(events)
    .innerJoin(userPresence, eq(userPresence.userId, events.actorUserId))
    .where(
      and(
        eq(events.type, "device_offline"),
        inArray(events.actorUserId, userIds),
        gte(events.occurredAt, userPresence.offlineNotifiedAt),
      ),
    )
  return new Set(rows.map((row) => outageKey(row.userId!, row.circleId)))
}

interface OwedReturn {
  circle_id: string
  user_id: string
  display_name: string
}

/**
 * Circles whose last word on a phone's connectivity was that it stopped
 * reporting, for phones that are reporting again. Insertion order decides
 * which word came last, not occurred_at: a handset whose clock runs slow
 * stamps its returning fix behind the sweep that announced the silence, and
 * reading the device's own clock would leave the return outstanding forever
 * and re-announce it on every tick. A device still inside its outage is
 * excluded by the offline latch, which ingest clears only for a current fix.
 */
async function circlesOwedReturnNews(db: Database, userIds?: string[]): Promise<OwedReturn[]> {
  const cutoff = new Date(Date.now() - DEFAULTS.offlineAfterSeconds * 1000)
  const only =
    userIds && userIds.length > 0
      ? sql`and p.user_id in (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``

  return (await db.execute(sql`
    with returned as (
      select p.user_id, u.display_name
      from user_presence p
      join users u on u.id = p.user_id
      where u.is_active
        and p.offline_notified_at is null
        and p.recorded_at >= ${cutoff.toISOString()}::timestamptz
        ${only}
    ),
    latest as (
      select distinct on (e.circle_id, e.actor_user_id) e.circle_id, e.actor_user_id, e.type
      from events e
      join returned r on r.user_id = e.actor_user_id
      where e.type in ('device_offline', 'device_online')
      order by e.circle_id, e.actor_user_id, e.id desc
    )
    select latest.circle_id, latest.actor_user_id as user_id, returned.display_name
    from latest
    join returned on returned.user_id = latest.actor_user_id
    where latest.type = 'device_offline'
  `)) as unknown as OwedReturn[]
}

/**
 * The other half of the outage alert. Ingest clears the offline latch without
 * saying anything, so a circle told a phone had gone dark otherwise never
 * hears that it came back and the feed ends on bad news indefinitely.
 */
async function announceReturnedDevices(db: Database): Promise<number> {
  const owed = await circlesOwedReturnNews(db)
  if (owed.length === 0) return 0

  const userIds = [...new Set(owed.map((row) => row.user_id))]
  const memberships = await db
    .select({
      userId: circleMembers.userId,
      circleId: circleMembers.circleId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      resumeToState: circleMembers.resumeToState,
    })
    .from(circleMembers)
    .where(inArray(circleMembers.userId, userIds))

  const now = new Date()
  let announced = 0

  for (const userId of userIds) {
    // A circle sharing is paused with was never told the phone went quiet, and
    // telling it the phone is back is the same presence signal in reverse.
    const visible = owed.filter(
      (row) =>
        row.user_id === userId &&
        memberships.some(
          (m) =>
            m.userId === userId &&
            m.circleId === row.circle_id &&
            effectiveSharingState(m.sharingState, m.pausedUntil, now, m.resumeToState) !== "paused",
        ),
    )
    if (visible.length === 0) continue

    const broadcasts: { circleId: string; event: FeedEvent }[] = []
    // The same lock the offline sweep takes, so the two halves of one phone's
    // story cannot be written by two replicas at once.
    await db.transaction(async (tx) => {
      const [lock] = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext(${"hearth:offline:" + userId})) as ok`,
      )) as unknown as { ok: boolean }[]
      if (!lock?.ok) return

      const confirmed = new Set(
        (await circlesOwedReturnNews(tx as unknown as Database, [userId])).map(
          (row) => row.circle_id,
        ),
      )
      for (const row of visible) {
        if (!confirmed.has(row.circle_id)) continue
        // No push. device_online is not one of the types a member may silence,
        // so a notification here would be one nobody could ever turn off, and
        // "the phone is fine again" has not earned that.
        const event = await recordEvent(tx as unknown as Database, {
          deferBroadcast: true,
          circleId: row.circle_id,
          type: "device_online",
          actorUserId: userId,
          summary: `${row.display_name}'s phone is reporting again`,
        })
        broadcasts.push({ circleId: row.circle_id, event })
      }
    })

    for (const { circleId, event } of broadcasts) {
      await broadcastEvent(circleId, event)
    }
    announced += broadcasts.length
  }

  return announced
}

async function resumeExpiredPauses(db: Database): Promise<number> {
  const expired = await db
    .update(circleMembers)
    .set({
      sharingState: sql`coalesce(${circleMembers.resumeToState}, 'precise')`,
      pausedUntil: null,
      resumeToState: null,
    })
    .where(
      and(
        eq(circleMembers.sharingState, "paused"),
        isNotNull(circleMembers.pausedUntil),
        lte(circleMembers.pausedUntil, new Date()),
      ),
    )
    .returning({ circleId: circleMembers.circleId, userId: circleMembers.userId })

  for (const row of expired) {
    await recordEvent(db, {
      circleId: row.circleId,
      type: "sharing_resumed",
      actorUserId: row.userId,
      summary: "Resumed sharing location",
    })
  }
  return expired.length
}

/** Only people who have moved recently are worth scanning. */
async function detectRecentTrips(db: Database): Promise<number> {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000)
  const PAGE = 200
  let detected = 0
  let cursor: string | null = null

  for (;;) {
    const active: { userId: string }[] = await db
      .select({ userId: userPresence.userId })
      .from(userPresence)
      .where(
        and(
          isNotNull(userPresence.recordedAt),
          gt(userPresence.recordedAt, since),
          cursor ? gt(userPresence.userId, cursor) : undefined,
        ),
      )
      .orderBy(userPresence.userId)
      .limit(PAGE)

    for (const row of active) {
      // Per-user advisory lock. Two replicas ticking together must not both
      // sessionise the same breadcrumbs into duplicate trips.
      const pending: PendingBroadcast[] = []
      detected += await db.transaction(async (tx) => {
        const [lock] = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${"hearth:trips:" + row.userId})) as ok`,
        )) as unknown as { ok: boolean }[]
        if (!lock?.ok) return 0
        return detectTripsForUser(tx as unknown as Database, row.userId, new Date(), pending)
      })
      // Outside the transaction on purpose. A frame cannot be unsent, so a
      // rollback after publishing would tell the family about a journey the
      // database never kept.
      for (const frame of pending) await broadcastEvent(frame.circleId, frame.event)
    }

    if (active.length < PAGE) break
    cursor = active[active.length - 1]!.userId
  }
  return detected
}

/** Steps are isolated, so one failing job never stops the rest of the pass. */
export async function runJobs(
  db: Database,
  config: AppConfig,
  log: FastifyBaseLogger,
): Promise<JobReport> {
  const report: JobReport = {
    prunedPoints: 0,
    prunedOutbox: 0,
    prunedSessions: 0,
    pushSent: 0,
    pushFailed: 0,
    pushSkipped: 0,
    tripsDetected: 0,
    offlineFlagged: 0,
    phonesWoken: 0,
    devicesReturned: 0,
    pausesResumed: 0,
  }

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      log.error({ err: error, job: name }, "background job failed")
    }
  }

  await step("push.drain", async () => {
    const driver = getPushDriver()
    if (!driver) return
    await requeueStuckSends(db, new Date(Date.now() - 10 * 60 * 1000))
    const summary = await drainOutbox(db, driver, { batchSize: 100 })
    report.pushSent = summary.sent
    report.pushFailed = summary.failed
    report.pushSkipped = summary.skipped
  })

  await step("pauses.resume", async () => {
    report.pausesResumed = await resumeExpiredPauses(db)
  })

  await step("devices.wake", async () => {
    report.phonesWoken = await wakeQuietPhones(db, getPushDriver())
  })

  await step("devices.offline", async () => {
    report.offlineFlagged = await flagOfflineDevices(db, log, getPushDriver())
  })

  await step("devices.online", async () => {
    report.devicesReturned = await announceReturnedDevices(db)
  })

  await step("trips.detect", async () => {
    report.tripsDetected = await detectRecentTrips(db)
  })

  await step("history.prune", async () => {
    report.prunedPoints = await pruneLocationHistory(db, config)
  })

  await step("outbox.prune", async () => {
    report.prunedOutbox = await pruneOutbox(db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
  })

  await step("sessions.prune", async () => {
    report.prunedSessions = await pruneSessions(db)
  })

  return report
}

export interface Scheduler {
  stop(): void
}

/**
 * Drains the outbox until it is empty, and once more if a wake-up arrived
 * while a pass was running. Wake-ups coalesce: a burst of arrivals raises one
 * extra pass, not one per row. Retries are not covered here. A failed send
 * moves its row's next attempt into the future and nothing notifies for
 * that, so the interval tick still owns the backoff.
 */
export function createOutboxDrainer(
  db: Database,
  log: FastifyBaseLogger,
  batchSize = 100,
): { wake(): void; idle(): Promise<void> } {
  let draining: Promise<void> | null = null
  let again = false

  const run = async () => {
    do {
      again = false
      const driver = getPushDriver()
      if (!driver) return
      let summary
      do {
        summary = await drainOutbox(db, driver, { batchSize })
      } while (summary.processed === batchSize)
    } while (again)
  }

  return {
    wake() {
      if (draining) {
        again = true
        return
      }
      draining = run()
        .catch((error) => log.error({ err: error, job: "push.wake" }, "outbox drain failed"))
        .finally(() => {
          draining = null
        })
    },
    idle: () => draining ?? Promise.resolve(),
  }
}

/**
 * Overlapping runs are skipped rather than queued. When a pass outlasts the
 * interval, usually a big retention sweep, doubling up only makes it worse.
 */
export function startScheduler(db: Database, config: AppConfig, log: FastifyBaseLogger): Scheduler {
  let running = false

  const tick = async () => {
    if (running) {
      log.debug("skipping job tick; previous pass still running")
      return
    }
    running = true
    const startedAt = Date.now()
    try {
      const report = await runJobs(db, config, log)
      const didSomething = Object.values(report).some((value) => value > 0)
      if (didSomething) {
        log.info({ ...report, durationMs: Date.now() - startedAt }, "background jobs completed")
      }
    } finally {
      running = false
    }
  }

  // A short delay lets the server finish booting before the first sweep.
  const timer = setInterval(() => void tick(), config.JOB_INTERVAL_SECONDS * 1000)
  const kickoff = setTimeout(() => void tick(), 5_000)
  timer.unref?.()
  kickoff.unref?.()

  // Alerts go out the moment they commit rather than on the next tick. The
  // tick keeps running for retries and as the fallback if the listen drops.
  const drainer = createOutboxDrainer(db, log)
  let listener: { stop(): Promise<void> } | null = null
  if (getPushDriver()) {
    listenForOutbox(getSql(), drainer.wake)
      .then((handle) => {
        listener = handle
      })
      .catch((error) => log.error({ err: error }, "outbox listen failed; falling back to the tick"))
  }

  return {
    stop() {
      clearInterval(timer)
      clearTimeout(kickoff)
      void listener?.stop()
    },
  }
}

/** postgres.js returns the affected-row count in different shapes across versions. */
function readCount(result: unknown): number {
  if (typeof result === "object" && result !== null) {
    const candidate = result as { count?: number; rowCount?: number; length?: number }
    return candidate.count ?? candidate.rowCount ?? candidate.length ?? 0
  }
  return 0
}
