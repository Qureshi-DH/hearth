import type { PushProvider } from "@hearth/shared"
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, notificationOutbox, sessions, type OutboxRow } from "../db/schema"
import type { AppConfig } from "../env"

export interface PushMessage {
  userId: string
  circleId?: string | null
  title: string
  body: string
  data?: Record<string, unknown>
  channel?: "default" | "alerts" | "sos"
  priority?: "normal" | "high"
}

export interface DeliveryTarget {
  sessionId: string
  token: string
  provider: PushProvider
  platform: string | null
}

export interface DeliveryResult {
  ok: boolean
  /** The token is dead. Clear it rather than retrying it forever. */
  invalidToken?: boolean
  error?: string
}

export interface PushDriver {
  readonly provider: PushProvider
  send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult>
}

const MAX_ATTEMPTS = 6
/** Backoff in seconds, indexed by attempt count. */
const BACKOFF = [10, 60, 300, 900, 3600, 21600]

/**
 * No push transport configured. The app still works, since it polls and holds
 * a websocket while in the foreground. Rows are marked "skipped" so operators
 * can see what would have been sent.
 */
class NoopDriver implements PushDriver {
  readonly provider = "none" as const
  async send(): Promise<DeliveryResult> {
    return { ok: true }
  }
}

/**
 * Expo's hosted push service relays to APNs and FCM, so a deployment needs no
 * Apple or Google credentials. The cost is that notification metadata routes
 * through a third party. See docs/PUSH-NOTIFICATIONS.md.
 */
class ExpoDriver implements PushDriver {
  readonly provider = "expo" as const

  constructor(private readonly accessToken?: string) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
    }
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          to: target.token,
          title: message.title,
          body: message.body,
          data: message.data ?? {},
          sound: message.channel === "sos" ? "default" : null,
          // Without this iOS files an SOS as an ordinary alert, so Focus or Do
          // Not Disturb silences the one notification that must not be
          // silenced. Android's equivalent is the channel's bypassDnd.
          interruptionLevel: message.channel === "sos" ? "time-sensitive" : undefined,
          priority: message.priority === "high" ? "high" : "default",
          channelId: message.channel ?? "default",
          // SOS must survive Doze / low-power mode on Android.
          _displayInForeground: message.channel === "sos",
        },
      ]),
    })

    if (!response.ok) {
      return { ok: false, error: `expo http ${response.status}: ${await safeText(response)}` }
    }

    const payload = (await response.json()) as {
      data?: Array<{ status: string; message?: string; details?: { error?: string } }>
    }
    const ticket = payload.data?.[0]
    if (!ticket) return { ok: false, error: "expo returned no ticket" }
    if (ticket.status === "ok") return { ok: true }

    const detail = ticket.details?.error
    return {
      ok: false,
      invalidToken: detail === "DeviceNotRegistered" || detail === "InvalidCredentials",
      error: `expo ${ticket.status}: ${ticket.message ?? detail ?? "unknown"}`,
    }
  }
}

/**
 * ntfy / UnifiedPush is fully self-hostable. The phone holds a long-lived
 * socket to your own ntfy server, so no payload reaches a third party and no
 * Google or Apple account is needed. iOS works through the ntfy app.
 */
class NtfyDriver implements PushDriver {
  readonly provider = "ntfy" as const

  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.token) headers.authorization = `Bearer ${this.token}`

    const response = await fetch(this.baseUrl.replace(/\/+$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic: target.token,
        title: message.title,
        message: message.body,
        priority: message.channel === "sos" ? 5 : message.priority === "high" ? 4 : 3,
        tags: message.channel === "sos" ? ["rotating_light"] : undefined,
        extras: flattenExtras(message.data ?? {}),
      }),
    })

    if (!response.ok) {
      return { ok: false, error: `ntfy http ${response.status}: ${await safeText(response)}` }
    }
    return { ok: true }
  }
}

/**
 * Web Push (VAPID). Self-contained for browsers, and on Android for any
 * UnifiedPush-capable client. iOS Safari supports it only for home-screen apps.
 */
class WebPushDriver implements PushDriver {
  readonly provider = "webpush" as const

  constructor(
    private readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const webpush = (await import("web-push")).default
    webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey)

    let subscription: unknown
    try {
      subscription = JSON.parse(target.token)
    } catch {
      return { ok: false, invalidToken: true, error: "malformed web push subscription" }
    }

    try {
      await webpush.sendNotification(
        subscription as Parameters<typeof webpush.sendNotification>[0],
        JSON.stringify({
          title: message.title,
          body: message.body,
          data: message.data ?? {},
        }),
        { urgency: message.channel === "sos" ? "high" : "normal", TTL: 60 * 60 },
      )
      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      return {
        ok: false,
        invalidToken: status === 404 || status === 410,
        error: `webpush ${status ?? "error"}: ${(error as Error).message}`,
      }
    }
  }
}

export function createPushDriver(config: AppConfig): PushDriver {
  switch (config.PUSH_PROVIDER) {
    case "expo":
      return new ExpoDriver(config.EXPO_ACCESS_TOKEN)
    case "ntfy":
      return new NtfyDriver(config.NTFY_INTERNAL_URL || config.NTFY_BASE_URL!, config.NTFY_TOKEN)
    case "webpush":
      return new WebPushDriver(
        config.VAPID_PUBLIC_KEY!,
        config.VAPID_PRIVATE_KEY!,
        config.VAPID_SUBJECT,
      )
    case "none":
    default:
      return new NoopDriver()
  }
}

/**
 * Callers pass the same transaction handle they used for the state change, so
 * a notification can never describe an event that was rolled back.
 */
export async function enqueuePush(db: Database, messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return
  await db.insert(notificationOutbox).values(
    messages.map((message) => ({
      userId: message.userId,
      circleId: message.circleId ?? null,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      channel: message.channel ?? ("default" as const),
      priority: message.priority ?? ("normal" as const),
    })),
  )
}

export async function resolveCircleRecipients(
  db: Database,
  circleId: string,
  eventType: string,
  excludeUserIds: string[] = [],
): Promise<string[]> {
  const rows = await db
    .select({ userId: circleMembers.userId, notifications: circleMembers.notifications })
    .from(circleMembers)
    .where(eq(circleMembers.circleId, circleId))

  const now = Date.now()
  return rows
    .filter((row) => !excludeUserIds.includes(row.userId))
    .filter((row) => {
      const prefs = row.notifications
      if (prefs.mutedUntil && Date.parse(prefs.mutedUntil) > now) return false
      return !prefs.muted.includes(eventType as never)
    })
    .map((row) => row.userId)
}

export interface DrainSummary {
  processed: number
  sent: number
  failed: number
  skipped: number
}

/**
 * Idempotency is best effort by design. A duplicate push is a far smaller
 * problem than a missed "your kid left school" alert, so rows are marked sent
 * only after the driver acknowledges them.
 */
export async function drainOutbox(
  db: Database,
  driver: PushDriver,
  options: { batchSize?: number; now?: Date } = {},
): Promise<DrainSummary> {
  const batchSize = options.batchSize ?? 50
  const now = options.now ?? new Date()
  const summary: DrainSummary = { processed: 0, sent: 0, failed: 0, skipped: 0 }

  // SKIP LOCKED claims rows atomically, so several API replicas, or an admin
  // "flush now" racing the scheduler, cannot deliver the same alert twice.
  const raw = (await db.execute(sql`
    update notification_outbox
    set status = 'sending'
    where id in (
      select id from notification_outbox
      where status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
      order by next_attempt_at asc
      limit ${batchSize}
      for update skip locked
    )
    returning *
  `)) as unknown as Array<Record<string, unknown>>

  const claimed = raw.map(rowFromDriver)
  if (claimed.length === 0) return summary

  if (driver.provider === "none") {
    await db
      .update(notificationOutbox)
      .set({ status: "skipped", sentAt: now, lastError: "no push provider configured" })
      .where(
        inArray(
          notificationOutbox.id,
          claimed.map((row) => row.id),
        ),
      )
    summary.processed = claimed.length
    summary.skipped = claimed.length
    return summary
  }

  const userIds = [...new Set(claimed.map((row) => row.userId))]
  const deviceRows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      token: sessions.pushToken,
      provider: sessions.pushProvider,
      platform: sessions.platform,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.userId, userIds),
        isNull(sessions.revokedAt),
        eq(sessions.pushProvider, driver.provider),
        sql`${sessions.pushToken} is not null`,
      ),
    )

  const byUser = new Map<string, DeliveryTarget[]>()
  for (const row of deviceRows) {
    if (!row.token || !row.provider) continue
    const list = byUser.get(row.userId) ?? []
    list.push({
      sessionId: row.id,
      token: row.token,
      provider: row.provider,
      platform: row.platform,
    })
    byUser.set(row.userId, list)
  }

  for (const row of claimed) {
    summary.processed += 1
    const targets = byUser.get(row.userId) ?? []

    if (targets.length === 0) {
      await db
        .update(notificationOutbox)
        .set({ status: "skipped", sentAt: now, lastError: "no registered device" })
        .where(eq(notificationOutbox.id, row.id))
      summary.skipped += 1
      continue
    }

    const message: PushMessage = {
      userId: row.userId,
      circleId: row.circleId,
      title: row.title,
      body: row.body,
      data: row.data,
      channel: row.channel,
      priority: row.priority,
    }

    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          return await driver.send(target, message)
        } catch (error) {
          return { ok: false, error: (error as Error).message } satisfies DeliveryResult
        }
      }),
    )

    const deadTokens = targets
      .filter((_, index) => results[index]?.invalidToken)
      .map((target) => target.sessionId)
    if (deadTokens.length > 0) {
      await db
        .update(sessions)
        .set({ pushToken: null, pushProvider: null })
        .where(inArray(sessions.id, deadTokens))
    }

    if (results.some((result) => result.ok)) {
      await db
        .update(notificationOutbox)
        .set({ status: "sent", sentAt: new Date(), attempts: row.attempts + 1 })
        .where(eq(notificationOutbox.id, row.id))
      summary.sent += 1
      continue
    }

    const attempts = row.attempts + 1
    const lastError = results.find((result) => result.error)?.error ?? "delivery failed"
    const exhausted = attempts >= MAX_ATTEMPTS
    const delaySeconds = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] ?? 3600

    await db
      .update(notificationOutbox)
      .set({
        status: exhausted ? "failed" : "pending",
        attempts,
        lastError,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
      })
      .where(eq(notificationOutbox.id, row.id))
    summary.failed += 1
  }

  return summary
}

/** A raw db.execute comes back in snake_case, not the Drizzle row shape. */
function rowFromDriver(raw: Record<string, unknown>): OutboxRow {
  return {
    id: Number(raw.id),
    userId: String(raw.user_id),
    sessionId: (raw.session_id as string | null) ?? null,
    circleId: (raw.circle_id as string | null) ?? null,
    title: String(raw.title),
    body: String(raw.body),
    data: (raw.data as Record<string, unknown>) ?? {},
    channel: raw.channel as OutboxRow["channel"],
    priority: raw.priority as OutboxRow["priority"],
    status: raw.status as OutboxRow["status"],
    attempts: Number(raw.attempts),
    lastError: (raw.last_error as string | null) ?? null,
    nextAttemptAt: new Date(raw.next_attempt_at as string),
    createdAt: new Date(raw.created_at as string),
    sentAt: raw.sent_at ? new Date(raw.sent_at as string) : null,
  }
}

/**
 * A replica that dies mid-drain leaves rows stuck in "sending" with nobody to
 * retry them.
 */
export async function requeueStuckSends(db: Database, olderThan: Date): Promise<number> {
  const rows = await db
    .update(notificationOutbox)
    .set({ status: "pending" })
    .where(
      and(
        eq(notificationOutbox.status, "sending"),
        lte(notificationOutbox.nextAttemptAt, olderThan),
      ),
    )
    .returning({ id: notificationOutbox.id })
  return rows.length
}

export async function pruneOutbox(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(notificationOutbox)
    .where(
      and(
        or(
          eq(notificationOutbox.status, "sent"),
          eq(notificationOutbox.status, "skipped"),
          eq(notificationOutbox.status, "failed"),
        ),
        lte(notificationOutbox.createdAt, olderThan),
      ),
    )
    .returning({ id: notificationOutbox.id })
  return deleted.length
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return "<unreadable body>"
  }
}

/** ntfy `extras` only accepts string values. */
function flattenExtras(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return out
}
