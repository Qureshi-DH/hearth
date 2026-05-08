import { DEFAULTS, QUICK_MESSAGES } from "@hearth/shared"
import { and, desc, eq, lt, or, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, messages, users } from "../db/schema"
import { badRequest } from "../lib/errors"
import { circleTopic } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { getBus } from "../runtime"
import { enqueuePush } from "../services/push"

const circleIdParam = z.object({ circleId: z.string().uuid() })
/** Joined separately from the author so a directed message can name both. */
const recipientUser = alias(users, "recipient")
const QUICK_KEYS = QUICK_MESSAGES.map((entry) => entry.key)

export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/circles/:circleId/messages",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["messages"],
        summary: "Recent messages in the circle",
        description: "Newest first. Page backwards with the previous page's `nextCursor`.",
        params: circleIdParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().datetime().optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const rows = await db
        .select({ message: messages, author: users, recipient: recipientUser })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .leftJoin(recipientUser, eq(recipientUser.id, messages.toUserId))
        .where(
          and(
            eq(messages.circleId, membership.circleId),
            // A directed message is between two people. Everyone sees the ones
            // addressed to the whole circle.
            or(
              isNull(messages.toUserId),
              eq(messages.toUserId, auth.userId),
              eq(messages.userId, auth.userId),
            ),
            request.query.cursor
              ? lt(messages.createdAt, new Date(request.query.cursor))
              : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(request.query.limit + 1)

      const page = rows.slice(0, request.query.limit)
      return {
        items: page.map((row) => ({
          id: row.message.id,
          circleId: row.message.circleId,
          author: toPublicUser(row.author),
          toUser: row.recipient ? toPublicUser(row.recipient) : null,
          body: row.message.body,
          quickKey: row.message.quickKey,
          createdAt: row.message.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > request.query.limit
            ? (page[page.length - 1]?.message.createdAt.toISOString() ?? null)
            : null,
      }
    },
  )

  app.post(
    "/circles/:circleId/messages",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["messages"],
        summary: "Send a message to the circle",
        description:
          "Either free text or a canned quick-reply key. Without toUserId it goes to " +
          "the whole circle. With it, only that member is notified and only the two of " +
          "you can read it.",
        params: circleIdParam,
        body: z
          .object({
            body: z.string().trim().min(1).max(DEFAULTS.maxMessageLength).optional(),
            quickKey: z.enum(QUICK_KEYS as [string, ...string[]]).optional(),
            /** Omit for the whole circle. Set to aim it at one member. */
            toUserId: z.string().uuid().optional(),
          })
          .refine((value) => value.body || value.quickKey, {
            message: "Provide a body or a quickKey.",
          }),
      },
      // Enough for a real exchange, low enough that nobody can bombard a phone.
      config: { rateLimit: { max: 30, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      // Aiming a message at somebody outside the circle would leak it.
      let toUserId: string | null = null
      if (request.body.toUserId) {
        if (request.body.toUserId === auth.userId) {
          throw badRequest("You cannot message yourself.")
        }
        const [target] = await db
          .select({ userId: circleMembers.userId })
          .from(circleMembers)
          .where(
            and(
              eq(circleMembers.circleId, membership.circleId),
              eq(circleMembers.userId, request.body.toUserId),
            ),
          )
          .limit(1)
        if (!target) throw badRequest("That person is not in this circle.")
        toUserId = target.userId
      }

      const canned = request.body.quickKey
        ? QUICK_MESSAGES.find((entry) => entry.key === request.body.quickKey)
        : undefined
      const body = request.body.body?.trim() || canned?.body
      if (!body) throw badRequest("Message body is required.")

      const [created] = await db
        .insert(messages)
        .values({
          circleId: membership.circleId,
          userId: auth.userId,
          toUserId,
          body,
          quickKey: canned?.key ?? null,
        })
        .returning()
      if (!created) throw badRequest("Could not send the message.")

      const [author] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarColor: users.avatarColor,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      const [recipient] = toUserId
        ? await db
            .select({
              id: users.id,
              displayName: users.displayName,
              avatarColor: users.avatarColor,
              avatarUrl: users.avatarUrl,
            })
            .from(users)
            .where(eq(users.id, toUserId))
            .limit(1)
        : []

      const dto = {
        id: created.id,
        circleId: created.circleId,
        author: author ? toPublicUser(author) : null,
        toUser: recipient ? toPublicUser(recipient) : null,
        body: created.body,
        quickKey: created.quickKey,
        createdAt: created.createdAt.toISOString(),
      }

      await getBus()?.publish(circleTopic(membership.circleId), {
        type: "message",
        circleId: membership.circleId,
        message: dto,
      })

      const recipients = toUserId
        ? [toUserId]
        : (
            await db
              .select({ userId: circleMembers.userId })
              .from(circleMembers)
              .where(eq(circleMembers.circleId, membership.circleId))
          )
            .map((row) => row.userId)
            .filter((userId) => userId !== auth.userId)

      await enqueuePush(
        db,
        recipients.map((userId) => ({
          userId,
          circleId: membership.circleId,
          title: author?.displayName ?? "Message",
          body: created.body,
          channel: "default" as const,
          data: { type: "message", circleId: membership.circleId, messageId: created.id },
        })),
      )

      return reply.code(201).send(dto)
    },
  )
}
