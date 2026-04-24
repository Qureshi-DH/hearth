import { DEFAULTS, QUICK_MESSAGES } from "@hearth/shared"
import { and, desc, eq, lt } from "drizzle-orm"
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
      const membership = await requireMembership(request, request.params.circleId)
      const rows = await db
        .select({ message: messages, author: users })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            eq(messages.circleId, membership.circleId),
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
          "Either free text or a canned quick-reply key. Delivered as a push to every " +
          "other member and over the websocket to anyone with the app open.",
        params: circleIdParam,
        body: z
          .object({
            body: z.string().trim().min(1).max(DEFAULTS.maxMessageLength).optional(),
            quickKey: z.enum(QUICK_KEYS as [string, ...string[]]).optional(),
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

      const dto = {
        id: created.id,
        circleId: created.circleId,
        author: author ? toPublicUser(author) : null,
        body: created.body,
        quickKey: created.quickKey,
        createdAt: created.createdAt.toISOString(),
      }

      await getBus()?.publish(circleTopic(membership.circleId), {
        type: "message",
        circleId: membership.circleId,
        message: dto,
      })

      const recipients = (
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
