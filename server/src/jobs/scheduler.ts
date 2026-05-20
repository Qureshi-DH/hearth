import { DEFAULTS } from "@hearth/shared"
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import type { FastifyBaseLogger } from "fastify"

import type { Database } from "../db/client"
import { circleMembers, sessions, userPresence, users } from "../db/schema"
import type { AppConfig } from "../env"
import { getPushDriver } from "../runtime"
import { recordEvent } from "../services/feed"
import { drainOutbox, pruneOutbox, requeueStuckSends } from "../services/push"
import { getServerSettings } from "../services/settings"
import { detectTripsForUser } from "../services/trips"

export interface JobReport {
  prunedPoints: number
  prunedOutbox: number
  prunedSessions: number
  pushSent: number
  pushFailed: number
  pushSkipped: number
  tripsDetected: number
  offlineFlagged: number
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
  const MAX_BATCHES_PER_TICK = 20
  let total = 0
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
    const result = await db.execute(sql`
      with retention as (
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
      ),
      victims as (
        select lp.id
        from location_points lp
        join retention r on r.user_id = lp.user_id
        where lp.recorded_at < now() - make_interval(days => r.days)
        limit ${BATCH}
      )
      delete from location_points lp
      using victims v
      where lp.id = v.id
    `)
    const deleted = readCount(result)
    total += deleted
    if (deleted < BATCH) break
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
 * A phone that went quiet says more than one that is merely stationary, so
 * this is the alert families care about most. It fires once per outage, not
 * once per tick.
 */
async function flagOfflineDevices(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - DEFAULTS.offlineAfterSeconds * 1000)

  // If most reporting phones went quiet at once, the outage is ours, not
  // theirs. Alerting every family would be noise, so skip the tick.
  const [totals] = await db
    .select({
      reporting: sql<number>`count(*) filter (where ${userPresence.recordedAt} is not null)::int`,
      stale: sql<number>`count(*) filter (where ${userPresence.recordedAt} < ${cutoff.toISOString()}::timestamptz and ${userPresence.offlineNotifiedAt} is null)::int`,
    })
    .from(userPresence)
  if (!totals || totals.stale === 0) return 0
  if (totals.reporting >= 4 && totals.stale / totals.reporting > 0.5) return 0

  const stale = await db
    .select({ userId: userPresence.userId, displayName: users.displayName })
    .from(userPresence)
    .innerJoin(users, eq(users.id, userPresence.userId))
    .where(
      and(
        isNotNull(userPresence.recordedAt),
        lt(userPresence.recordedAt, cutoff),
        isNull(userPresence.offlineNotifiedAt),
      ),
    )
    .limit(200)

  if (stale.length === 0) return 0

  const staleIds = stale.map((row) => row.userId)
  await db
    .update(userPresence)
    .set({ offlineNotifiedAt: new Date() })
    .where(inArray(userPresence.userId, staleIds))

  const memberships = await db
    .select({ userId: circleMembers.userId, circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(inArray(circleMembers.userId, staleIds))

  for (const row of stale) {
    for (const membership of memberships.filter((m) => m.userId === row.userId)) {
      await recordEvent(db, {
        circleId: membership.circleId,
        type: "device_offline",
        actorUserId: row.userId,
        summary: `${row.displayName}'s phone stopped reporting`,
        notify: {
          title: "Phone offline",
          body: `${row.displayName}'s phone has not reported in for a while.`,
          channel: "alerts",
        },
      })
    }
  }

  return stale.length
}

async function resumeExpiredPauses(db: Database): Promise<number> {
  const expired = await db
    .update(circleMembers)
    .set({ sharingState: "precise", pausedUntil: null })
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
      detected += await db.transaction(async (tx) => {
        const [lock] = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${"hearth:trips:" + row.userId})) as ok`,
        )) as unknown as { ok: boolean }[]
        if (!lock?.ok) return 0
        return detectTripsForUser(tx as unknown as Database, row.userId)
      })
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

  await step("devices.offline", async () => {
    report.offlineFlagged = await flagOfflineDevices(db)
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

  return {
    stop() {
      clearInterval(timer)
      clearTimeout(kickoff)
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
