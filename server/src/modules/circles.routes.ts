import {
  CIRCLE_ROLES,
  DEFAULTS,
  MUTABLE_EVENT_TYPES,
  SHARING_STATES,
  roleAtLeast,
  type CircleRole,
} from "@hearth/shared"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, events, invites, users } from "../db/schema"
import type { CircleSettingsJson } from "../db/schema"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors"
import { toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { recordEvent } from "../services/feed"
import { acceptInvite, createInvite, inviteUrl, previewInvite } from "../services/invites"

const defaultSettings = (): CircleSettingsJson => ({
  historyRetentionDays: DEFAULTS.historyRetentionDays,
  minUpdateIntervalSeconds: DEFAULTS.minUpdateIntervalSeconds,
  distanceFilterMeters: DEFAULTS.distanceFilterMeters,
  lowBatteryThreshold: DEFAULTS.lowBatteryThreshold,
  allowSharingPause: true,
  allowHistory: true,
  speedAlertKmh: DEFAULTS.defaultSpeedAlertKmh,
  incidentDetection: false,
})

const settingsSchema = z.object({
  historyRetentionDays: z.number().int().min(0).max(3650).optional(),
  minUpdateIntervalSeconds: z.number().int().min(10).max(3600).optional(),
  distanceFilterMeters: z.number().int().min(0).max(5000).optional(),
  lowBatteryThreshold: z.number().min(0.01).max(0.9).optional(),
  allowSharingPause: z.boolean().optional(),
  allowHistory: z.boolean().optional(),
  speedAlertKmh: z.number().int().min(0).max(300).optional(),
  incidentDetection: z.boolean().optional(),
})

const circleIdParam = z.object({ circleId: z.string().uuid() })

function toCircleDto(
  row: typeof circles.$inferSelect,
  role: CircleRole,
  memberCount: number,
  unreadEventCount = 0,
) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    role,
    memberCount,
    settings: row.settings,
    unreadEventCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toMemberDto(row: typeof circleMembers.$inferSelect, user: typeof users.$inferSelect) {
  return {
    userId: row.userId,
    circleId: row.circleId,
    user: toPublicUser(user),
    role: row.role,
    nickname: row.nickname,
    sharingState: row.sharingState,
    pausedUntil: row.pausedUntil?.toISOString() ?? null,
    joinedAt: row.joinedAt.toISOString(),
    notifications: row.notifications,
  }
}

async function loadMemberDto(db: ReturnType<typeof getDb>, circleId: string, userId: string) {
  const [row] = await db
    .select({ member: circleMembers, user: users })
    .from(circleMembers)
    .innerJoin(users, eq(users.id, circleMembers.userId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
    .limit(1)
  if (!row) throw notFound("That person is not in this circle.")
  return toMemberDto(row.member, row.user)
}

export const circleRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/circles",
    {
      preHandler: app.authenticate,
      schema: { tags: ["circles"], summary: "Circles you belong to" },
    },
    async (request) => {
      const auth = requireAuth(request)

      const rows = await db
        .select({
          circle: circles,
          role: circleMembers.role,
          feedReadAt: circleMembers.feedReadAt,
        })
        .from(circleMembers)
        .innerJoin(circles, eq(circles.id, circleMembers.circleId))
        .where(eq(circleMembers.userId, auth.userId))
        .orderBy(desc(circles.createdAt))

      if (rows.length === 0) return []

      const circleIds = rows.map((row) => row.circle.id)

      const counts = await db
        .select({ circleId: circleMembers.circleId, count: sql<number>`count(*)::int` })
        .from(circleMembers)
        .where(inArray(circleMembers.circleId, circleIds))
        .groupBy(circleMembers.circleId)
      const memberCounts = new Map(counts.map((row) => [row.circleId, row.count]))

      // One grouped query for every unread badge, instead of a count per circle.
      const unreadRows = await db
        .select({ circleId: events.circleId, count: sql<number>`count(*)::int` })
        .from(events)
        .innerJoin(
          circleMembers,
          and(eq(circleMembers.circleId, events.circleId), eq(circleMembers.userId, auth.userId)),
        )
        .where(
          and(
            inArray(events.circleId, circleIds),
            sql`${events.occurredAt} > coalesce(${circleMembers.feedReadAt}, '-infinity'::timestamptz)`,
          ),
        )
        .groupBy(events.circleId)
      const unreadCounts = new Map(unreadRows.map((row) => [row.circleId, row.count]))

      return rows.map((row) => ({
        id: row.circle.id,
        name: row.circle.name,
        emoji: row.circle.emoji,
        color: row.circle.color,
        role: row.role,
        memberCount: memberCounts.get(row.circle.id) ?? 1,
        settings: row.circle.settings,
        unreadEventCount: unreadCounts.get(row.circle.id) ?? 0,
        createdAt: row.circle.createdAt.toISOString(),
        updatedAt: row.circle.updatedAt.toISOString(),
      }))
    },
  )

  app.post(
    "/circles",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Create a circle",
        description: "The creator becomes its owner and gets a starter invite code back.",
        body: z.object({
          name: z.string().trim().min(1).max(80),
          emoji: z.string().max(8).nullish(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .nullish(),
          settings: settingsSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)

      const [circle] = await db
        .insert(circles)
        .values({
          name: request.body.name,
          emoji: request.body.emoji ?? null,
          color: request.body.color ?? null,
          createdBy: auth.userId,
          settings: { ...defaultSettings(), ...(request.body.settings ?? {}) },
        })
        .returning()
      if (!circle) throw badRequest("Could not create the circle.")

      await db.insert(circleMembers).values({
        circleId: circle.id,
        userId: auth.userId,
        role: "owner",
        feedReadAt: new Date(),
      })

      const invite = await createInvite(db, {
        circleId: circle.id,
        createdBy: auth.userId,
        expiresInHours: 24 * 7,
      })

      return reply.code(201).send({
        id: circle.id,
        name: circle.name,
        emoji: circle.emoji,
        color: circle.color,
        role: "owner" as const,
        memberCount: 1,
        settings: circle.settings,
        unreadEventCount: 0,
        createdAt: circle.createdAt.toISOString(),
        updatedAt: circle.updatedAt.toISOString(),
        invite,
      })
    },
  )

  app.get(
    "/circles/:circleId",
    {
      preHandler: app.authenticate,
      schema: { tags: ["circles"], summary: "Circle detail", params: circleIdParam },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)
      const [circle] = await db
        .select()
        .from(circles)
        .where(eq(circles.id, membership.circleId))
        .limit(1)
      if (!circle) throw notFound()

      const [{ count } = { count: 1 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(circleMembers)
        .where(eq(circleMembers.circleId, circle.id))

      return toCircleDto(circle, membership.role, count)
    },
  )

  app.patch(
    "/circles/:circleId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Update a circle",
        params: circleIdParam,
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          emoji: z.string().max(8).nullish(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .nullish(),
          settings: settingsSchema.optional(),
        }),
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId, "admin")

      const [current] = await db
        .select()
        .from(circles)
        .where(eq(circles.id, membership.circleId))
        .limit(1)
      if (!current) throw notFound()

      const [updated] = await db
        .update(circles)
        .set({
          name: request.body.name ?? current.name,
          emoji: request.body.emoji === undefined ? current.emoji : request.body.emoji,
          color: request.body.color === undefined ? current.color : request.body.color,
          settings: { ...current.settings, ...(request.body.settings ?? {}) },
          updatedAt: new Date(),
        })
        .where(eq(circles.id, membership.circleId))
        .returning()
      if (!updated) throw notFound()

      const [{ count } = { count: 1 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(circleMembers)
        .where(eq(circleMembers.circleId, updated.id))
      return toCircleDto(updated, membership.role, count)
    },
  )

  app.delete(
    "/circles/:circleId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Delete a circle",
        description: "Owner only. Removes its places, invites and activity for everyone.",
        params: circleIdParam,
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId, "owner")
      await db.delete(circles).where(eq(circles.id, membership.circleId))
      return { ok: true }
    },
  )

  app.get(
    "/circles/:circleId/members",
    {
      preHandler: app.authenticate,
      schema: { tags: ["circles"], summary: "List members", params: circleIdParam },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)
      const rows = await db
        .select({ member: circleMembers, user: users })
        .from(circleMembers)
        .innerJoin(users, eq(users.id, circleMembers.userId))
        .where(eq(circleMembers.circleId, membership.circleId))
        .orderBy(circleMembers.joinedAt)

      return rows.map((row) => toMemberDto(row.member, row.user))
    },
  )

  app.patch(
    "/circles/:circleId/members/:userId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Change a member's role or nickname",
        description:
          "Admins may set nicknames and promote up to their own level. Only the owner can " +
          "transfer ownership, and doing so demotes them to admin.",
        params: circleIdParam.extend({ userId: z.string().uuid() }),
        body: z.object({
          role: z.enum(CIRCLE_ROLES).optional(),
          nickname: z.string().trim().max(60).nullish(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      const isSelf = auth.userId === userId
      const membership = await requireMembership(request, circleId, isSelf ? "member" : "admin")

      const [target] = await db
        .select({ role: circleMembers.role })
        .from(circleMembers)
        .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
        .limit(1)
      if (!target) throw notFound("That person is not in this circle.")

      if (request.body.role !== undefined) {
        if (isSelf) throw badRequest("You cannot change your own role.")
        // Decided by the target's current rank, not just the requested one. An
        // admin must never touch the owner or a peer admin, and only the owner
        // hands out admin or ownership.
        if (target.role === "owner")
          throw forbidden("The owner's role can only change by transfer.")
        if (membership.role !== "owner" && roleAtLeast(target.role, membership.role)) {
          throw forbidden("Only the owner can change another admin's role.")
        }
        if (membership.role !== "owner" && request.body.role !== "member") {
          throw forbidden("Only the owner can grant admin or ownership.")
        }
      }

      const nextRole = request.body.role

      await db.transaction(async (tx) => {
        if (nextRole === "owner") {
          // Promote and demote in one unit, so a failure part-way can never
          // leave the circle without an owner.
          const promoted = await tx
            .update(circleMembers)
            .set({ role: "owner" })
            .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
            .returning({ userId: circleMembers.userId })
          if (promoted.length !== 1) throw notFound("That person is not in this circle.")
          await tx
            .update(circleMembers)
            .set({ role: "admin" })
            .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, auth.userId)))
        } else if (nextRole !== undefined) {
          await tx
            .update(circleMembers)
            .set({ role: nextRole })
            .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
        }
        if (request.body.nickname !== undefined) {
          await tx
            .update(circleMembers)
            .set({ nickname: request.body.nickname })
            .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
        }
      })

      if (nextRole !== undefined) {
        await recordEvent(db, {
          circleId,
          type: "role_changed",
          actorUserId: auth.userId,
          payload: { userId, role: nextRole },
          summary: `Role updated to ${nextRole}`,
        })
      }
      return loadMemberDto(db, circleId, userId)
    },
  )

  app.delete(
    "/circles/:circleId/members/:userId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Remove a member, or leave the circle",
        params: circleIdParam.extend({ userId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      const isSelf = auth.userId === userId
      const membership = await requireMembership(request, circleId, isSelf ? "member" : "admin")

      const [target] = await db
        .select({ role: circleMembers.role })
        .from(circleMembers)
        .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
        .limit(1)
      if (!target) throw notFound("That person is not in this circle.")

      if (target.role === "owner") {
        throw conflict(
          isSelf
            ? "Transfer ownership before leaving, or delete the circle."
            : "The owner cannot be removed.",
        )
      }
      if (!isSelf && membership.role === "admin" && target.role === "admin") {
        throw forbidden("Only the owner can remove another admin.")
      }

      const [{ displayName } = { displayName: "Someone" }] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)

      await db
        .delete(circleMembers)
        .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))

      await recordEvent(db, {
        circleId,
        type: isSelf ? "member_left" : "member_removed",
        actorUserId: auth.userId,
        payload: { userId },
        summary: isSelf ? `${displayName} left the circle` : `${displayName} was removed`,
      })

      return { ok: true }
    },
  )

  app.patch(
    "/circles/:circleId/sharing",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Change how you share your location with this circle",
        description:
          "`precise` shares exact coordinates, `approximate` snaps them to a ~750 m grid, " +
          "and `paused` shares nothing. A pause may carry an expiry so it lapses on its own.",
        params: circleIdParam,
        body: z.object({
          sharingState: z.enum(SHARING_STATES),
          pausedUntil: z.string().datetime().nullish(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      await requireMembership(request, request.params.circleId)

      const [circle] = await db
        .select({ settings: circles.settings })
        .from(circles)
        .where(eq(circles.id, request.params.circleId))
        .limit(1)

      if (request.body.sharingState === "paused" && circle && !circle.settings.allowSharingPause) {
        throw forbidden("This circle does not allow pausing location sharing.")
      }

      const pausedUntil =
        request.body.sharingState === "paused" && request.body.pausedUntil
          ? new Date(request.body.pausedUntil)
          : null

      await db
        .update(circleMembers)
        .set({ sharingState: request.body.sharingState, pausedUntil })
        .where(
          and(
            eq(circleMembers.circleId, request.params.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )

      await recordEvent(db, {
        circleId: request.params.circleId,
        type: request.body.sharingState === "paused" ? "sharing_paused" : "sharing_resumed",
        actorUserId: auth.userId,
        payload: { sharingState: request.body.sharingState, pausedUntil },
        summary:
          request.body.sharingState === "paused"
            ? "Paused location sharing"
            : `Sharing location (${request.body.sharingState})`,
      })

      return loadMemberDto(db, request.params.circleId, auth.userId)
    },
  )

  app.patch(
    "/circles/:circleId/notifications",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["circles"],
        summary: "Mute specific alerts from this circle",
        params: circleIdParam,
        body: z.object({
          muted: z
            .array(z.enum(MUTABLE_EVENT_TYPES as [string, ...string[]]))
            .max(32)
            .optional(),
          mutedUntil: z.string().datetime().nullish(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const [current] = await db
        .select({ notifications: circleMembers.notifications })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )
        .limit(1)

      const next = {
        muted: (request.body.muted ?? current?.notifications.muted ?? []) as never,
        mutedUntil:
          request.body.mutedUntil === undefined
            ? (current?.notifications.mutedUntil ?? null)
            : (request.body.mutedUntil ?? null),
      }

      const [updated] = await db
        .update(circleMembers)
        .set({ notifications: next })
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )
        .returning()

      return updated?.notifications ?? next
    },
  )

  app.post(
    "/circles/:circleId/invites",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["invites"],
        summary: "Mint an invite code",
        params: circleIdParam,
        body: z.object({
          role: z.enum(["member", "admin"]).default("member"),
          maxUses: z.number().int().min(1).max(100).nullish(),
          expiresInHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 30)
            .nullish(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId, "admin")
      if (request.body.role === "admin" && membership.role !== "owner") {
        throw forbidden("Only the owner can invite admins.")
      }

      const invite = await createInvite(db, {
        circleId: membership.circleId,
        createdBy: auth.userId,
        role: request.body.role,
        maxUses: request.body.maxUses ?? null,
        // Undefined means the default. An explicit null means it never expires.
        expiresInHours:
          request.body.expiresInHours === undefined ? 24 * 7 : request.body.expiresInHours,
      })
      return reply.code(201).send(invite)
    },
  )

  app.get(
    "/circles/:circleId/invites",
    {
      preHandler: app.authenticate,
      schema: { tags: ["invites"], summary: "List active invites", params: circleIdParam },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId, "admin")
      const rows = await db
        .select({ invite: invites, creator: users })
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdBy))
        .where(and(eq(invites.circleId, membership.circleId), isNull(invites.revokedAt)))
        .orderBy(desc(invites.createdAt))

      return rows.map((row) => ({
        id: row.invite.id,
        circleId: row.invite.circleId,
        code: row.invite.code,
        role: row.invite.role,
        maxUses: row.invite.maxUses,
        uses: row.invite.uses,
        expiresAt: row.invite.expiresAt?.toISOString() ?? null,
        createdAt: row.invite.createdAt.toISOString(),
        createdBy: row.creator ? toPublicUser(row.creator) : null,
        url: inviteUrl(row.invite.code),
      }))
    },
  )

  app.delete(
    "/circles/:circleId/invites/:inviteId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["invites"],
        summary: "Revoke an invite",
        params: circleIdParam.extend({ inviteId: z.string().uuid() }),
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId, "admin")
      const [updated] = await db
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(invites.id, request.params.inviteId), eq(invites.circleId, membership.circleId)),
        )
        .returning({ id: invites.id })
      if (!updated) throw notFound("No such invite.")
      return { ok: true }
    },
  )

  app.get(
    "/invites/:code",
    {
      schema: {
        tags: ["invites"],
        summary: "Preview an invite before joining",
        description: "Unauthenticated so the app can show a join screen from a cold deep link.",
        params: z.object({ code: z.string().trim().min(4).max(16) }),
      },
    },
    async (request) => {
      // Authentication is optional here. A token, when one is present, lets the
      // preview say "you are already in this circle".
      let viewerId: string | undefined
      try {
        await app.authenticate(request, {} as never)
        viewerId = request.auth?.userId
      } catch {
        viewerId = undefined
      }
      return previewInvite(db, request.params.code, viewerId)
    },
  )

  app.post(
    "/invites/:code/accept",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["invites"],
        summary: "Join a circle with an invite code",
        params: z.object({ code: z.string().trim().min(4).max(16) }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      return acceptInvite(db, request.params.code, auth.userId)
    },
  )
}
