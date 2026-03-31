import type { EventType, FeedEvent } from "@hearth/shared"
import { eq, inArray } from "drizzle-orm"

import type { Database } from "../db/client"
import { events, users } from "../db/schema"
import { circleTopic } from "../lib/bus"
import { toFeedEvent, toPublicUser } from "../lib/serialize"
import { getBus } from "../runtime"
import { enqueuePush, resolveCircleRecipients } from "./push"

export interface RecordEventInput {
  circleId: string
  type: EventType
  actorUserId?: string | null
  payload?: Record<string, unknown>
  summary: string
  notify?: {
    title: string
    body: string
    channel?: "default" | "alerts" | "sos"
    priority?: "normal" | "high"
    /** Defaults to true. You rarely want a push about your own action. */
    excludeActor?: boolean
    /** Narrows delivery. Each member's mutes still apply on top. */
    onlyUserIds?: string[]
    data?: Record<string, unknown>
  }
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
  await getBus()?.publish(circleTopic(input.circleId), {
    type: "event",
    circleId: input.circleId,
    event: dto,
  })

  if (input.notify) {
    const exclude =
      input.notify.excludeActor === false || !input.actorUserId ? [] : [input.actorUserId]
    let recipients = await resolveCircleRecipients(db, input.circleId, input.type, exclude)
    if (input.notify.onlyUserIds) {
      const allowed = new Set(input.notify.onlyUserIds)
      recipients = recipients.filter((userId) => allowed.has(userId))
    }

    await enqueuePush(
      db,
      recipients.map((userId) => ({
        userId,
        circleId: input.circleId,
        title: input.notify!.title,
        body: input.notify!.body,
        channel: input.notify!.channel ?? "default",
        priority: input.notify!.priority ?? "normal",
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
