import type { EventType, FeedEvent } from "@hearth/shared"
import { eq, inArray } from "drizzle-orm"

import type { Database } from "../db/client"
import { events, users } from "../db/schema"
import { circleTopic } from "../lib/bus"
import { toFeedEvent, toPublicUser } from "../lib/serialize"
import { getBus, getPushDriver } from "../runtime"
import { amendArrivalLine, type PushGroup } from "./notification-groups"
import { canReplace, enqueuePush, resolveCircleRecipients } from "./push"

type Notify = {
  title: string
  body: string
  channel?: "default" | "alerts" | "sos"
  priority?: "normal" | "high"
  /** Defaults to true. You rarely want a push about your own action. */
  excludeActor?: boolean
  /** Narrows delivery. Each member's mutes still apply on top. */
  onlyUserIds?: string[]
  data?: Record<string, unknown>
  /** Hold the send back until this time. See PushMessage.notBefore. */
  notBefore?: Date
} & (
  | { group?: undefined; amends?: undefined }
  | {
      /** Joins the notification already showing about the person. */
      group: PushGroup
      /**
       * Rewrite the line of an arrival already queued for the recipient
       * instead of sending this. Only recipients with no such arrival get the
       * push. See amendArrivalLine.
       */
      amends?: { placeId: string; startedAt: Date; endedAt: Date; line: string }
    }
)

export interface RecordEventInput {
  circleId: string
  type: EventType
  actorUserId?: string | null
  payload?: Record<string, unknown>
  summary: string
  /**
   * When the thing happened, if that is not now. A backlog uploaded after an
   * outage replays real crossings, and the feed has to show them at the time
   * they happened rather than at the time the queue drained.
   */
  occurredAt?: Date
  notify?: Notify
  /**
   * Hold the websocket fan-out back and let the caller send it after its
   * transaction commits. The push queue still goes in the transaction, because
   * an outbox row is a write and must roll back with the event. A publish
   * cannot be unsent, so a frame sent inside a transaction that later aborts
   * announces something that never happened.
   */
  deferBroadcast?: boolean
}

/** Sends the fan-out a deferred recordEvent held back. Safe to call twice. */
export async function broadcastEvent(circleId: string, event: FeedEvent): Promise<void> {
  await getBus()?.publish(circleTopic(circleId), { type: "event", circleId, event })
}

/**
 * The feed row is written first, then the websocket fan-out, then the push
 * queue. A slow or broken push provider must never delay the write.
 */
export async function recordEvent(db: Database, input: RecordEventInput): Promise<FeedEvent> {
  const [row] = await db
    .insert(events)
    .values({
      circleId: input.circleId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      summary: input.summary,
      occurredAt: input.occurredAt,
    })
    .returning()

  if (!row) throw new Error("failed to persist event")

  let actor = null
  if (row.actorUserId) {
    const [actorRow] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, row.actorUserId))
      .limit(1)
    if (actorRow) actor = toPublicUser(actorRow)
  }

  const dto = toFeedEvent(row, actor)
  if (!input.deferBroadcast) await broadcastEvent(input.circleId, dto)

  if (input.notify) {
    const exclude =
      input.notify.excludeActor === false || !input.actorUserId ? [] : [input.actorUserId]
    let recipients = await resolveCircleRecipients(db, input.circleId, input.type, exclude)
    if (input.notify.onlyUserIds) {
      const allowed = new Set(input.notify.onlyUserIds)
      recipients = recipients.filter((userId) => allowed.has(userId))
    }
    const { amends, group } = input.notify
    // Only a provider that replaces cards ever shows the rewritten line.
    // Anywhere else the trip keeps its own notification.
    const driver = getPushDriver()
    if (amends && group && driver && canReplace(driver)) {
      const amended = await amendArrivalLine(db, {
        userIds: recipients,
        circleId: input.circleId,
        groupKey: group.key,
        ...amends,
      })
      recipients = recipients.filter((userId) => !amended.has(userId))
    }

    await enqueuePush(
      db,
      recipients.map((userId) => ({
        userId,
        circleId: input.circleId,
        title: input.notify!.title,
        body: input.notify!.body,
        channel: input.notify!.channel ?? "default",
        priority: input.notify!.priority ?? "high",
        notBefore: input.notify!.notBefore,
        group: input.notify!.group,
        data: {
          type: input.type,
          circleId: input.circleId,
          eventId: dto.id,
          ...(input.notify!.data ?? {}),
        },
      })),
    )
  }

  return dto
}

export async function hydrateEvents(
  db: Database,
  rows: (typeof events.$inferSelect)[],
): Promise<FeedEvent[]> {
  const actorIds = [
    ...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => !!id)),
  ]
  const actors = new Map<string, ReturnType<typeof toPublicUser>>()

  if (actorIds.length > 0) {
    const actorRows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, actorIds))
    for (const actorRow of actorRows) actors.set(actorRow.id, toPublicUser(actorRow))
  }

  return rows.map((row) =>
    toFeedEvent(row, row.actorUserId ? (actors.get(row.actorUserId) ?? null) : null),
  )
}
