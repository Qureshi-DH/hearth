import type { RefreshMemberResponse } from "@hearth/shared"
import { and, eq, isNotNull, isNull } from "drizzle-orm"

import type { Database } from "../db/client"
import { sessions, userPresence } from "../db/schema"
import { getPushDriver } from "../runtime"
import { CONTROL_ACK_MS, sendControl } from "./control"
import { enqueuePush, recentSilentPushes } from "./push"

/**
 * A page opened on one person asks their phone at once, and again on the
 * next open, but not twice in the same half minute. The fix takes a few
 * seconds and the channel or the push has already carried the ask.
 */
export const MEMBER_REFRESH_FRESH_MS = 30 * 1000

/**
 * Asks one phone for a single fresh fix, down its control channel when one is
 * open, else by silent push. Whether the person may be asked at all is the
 * caller's to decide, because a member's page and a nudge draw that line in
 * different places.
 */
export async function askPhoneForFix(
  db: Database,
  userId: string,
  now: Date,
): Promise<RefreshMemberResponse["asked"]> {
  const [presence] = await db
    .select({ recordedAt: userPresence.recordedAt, lastHeardAt: userPresence.lastHeardAt })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)
  const heardAt = Math.max(
    presence?.recordedAt?.getTime() ?? 0,
    presence?.lastHeardAt?.getTime() ?? 0,
  )
  if (now.getTime() - heardAt < MEMBER_REFRESH_FRESH_MS) return "fresh"
  // Believed only when the phone says it has it, or a page opened on an
  // iPhone iOS suspended asks nobody until the next open.
  if (await sendControl(db, userId, { command: "wake" }, now, { awaitAckMs: CONTROL_ACK_MS })) {
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

  const askedLately = await recentSilentPushes(
    db,
    userId,
    "wake",
    new Date(now.getTime() - MEMBER_REFRESH_FRESH_MS),
  )
  if (askedLately.length > 0) return "held"
  await enqueuePush(db, [{ userId, title: "", body: "", silent: true, data: { type: "wake" } }])
  return "pushed"
}
