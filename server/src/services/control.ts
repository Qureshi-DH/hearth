import { and, eq, gt, sql } from "drizzle-orm"

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
 */
export const CONTROL_FRESH_MS = 90 * 1000

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

export async function controlOpen(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ userId: userPresence.userId })
    .from(userPresence)
    .where(
      and(
        eq(userPresence.userId, userId),
        gt(userPresence.controlSeenAt, new Date(now.getTime() - CONTROL_FRESH_MS)),
      ),
    )
    .limit(1)
  return row != null
}

/**
 * Sends the ask down the channel when one is open. True means the phone
 * has it; false means it has to go by push. The bus carries it to whichever
 * replica holds the socket.
 */
export async function sendControl(
  db: Database,
  userId: string,
  command: ControlCommand,
  now = new Date(),
): Promise<boolean> {
  if (!(await controlOpen(db, userId, now))) return false
  const bus = getBus()
  if (!bus) return false
  await bus.publish(userTopic(userId), { type: "control", ...command })
  return true
}
