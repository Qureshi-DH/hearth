import type { WatchResponse } from "@hearth/shared"
import { and, desc, eq, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm"

import type { Database } from "../db/client"
import { liveWatches, sessions, userPresence } from "../db/schema"
import { getPushDriver } from "../runtime"
import { CONTROL_ACK_MS, sendControl } from "./control"
import { enqueuePush, recentSilentPushes } from "./push"
import { liveUntil } from "./sos"

/**
 * A push may not have arrived, so a phone that has said nothing since is
 * pushed again after this, three times per window at most, and a phone
 * that is not going to answer is not chased all evening.
 */
const WATCH_REPUSH_AFTER_MS = 90 * 1000
const WATCH_PUSHES_PER_WINDOW = 3
/**
 * A phone on Live uploads every second. This long without a word is a phone
 * whose live service stopped, whatever it answered earlier in the window.
 */
const WATCH_QUIET_MS = 20 * 1000

/**
 * The phone's window is the latest hold of anybody still watching. Holds
 * that have lapsed go, so the table only ever has the viewers of the moment.
 */
async function settleWindow(db: Database, userId: string, now: Date) {
  await db
    .delete(liveWatches)
    .where(and(eq(liveWatches.userId, userId), lte(liveWatches.until, now)))
  const [latest] = await db
    .select({ until: liveWatches.until })
    .from(liveWatches)
    .where(eq(liveWatches.userId, userId))
    .orderBy(desc(liveWatches.until))
    .limit(1)
  const watchedUntil = latest?.until ?? null
  await db
    .insert(userPresence)
    .values({ userId, watchedUntil })
    .onConflictDoUpdate({ target: userPresence.userId, set: { watchedUntil } })
  return watchedUntil
}

/** One viewer's Live page asking, or holding the window it already has. */
export async function holdWatch(
  db: Database,
  hold: { userId: string; viewerId: string; circleId: string; seconds: number; now: Date },
): Promise<Date | null> {
  const until = new Date(hold.now.getTime() + hold.seconds * 1000)
  await db
    .insert(liveWatches)
    .values({ userId: hold.userId, viewerId: hold.viewerId, circleId: hold.circleId, until })
    .onConflictDoUpdate({
      target: [liveWatches.userId, liveWatches.viewerId],
      set: { until, circleId: hold.circleId },
    })
  return settleWindow(db, hold.userId, hold.now)
}

/**
 * Takes away the holds that match, and tells each phone left with nobody
 * watching that its window is over. The upload reply would say so within a
 * second on a phone that is live, and the channel reaches one whose uploads
 * are failing or that has none to make. An open SOS keeps the phone on
 * Live, so nothing is said to it then.
 */
export async function endWatches(db: Database, which: SQL | undefined, now = new Date()) {
  const ended = await db
    .delete(liveWatches)
    .where(which)
    .returning({ userId: liveWatches.userId, until: liveWatches.until })
  const users = new Set(ended.map((row) => row.userId))
  for (const userId of users) {
    const after = await settleWindow(db, userId, now)
    if (after) continue
    if (!ended.some((row) => row.userId === userId && row.until.getTime() > now.getTime())) continue
    if (await liveUntil(db, userId, now)) continue
    await sendControl(db, userId, { command: "watch", seconds: 0 }, now)
  }
}

/**
 * What the watch did about the phone, in the words the Live page shows.
 * Down the channel first, believed only when the phone says it has the ask,
 * so a socket iOS suspended with the app costs seconds rather than the
 * minute until the next hold. Then by push. "Held" is the ordinary answer
 * on the calls that hold a window open, when a push went moments ago or the
 * phone is talking. A phone that answered and then went quiet, because
 * Android stopped its live service mid window, is pushed again.
 */
export async function pushForWatch(
  db: Database,
  userId: string,
  now: Date,
  heardAt: Date | null,
  seconds: number,
): Promise<WatchResponse["pushed"]> {
  if (
    await sendControl(db, userId, { command: "watch", seconds }, now, {
      awaitAckMs: CONTROL_ACK_MS,
    })
  ) {
    return "socket"
  }
  if (getPushDriver()?.provider !== "expo") return "unsupported"
  const [device] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        eq(sessions.pushProvider, "expo"),
        isNotNull(sessions.pushToken),
      ),
    )
    .limit(1)
  if (!device) return "no_device"

  const pushes = await recentSilentPushes(
    db,
    userId,
    "watch",
    new Date(now.getTime() - seconds * 1000),
  )
  const newest = pushes[0]
  if (newest) {
    const talking = heardAt != null && now.getTime() - heardAt.getTime() < WATCH_QUIET_MS
    if (
      talking ||
      pushes.length >= WATCH_PUSHES_PER_WINDOW ||
      now.getTime() - newest.createdAt.getTime() < WATCH_REPUSH_AFTER_MS
    ) {
      return "held"
    }
  }
  await enqueuePush(db, [
    { userId, title: "", body: "", silent: true, data: { type: "watch", seconds } },
  ])
  return "sent"
}

export const watchesOf = (userId: string, viewerId: string) =>
  and(eq(liveWatches.userId, userId), eq(liveWatches.viewerId, viewerId))

export const watchesThrough = (circleId: string, userId: string) =>
  and(eq(liveWatches.circleId, circleId), eq(liveWatches.userId, userId))

/** Gone from the circle, as the one watched or the one watching. */
export const watchesInvolving = (circleId: string, userId: string) =>
  and(
    eq(liveWatches.circleId, circleId),
    or(eq(liveWatches.userId, userId), eq(liveWatches.viewerId, userId)),
  )
