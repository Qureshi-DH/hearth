import type { CircleInvite, InvitePreview } from "@hearth/shared"
import { and, eq, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, circles, invites, users } from "../db/schema"
import { getConfig } from "../env"
import { badRequest, notFound } from "../lib/errors"
import { inviteCode } from "../lib/ids"
import { toPublicUser } from "../lib/serialize"
import { recordEvent } from "./feed"

export function inviteUrl(code: string): string {
  const config = getConfig()
  return `${config.PUBLIC_URL.replace(/\/+$/, "")}/join/${code}`
}

export async function createInvite(
  db: Database,
  options: {
    circleId: string
    createdBy: string
    role?: "member" | "admin"
    maxUses?: number | null
    expiresInHours?: number | null
  },
): Promise<CircleInvite> {
  const expiresAt =
    options.expiresInHours == null
      ? null
      : new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)

  // Codes stay short so they can be read aloud and typed by a child. Retry the
  // rare collision rather than making them longer.
  let row: typeof invites.$inferSelect | undefined
  for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
    const [candidate] = await db
      .insert(invites)
      .values({
        circleId: options.circleId,
        code: inviteCode(),
        role: options.role ?? "member",
        createdBy: options.createdBy,
        maxUses: options.maxUses ?? null,
        expiresAt,
      })
      .onConflictDoNothing({ target: invites.code })
      .returning()
    row = candidate
  }
  if (!row) throw badRequest("Could not allocate an invite code; try again.")

  const [creator] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarColor: users.avatarColor,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, options.createdBy))
    .limit(1)

  return {
    id: row.id,
    circleId: row.circleId,
    code: row.code,
    role: row.role,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: creator ? toPublicUser(creator) : null,
    url: inviteUrl(row.code),
  }
}

/** Never throws for a bad code. An unusable one comes back with a reason. */
export async function previewInvite(
  db: Database,
  code: string,
  viewerId?: string,
): Promise<InvitePreview> {
  const normalized = code.trim().toUpperCase()

  const [row] = await db
    .select({
      invite: invites,
      circleName: circles.name,
      circleEmoji: circles.emoji,
      inviterName: users.displayName,
    })
    .from(invites)
    .innerJoin(circles, eq(circles.id, invites.circleId))
    .leftJoin(users, eq(users.id, invites.createdBy))
    .where(eq(invites.code, normalized))
    .limit(1)

  if (!row) {
    return {
      code: normalized,
      circleName: "",
      circleEmoji: null,
      memberCount: 0,
      invitedBy: null,
      role: "member",
      expiresAt: null,
      valid: false,
      reason: "not_found",
    }
  }

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(circleMembers)
    .where(eq(circleMembers.circleId, row.invite.circleId))

  const base = {
    code: normalized,
    circleName: row.circleName,
    circleEmoji: row.circleEmoji,
    memberCount: count,
    invitedBy: row.inviterName,
    role: row.invite.role,
    expiresAt: row.invite.expiresAt?.toISOString() ?? null,
  }

  const reason = invalidReason(row.invite)
  if (reason) return { ...base, valid: false, reason }

  if (viewerId) {
    const [existing] = await db
      .select({ userId: circleMembers.userId })
      .from(circleMembers)
      .where(
        and(eq(circleMembers.circleId, row.invite.circleId), eq(circleMembers.userId, viewerId)),
      )
      .limit(1)
    if (existing) return { ...base, valid: false, reason: "already_member" }
  }

  return { ...base, valid: true }
}

function invalidReason(invite: typeof invites.$inferSelect): InvitePreview["reason"] | null {
  if (invite.revokedAt) return "revoked"
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) return "expired"
  if (invite.maxUses != null && invite.uses >= invite.maxUses) return "exhausted"
  return null
}

export interface AcceptResult {
  circleId: string
  circleName: string
  role: "member" | "admin" | "owner"
  alreadyMember: boolean
}

/**
 * The `uses` counter moves with a conditional UPDATE, so two people racing for
 * the last seat of a capped invite cannot both win.
 */
export async function acceptInvite(
  db: Database,
  code: string,
  userId: string,
): Promise<AcceptResult> {
  const normalized = code.trim().toUpperCase()

  const [invite] = await db.select().from(invites).where(eq(invites.code, normalized)).limit(1)
  if (!invite) throw notFound("That invite code does not exist.")

  const reason = invalidReason(invite)
  if (reason) {
    throw badRequest(
      reason === "expired"
        ? "That invite has expired."
        : reason === "revoked"
          ? "That invite was revoked."
          : "That invite has already been used up.",
    )
  }

  const [circle] = await db
    .select({ id: circles.id, name: circles.name })
    .from(circles)
    .where(eq(circles.id, invite.circleId))
    .limit(1)
  if (!circle) throw notFound("That circle no longer exists.")

  const [existing] = await db
    .select({ role: circleMembers.role })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, invite.circleId), eq(circleMembers.userId, userId)))
    .limit(1)

  if (existing) {
    return {
      circleId: circle.id,
      circleName: circle.name,
      role: existing.role,
      alreadyMember: true,
    }
  }

  // Membership goes in first, idempotent on the primary key, and only then is
  // a seat spent. Two taps on "Join" must not burn two seats or slip past a
  // capped invite.
  const joined = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(circleMembers)
      .values({
        circleId: invite.circleId,
        userId,
        role: invite.role,
        // A newcomer should not see the circle's whole past as "unread".
        feedReadAt: new Date(),
      })
      .onConflictDoNothing({ target: [circleMembers.circleId, circleMembers.userId] })
      .returning({ userId: circleMembers.userId })

    if (inserted.length === 0) return false

    const claimed = await tx
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(
        and(
          eq(invites.id, invite.id),
          invite.maxUses == null ? sql`true` : sql`${invites.uses} < ${invite.maxUses}`,
        ),
      )
      .returning({ id: invites.id })

    if (claimed.length === 0) throw badRequest("That invite has already been used up.")
    return true
  })

  if (!joined) {
    // Lost a race with a concurrent accept from the same account. They are in.
    const [row] = await db
      .select({ role: circleMembers.role })
      .from(circleMembers)
      .where(and(eq(circleMembers.circleId, invite.circleId), eq(circleMembers.userId, userId)))
      .limit(1)
    return {
      circleId: circle.id,
      circleName: circle.name,
      role: row?.role ?? invite.role,
      alreadyMember: true,
    }
  }

  const [joiner] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  await recordEvent(db, {
    circleId: invite.circleId,
    type: "member_joined",
    actorUserId: userId,
    payload: { inviteId: invite.id },
    summary: `${joiner?.displayName ?? "Someone"} joined ${circle.name}`,
    notify: {
      title: circle.name,
      body: `${joiner?.displayName ?? "Someone"} joined the circle.`,
    },
  })

  return { circleId: circle.id, circleName: circle.name, role: invite.role, alreadyMember: false }
}
