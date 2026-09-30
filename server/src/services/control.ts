import { eq, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { userPresence } from "../db/schema"
import { userTopic } from "../lib/bus"
import { getBus } from "../runtime"

/**
 * A phone that is awake keeps a socket open and declares it its control
 * channel; an ask goes down it and reaches the tracker within a second. The
 * silent push is for a phone with nothing open, which on Android is a parked
 * one. The channel's socket refreshes this stamp on every heartbeat, and a
 * close clears it, so "open" is a stamp younger than two heartbeats plus
 * change: a socket that died without a close stops counting on its own.
 * The heartbeat is the control socket's own, below, not the on-screen one.
 */
export const CONTROL_FRESH_MS = 5 * 60 * 1000

/**
 * How often the server pings a declared control socket. Every ping wakes a
 * backgrounded phone's radio, so this is far slower than the on-screen
 * socket's half minute. The stamp above outlasts two of them, and a socket
 * that has not answered one ping by the time the next is due is terminated,
 * which clears the stamp at once.
 */
export const CONTROL_HEARTBEAT_MS = 2 * 60 * 1000

/**
 * How long a phone that took an ask has to be heard from before the channel
 * it went down is doubted. An answer takes a second or two, and a socket iOS
 * let die without a close keeps its stamp for minutes.
 */
export const CONTROL_ANSWER_GRACE_MS = 20 * 1000

export type ControlCommand = { command: "watch"; seconds: number } | { command: "wake" }

export async function markControlSeen(db: Database, userId: string): Promise<void> {
  const now = new Date()
  await db
    .insert(userPresence)
    .values({ userId, controlSeenAt: now })
    .onConflictDoUpdate({ target: userPresence.userId, set: { controlSeenAt: now } })
}

export async function clearControlSeen(db: Database, userId: string): Promise<void> {
  await db.update(userPresence).set({ controlSeenAt: null }).where(eq(userPresence.userId, userId))
}

/** The SQL form, for sweeps that pick candidates in one query. */
export const controlOpenSql = (fresherThan: Date) =>
  sql`${userPresence.controlSeenAt} > ${fresherThan.toISOString()}::timestamptz`

/**
 * Sends the ask down the channel when one is open. True means the phone
 * has it; false means it has to go by push. The bus carries it to whichever
 * replica holds the socket.
 *
 * The stamp alone is not believed. iOS suspends an app without closing its
 * socket, and the stamp stays fresh for minutes after, so an ask followed by
 * neither an upload nor a heartbeat within the grace means the channel is
 * gone, and the ask goes by push until the phone is heard from again.
 */
export async function sendControl(
  db: Database,
  userId: string,
  command: ControlCommand,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({
      seenAt: userPresence.controlSeenAt,
      askedAt: userPresence.controlAskedAt,
      recordedAt: userPresence.recordedAt,
      lastHeardAt: userPresence.lastHeardAt,
    })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)
  if (!row?.seenAt || now.getTime() - row.seenAt.getTime() >= CONTROL_FRESH_MS) return false
  const heard = Math.max(row.recordedAt?.getTime() ?? 0, row.lastHeardAt?.getTime() ?? 0)
  const asked = row.askedAt?.getTime() ?? null
  const outstanding = asked != null && heard <= asked && row.seenAt.getTime() <= asked
  if (outstanding && now.getTime() - asked >= CONTROL_ANSWER_GRACE_MS) return false
  const bus = getBus()
  if (!bus) return false
  await bus.publish(userTopic(userId), { type: "control", ...command })
  // Measured from the first ask left standing, so asks every few seconds
  // cannot keep pushing the grace back.
  if (!outstanding) {
    await db
      .update(userPresence)
      .set({ controlAskedAt: now })
      .where(eq(userPresence.userId, userId))
  }
  return true
}
