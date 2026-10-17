import type postgres from "postgres"
import {
  COMINGS_AND_GOINGS,
  MUTABLE_EVENT_TYPES,
  type NotificationSettings,
  type PushProvider,
} from "@hearth/shared"
import { and, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import type { FastifyBaseLogger } from "fastify"

import type { Database } from "../db/client"
import {
  circleMembers,
  events,
  notificationOutbox,
  pushTickets,
  sessions,
  sosAlerts,
  userPresence,
  users,
  type OutboxRow,
} from "../db/schema"
import { ALREADY_SHOWN, composeCard, type PushGroup } from "./notification-groups"
import { quietHoursApply, quietHoursEnd } from "./notification-settings"
import { DEFAULT_READER, wordPlaceNews, type Reader, type Wording } from "./place-news"
import {
  incidentsMovedOn,
  offlineNewsOvertaken,
  placeNewsNoLongerShared,
  rowsForFormerMembers,
} from "./outbox-visibility"
import type { AppConfig } from "../env"
import { publicOnlyAgent } from "../lib/net"

export interface PushMessage {
  userId: string
  circleId?: string | null
  title: string
  body: string
  data?: Record<string, unknown>
  channel?: "default" | "alerts" | "sos"
  priority?: "normal" | "high"
  /**
   * Hold the send until this time. Used where the thing being announced might
   * be contradicted moments later, so the family is buzzed once about what
   * happened rather than twice about what turned out not to have.
   */
  notBefore?: Date
  /**
   * Nothing shown, nothing heard: the phone is woken so the app can report.
   * Only the expo provider can do this. Both platforms wake the app for a
   * data-only push, Android even from Doze, which is more than any timer
   * the app could set for itself is allowed to do.
   */
  silent?: boolean
  /** When the row was queued, so a silent push's lifetime runs from then and not from each retry. */
  queuedAt?: Date
  /** Joins the notification already showing about the same person. See notification-groups.ts. */
  group?: PushGroup
  /** The phone replaces a notification it already shows under this key instead of adding one. */
  replaceKey?: string
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
  /**
   * The provider turned this message down and would turn it down again. Some
   * providers sit behind a firewall that blocks an address after a 4xx, so
   * asking again and again is worse than pointless.
   */
  rejected?: boolean
  /** The provider could not be reached at all. No connection, no answer, or a 5xx. */
  unreachable?: boolean
  /**
   * The provider refused the server's own push credentials. Nothing about the
   * phone is wrong, and every send fails the same way until somebody fixes
   * the keys.
   */
  credentialsRefused?: boolean
  /** Expo's ticket, which its receipt is read by later. */
  ticketId?: string
  error?: string
}

/** What Expo learnt from APNs or FCM about one earlier send. */
export interface PushReceipt {
  status: "ok" | "error"
  error?: string
}

export interface PushDriver {
  readonly provider: PushProvider
  send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult>
  /** The receipts for earlier tickets, by id. Null when the provider could not be asked. */
  readReceipts?(ids: string[]): Promise<Record<string, PushReceipt> | null>
}

const MAX_ATTEMPTS = 6
/** Backoff in seconds, indexed by attempt count. */
const BACKOFF = [10, 60, 300, 900, 3600, 21600]
/**
 * An SOS is tried until it is resolved, however long the provider is out,
 * and never waits long between tries. Every minute it sits in the queue
 * after the provider is back is a minute longer the family does not know.
 */
const SOS_BACKOFF = [10, 30, 60, 120, 180]
/**
 * A possible incident goes on the SOS channel too, but nothing resolves it.
 * "Have not moved since" an hour late is a different message, and the
 * phone's own prompt forgets an incident after an hour for the same reason.
 */
const UNRESOLVED_SOS_CHANNEL_MS = 60 * 60 * 1000

/** A location request asks the phone for a fix as well as telling its owner. */
const ANSWERED_IN_BACKGROUND = new Set(["nudge_requested"])

/**
 * How long a silent push may wait for the phone before the provider drops
 * it. Without a lifetime FCM and APNs hold a message for up to four weeks,
 * and a wake that Doze held back is then delivered out of context: the phone
 * fires its GPS at a random moment to answer a question nobody is asking. A
 * watch is worth nothing once the viewer has moved on, a wake is worth one
 * sweep interval or so, and a nudge lasts about as long as the asker's
 * patience.
 */
const SILENT_TTL_SECONDS: Record<string, number> = {
  watch: 60,
  wake: 300,
  nudge: 600,
  nudge_requested: 600,
}
const DEFAULT_SILENT_TTL_SECONDS = 300

/**
 * The longest one provider call may take. A provider, or a web push endpoint
 * somebody registered, that accepts the connection and never answers would
 * otherwise hold a worker for good, and with it every job the scheduler runs
 * after the drain.
 */
const SEND_TIMEOUT_MS = 15_000

function silentTtlSeconds(data: Record<string, unknown> | undefined): number {
  const type = typeof data?.type === "string" ? data.type : ""
  return SILENT_TTL_SECONDS[type] ?? DEFAULT_SILENT_TTL_SECONDS
}

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
 * Expo's hosted push service relays to APNs and FCM, so the server needs no
 * Apple or Google credentials. Those sit with the Expo project the app was
 * built with, and every push to that build goes out under them, whichever
 * server sends it. The cost is that the notification's text routes through a
 * third party. See docs/docs/install/push-notifications.md.
 */
class ExpoDriver implements PushDriver {
  readonly provider = "expo" as const

  constructor(private readonly accessToken?: string) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
    }
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`
    return headers
  }

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const ttl = silentTtlSeconds(message.data)
    const queuedAt = Math.floor((message.queuedAt?.getTime() ?? Date.now()) / 1000)
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify([
        message.silent
          ? {
              to: target.token,
              data: message.data ?? {},
              ttl,
              expiration: queuedAt + ttl,
              // Apple documents a content-available push sent at priority 10
              // as an error and throttles it; 5, which expo calls normal, is
              // what a background push is meant to travel at. Android stays
              // high, since that is what carries a data message through Doze.
              priority: target.platform === "ios" ? "normal" : "high",
              // iOS content-available. Android reads a message with no title
              // or body as data only and hands it to the background task.
              _contentAvailable: true,
            }
          : {
              to: target.token,
              title: message.title,
              body: message.body,
              data: message.data ?? {},
              // Android plays the channel's sound for every one of these, and
              // a notification that is worth showing is worth hearing, so iOS
              // is asked for the same.
              sound: "default",
              // Without this iOS files an SOS as an ordinary alert, so Focus or Do
              // Not Disturb silences the one notification that must not be
              // silenced. Android's equivalent is the channel's bypassDnd.
              interruptionLevel: message.channel === "sos" ? "time-sensitive" : undefined,
              priority: message.priority === "high" ? "high" : "default",
              channelId: message.channel ?? "default",
              // So an SOS is still shown when the recipient already has the app open.
              _displayInForeground: message.channel === "sos",
              // iOS hands a visible push to the app in the background only
              // when it is flagged content-available, and at priority 10 that
              // is allowed for a push that shows an alert. Android passes every
              // Expo push to the app's task as it is.
              ...(target.platform === "ios" &&
              ANSWERED_IN_BACKGROUND.has(String(message.data?.type))
                ? { _contentAvailable: true }
                : {}),
              // iOS replaces a card by collapse id. Android replaces by tag,
              // and is not given a collapse id: there it becomes an FCM
              // collapse key, and FCM keeps only four of those for a phone
              // that is offline, which could cost it an SOS.
              ...(message.replaceKey
                ? target.platform === "ios"
                  ? { collapseId: message.replaceKey }
                  : { tag: message.replaceKey }
                : {}),
            },
      ]),
    })

    if (!response.ok) {
      return {
        ok: false,
        ...httpFailure(response.status),
        error: `expo http ${response.status}: ${await safeText(response)}`,
      }
    }

    const payload = (await response.json()) as {
      data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }>
    }
    const ticket = payload.data?.[0]
    if (!ticket) return { ok: false, error: "expo returned no ticket" }
    if (ticket.status === "ok") return { ok: true, ticketId: ticket.id }

    const detail = ticket.details?.error
    return {
      ok: false,
      invalidToken: detail === "DeviceNotRegistered",
      credentialsRefused: detail === "InvalidCredentials",
      rejected: detail === "MessageTooBig",
      error: `expo ${ticket.status}${detail ? ` ${detail}` : ""}: ${ticket.message ?? "unknown"}`,
    }
  }

  async readReceipts(ids: string[]): Promise<Record<string, PushReceipt> | null> {
    if (ids.length === 0) return {}
    const response = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({ ids }),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      data?: Record<string, { status?: string; details?: { error?: string } }>
    }
    const receipts: Record<string, PushReceipt> = {}
    for (const [id, receipt] of Object.entries(payload.data ?? {})) {
      receipts[id] =
        receipt.status === "ok"
          ? { status: "ok" }
          : { status: "error", error: receipt.details?.error }
    }
    return receipts
  }
}

/**
 * A 5xx is the provider down. A 4xx other than a timeout or a rate limit is
 * this message refused, and would be refused again.
 */
function httpFailure(status: number): Pick<DeliveryResult, "rejected" | "unreachable"> {
  if (status >= 500) return { unreachable: true }
  if (status === 408 || status === 429) return {}
  return { rejected: true }
}

/**
 * ntfy is fully self-hostable. The ntfy app holds a long-lived socket to your
 * own ntfy server, so no payload reaches a third party and no Google or Apple
 * account is needed. It carries alerts only: what the ntfy app shows never
 * reaches Hearth, so nothing silent goes this way. An iPhone is reached
 * through ntfy's upstream server and APNs, which pass on a message id only.
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
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
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
      return {
        ok: false,
        ...httpFailure(response.status),
        error: `ntfy http ${response.status}: ${await safeText(response)}`,
      }
    }
    return { ok: true }
  }
}

/**
 * Web Push (VAPID), for a web client. No Hearth client subscribes yet, and
 * the native app turns this provider down. iOS Safari supports it only for
 * home-screen apps.
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
        {
          urgency: message.channel === "sos" ? "high" : "normal",
          TTL: 60 * 60,
          timeout: SEND_TIMEOUT_MS,
          // Checked at connect time: the endpoint's name may have been pointed
          // at an internal address since it was registered.
          agent: publicOnlyAgent,
        },
      )
      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      const gone = status === 404 || status === 410
      return {
        ok: false,
        invalidToken: gone,
        rejected: !gone && status !== undefined && httpFailure(status).rejected,
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
      priority: message.priority ?? ("high" as const),
      silent: message.silent ?? false,
      groupKey: message.group?.key ?? null,
      groupTitle: message.group?.title ?? null,
      groupLine: message.group?.line ?? null,
      ...(message.notBefore ? { nextAttemptAt: message.notBefore } : {}),
    })),
  )
}

/**
 * Silent pushes of one kind sent to the account since a moment, newest
 * first, counting only the rows that are in flight or went. A row skipped for
 * want of a token, or failed at the provider, never reached the phone, so it
 * is neither an attempt to wait on nor a reason to hold the next one back.
 */
export async function recentSilentPushes(
  db: Database,
  userId: string,
  type: "wake" | "watch",
  since: Date,
): Promise<Array<{ createdAt: Date }>> {
  return db
    .select({ createdAt: notificationOutbox.createdAt })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.userId, userId),
        eq(notificationOutbox.silent, true),
        sql`${notificationOutbox.data}->>'type' = ${type}`,
        gt(notificationOutbox.createdAt, since),
        inArray(notificationOutbox.status, ["pending", "sending", "sent"]),
        // One the provider already turned away is not on its way to the phone,
        // and must not stop a fresh ask being sent in its place.
        sql`not (${notificationOutbox.status} = 'pending' and ${notificationOutbox.attempts} > 0)`,
      ),
    )
    .orderBy(desc(notificationOutbox.createdAt))
}

export async function resolveCircleRecipients(
  db: Database,
  circleId: string,
  eventType: string,
  excludeUserIds: string[] = [],
  /** Who and where the news is about, for the per-person and per-place choices. */
  about: { userId?: string | null; placeId?: string | null } = {},
): Promise<string[]> {
  const rows = await db
    .select({
      userId: circleMembers.userId,
      notifications: circleMembers.notifications,
      settings: users.notificationSettings,
    })
    .from(circleMembers)
    .innerJoin(users, eq(users.id, circleMembers.userId))
    .where(eq(circleMembers.circleId, circleId))

  const now = Date.now()
  const silenceable = (MUTABLE_EVENT_TYPES as readonly string[]).includes(eventType)
  const comingOrGoing = (COMINGS_AND_GOINGS as readonly string[]).includes(eventType)

  return rows
    .filter((row) => !excludeUserIds.includes(row.userId))
    .filter((row) => {
      // The product decides which alerts a member may silence, and a mute-all
      // is only a shortcut for muting those. An SOS, a possible incident or a
      // resolved alert has to arrive however deep in an evening's quiet the
      // recipient is, so neither mute reaches it.
      if (!silenceable) return true
      const prefs = row.notifications
      if (prefs.mutedUntil && Date.parse(prefs.mutedUntil) > now) return false
      if (prefs.muted.includes(eventType as never)) return false
      if (comingOrGoing && about.userId && row.settings.mutedPeople?.includes(about.userId)) {
        return false
      }
      const choice = about.placeId ? (prefs.places?.[about.placeId] ?? "both") : "both"
      if (eventType === "place_arrive") return choice === "both" || choice === "arrive"
      if (eventType === "place_leave") return choice === "both" || choice === "leave"
      return true
    })
    .map((row) => row.userId)
}

export interface DrainSummary {
  processed: number
  sent: number
  failed: number
  skipped: number
  /**
   * News for somebody this drain sent a card about is due and still waiting,
   * left behind while the card was in flight. The caller should go round
   * again rather than leave it for the next tick.
   */
  waiting: boolean
}

/**
 * Idempotency is best effort by design. A duplicate push is a far smaller
 * problem than a missed "your kid left school" alert, so rows are marked sent
 * only after the driver acknowledges them.
 */
const DEFAULT_SEND_CONCURRENCY = 8

/** The channel the outbox trigger raises on commit. Migration 0003 owns the trigger. */
export const OUTBOX_CHANNEL = "hearth_outbox"

/**
 * Wakes `onWake` the moment a transaction that queued a notification commits.
 *
 * The enqueue happens inside the caller's transaction, so nothing on the
 * application side can poke the worker at the right moment: before the commit
 * the row is invisible, and the enqueue site never learns when the commit
 * lands. Postgres delivers a NOTIFY raised by a trigger only on commit, and to
 * every replica that listens, which is exactly the timing needed. The listen
 * holds its own connection outside the pool.
 */
export async function listenForOutbox(
  sql: postgres.Sql,
  onWake: () => void,
): Promise<{ stop(): Promise<void> }> {
  const meta = await sql.listen(OUTBOX_CHANNEL, () => onWake())
  return { stop: () => meta.unlisten() }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]!
      next += 1
      await task(item)
    }
  })
  await Promise.all(workers)
}

/**
 * When this process last failed to reach the push provider at all. A home
 * server whose own uplink is down cannot reach the provider and hears from
 * no phone either, and the offline sweep reads this to tell that apart from
 * a family whose phones all went dark. Each replica keeps its own, since
 * each has its own way out.
 */
let providerFailedAt: number | null = null

/** Whether a send failed for want of the provider since that moment. */
export function pushProviderFailedSince(moment: Date): boolean {
  return providerFailedAt !== null && providerFailedAt >= moment.getTime()
}

export function forgetPushProviderFailures(): void {
  providerFailedAt = null
}

export async function drainOutbox(
  db: Database,
  driver: PushDriver,
  options: {
    batchSize?: number
    concurrency?: number
    now?: Date
    sendTimeoutMs?: number
    log?: Pick<FastifyBaseLogger, "error">
  } = {},
): Promise<DrainSummary> {
  const batchSize = options.batchSize ?? 50
  const concurrency = options.concurrency ?? DEFAULT_SEND_CONCURRENCY
  const now = options.now ?? new Date()
  const summary: DrainSummary = { processed: 0, sent: 0, failed: 0, skipped: 0, waiting: false }

  const allClaimed = await claimDue(db, batchSize, now)
  if (allClaimed.length === 0) return summary

  const members = await dropRowsForFormerMembers(db, allClaimed, now, summary)
  const shared = await dropPlaceNewsNoLongerShared(db, members, now, summary)
  const live = await dropSosAlreadyResolved(db, shared, now, summary)
  const current = await dropOfflineNewsOvertaken(db, live, now, summary)
  const relevant = await dropIncidentsOvertaken(db, current, now, summary)
  const readers = await loadReaders(db, relevant)
  const awake = await holdForQuietHours(db, relevant, readers, now, summary)
  const claimed = await foldDepartures(db, awake, now, summary)
  if (claimed.length === 0) return summary
  await wordForReaders(db, claimed, readers, now)

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
    summary.processed += claimed.length
    summary.skipped += claimed.length
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

  // Every write below is conditional on this claim still owning the row. A
  // batch that runs long can have its rows requeued and delivered by another
  // claimant, and this one must not then overwrite that result.
  const owned = (rows: OutboxRow[]) =>
    or(
      ...rows.map((row) =>
        and(
          eq(notificationOutbox.id, row.id),
          eq(notificationOutbox.status, "sending"),
          eq(notificationOutbox.nextAttemptAt, row.nextAttemptAt),
        ),
      ),
    )
  const settle = async (
    rows: OutboxRow[],
    change: PgUpdateSetSource<typeof notificationOutbox>,
  ) => {
    if (rows.length > 0) await db.update(notificationOutbox).set(change).where(owned(rows))
  }

  /**
   * One push for a lane: a single row, or every due row of one person's news
   * to one recipient, which go out as one card. The rows a push carries share
   * its fate, sent together or retried together.
   */
  const deliver = async (lane: OutboxRow[]) => {
    summary.processed += lane.length
    const head = lane.at(-1)!
    const targets = byUser.get(head.userId) ?? []

    if (targets.length === 0) {
      await settle(lane, { status: "skipped", sentAt: now, lastError: "no registered device" })
      summary.skipped += lane.length
      return
    }

    if (head.silent && driver.provider !== "expo") {
      await settle(lane, {
        status: "skipped",
        sentAt: now,
        lastError: "silent wake needs the expo provider",
      })
      summary.skipped += lane.length
      return
    }

    // A wake or a watch answers a question somebody asked moments ago. Sent
    // after its lifetime it turns the GPS on for a viewer who has long gone.
    const expiresAt = head.createdAt.getTime() + silentTtlSeconds(head.data) * 1000
    if (head.silent && now.getTime() >= expiresAt) {
      await settle(lane, { status: "failed", lastError: "expired before it could be delivered" })
      await uncountWakes(db, lane)
      summary.failed += lane.length
      return
    }

    const message: PushMessage = {
      userId: head.userId,
      circleId: head.circleId,
      title: head.title,
      body: head.body,
      data: payload(head.data),
      channel: head.channel,
      priority: head.priority,
      silent: head.silent,
      queuedAt: head.createdAt,
    }
    let carried = lane
    let groupThread: number | null = null
    const cards = canReplace(driver) && head.groupKey
    // Only a provider that replaces a card on the phone gets one. Through any
    // other a growing card would land as a new notification each time,
    // repeating everything before it, so those get each row as written.
    if (cards) {
      const { card, echoes } = await composeCard(db, lane, now)
      await settle(echoes, { status: "skipped", sentAt: now, lastError: ALREADY_SHOWN })
      summary.skipped += echoes.length
      if (!card) return
      carried = card.rows
      groupThread = card.thread
      // A tap opens what the card's newest line is about, never a copy it left out.
      const newest = card.rows.at(-1)!
      Object.assign(message, {
        circleId: newest.circleId,
        data: payload(newest.data),
        queuedAt: newest.createdAt,
        title: card.title,
        body: card.body,
        replaceKey: card.replaceKey,
      })
    } else if (canReplace(driver) && isSos(head)) {
      // The all clear takes the place of the alarm it answers.
      message.replaceKey = `sos:${String(head.data.alertId)}`
    }

    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          return await withDeadline(driver.send(target, message), options.sendTimeoutMs)
        } catch (error) {
          return {
            ok: false,
            unreachable: true,
            error: (error as Error).message,
          } satisfies DeliveryResult
        }
      }),
    )
    // Web Push sends to as many endpoints as there are subscriptions, and one
    // that never answers says nothing about the rest.
    if (driver.provider !== "webpush" && results.some((result) => result.unreachable)) {
      providerFailedAt = Date.now()
    }
    if (results.some((result) => result.credentialsRefused)) {
      options.log?.error(
        { provider: driver.provider, error: results.find((r) => r.credentialsRefused)?.error },
        "the push provider refused this server's push credentials; check the FCM and APNs keys of the Expo project the app was built with",
      )
    }

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
      await settle(carried, {
        status: "sent",
        sentAt: now,
        attempts: sql`${notificationOutbox.attempts} + 1`,
        groupThread,
      })
      summary.sent += carried.length
      await keepTickets(db, targets, results)
      return
    }

    const lastError = results.find((result) => result.error)?.error ?? "delivery failed"
    const rejected = results.every((result) => result.rejected || result.invalidToken)
    for (const row of carried) {
      const attempts = row.attempts + 1
      const urgent = row.channel === "sos" && !rejected
      const backoff = urgent ? SOS_BACKOFF : BACKOFF
      const delaySeconds = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 3600
      const retryAt = Date.now() + delaySeconds * 1000
      const exhausted = urgent
        ? row.data.type !== "sos_started" &&
          now.getTime() - row.createdAt.getTime() >= UNRESOLVED_SOS_CHANNEL_MS
        : attempts >= MAX_ATTEMPTS || (row.silent && retryAt >= expiresAt)
      await settle([row], {
        status: exhausted ? "failed" : "pending",
        attempts,
        lastError,
        nextAttemptAt: new Date(retryAt),
      })
      if (exhausted) await uncountWakes(db, [row])
    }
    summary.failed += carried.length
  }

  // A provider that replaces cards gets one person's due news as one lane,
  // and one push. Every other row is a lane of its own. The lanes are
  // independent, so a slow provider round trip for one family must not hold
  // up the next. A bounded pool rather than Promise.all, so a backlog after
  // an outage does not open hundreds of connections at once.
  const lanes: OutboxRow[][] = []
  const laneFor = new Map<string, OutboxRow[]>()
  for (const row of claimed) {
    if (!canReplace(driver) || !row.groupKey) {
      lanes.push([row])
      continue
    }
    const key = `${row.userId}|${row.groupKey}`
    const lane = laneFor.get(key)
    if (lane) {
      lane.push(row)
    } else {
      const fresh = [row]
      laneFor.set(key, fresh)
      lanes.push(fresh)
    }
  }
  await runWithConcurrency(lanes, concurrency, deliver)

  const carded = lanes.filter((lane) => lane[0]!.groupKey && canReplace(driver))
  summary.waiting = carded.length > 0 && (await siblingsDue(db, carded, now))
  return summary
}

/** What the phone is handed. The parts a row is worded from stay on the server. */
function payload(data: Record<string, unknown>): Record<string, unknown> {
  if (!("wording" in data)) return data
  const { wording: _wording, ...rest } = data
  return rest
}

interface Recipient {
  reader: Reader
  settings: NotificationSettings
}

async function loadReaders(db: Database, rows: OutboxRow[]): Promise<Map<string, Recipient>> {
  const ids = [...new Set(rows.map((row) => row.userId))]
  if (ids.length === 0) return new Map()
  const found = await db
    .select({ id: users.id, units: users.units, settings: users.notificationSettings })
    .from(users)
    .where(inArray(users.id, ids))
  return new Map(
    found.map((row) => [
      row.id,
      {
        reader: { units: row.units, timeZone: row.settings.timeZone, clock: row.settings.clock },
        settings: row.settings,
      },
    ]),
  )
}

/**
 * Place news is worded again as it goes, for the person it goes to, so a
 * held or late arrival says when it happened in their own time, and the card
 * keeps the words it was shown with.
 */
async function wordForReaders(
  db: Database,
  rows: OutboxRow[],
  readers: Map<string, Recipient>,
  now: Date,
): Promise<void> {
  for (const row of rows) {
    const wording = row.data.wording as Wording | undefined
    if (!wording || typeof wording !== "object") continue
    const { body, line } = wordPlaceNews(
      wording,
      readers.get(row.userId)?.reader ?? DEFAULT_READER,
      now,
    )
    const groupLine = row.groupKey ? line : row.groupLine
    if (body === row.body && groupLine === row.groupLine) continue
    row.body = body
    row.groupLine = groupLine
    await db
      .update(notificationOutbox)
      .set({ body, groupLine })
      .where(eq(notificationOutbox.id, row.id))
  }
}

/**
 * Ordinary news due during the recipient's quiet hours waits for them to end,
 * or is dropped, as they chose. That is everything but the safety alerts. It is checked as it goes rather than when it
 * was queued, so news held back for any other reason waits too, and the
 * morning's backlog lands as one card.
 */
async function holdForQuietHours(
  db: Database,
  claimed: OutboxRow[],
  readers: Map<string, Recipient>,
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const waiting = new Map<number, Date>()
  const dropped: number[] = []
  for (const row of claimed) {
    if (row.silent || !quietHoursApply(row.data.type)) continue
    const settings = readers.get(row.userId)?.settings
    const end = settings ? quietHoursEnd(settings, now) : null
    if (!end) continue
    if (settings!.quietHours!.then === "drop") dropped.push(row.id)
    else waiting.set(row.id, end)
  }
  if (waiting.size === 0 && dropped.length === 0) return claimed

  for (const [id, end] of waiting) {
    await db
      .update(notificationOutbox)
      .set({ status: "pending", nextAttemptAt: end })
      .where(eq(notificationOutbox.id, id))
  }
  // Handled, so a drain that held a whole batch goes on to the next one.
  summary.processed += waiting.size
  if (dropped.length > 0) {
    await db
      .update(notificationOutbox)
      .set({ status: "skipped", sentAt: now, lastError: "quiet hours" })
      .where(inArray(notificationOutbox.id, dropped))
    summary.processed += dropped.length
    summary.skipped += dropped.length
  }
  return claimed.filter((row) => !waiting.has(row.id) && !dropped.includes(row.id))
}

const FOLDED = "told with the arrival that followed"

/**
 * A departure still waiting to go when the arrival it led to goes out is
 * told by that arrival, which says where they came from. A parked phone's
 * next word after home is often already from school, and "left home" with
 * "arrived at school" a moment later is one piece of news in two buzzes. A
 * departure from the place being arrived at is a round trip, and stays.
 */
async function foldDepartures(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const arrivals = claimed.filter(
    (row) =>
      row.data.type === "place_arrive" &&
      row.circleId &&
      typeof row.data.userId === "string" &&
      typeof row.data.occurredAt === "string",
  )
  if (arrivals.length === 0) return claimed

  const folded = new Set<number>()
  for (const arrival of arrivals) {
    const arrivedAt = Date.parse(String(arrival.data.occurredAt))
    for (const row of claimed) {
      if (
        row.data.type === "place_leave" &&
        row.userId === arrival.userId &&
        row.circleId === arrival.circleId &&
        row.data.userId === arrival.data.userId &&
        row.data.placeId !== arrival.data.placeId &&
        Date.parse(String(row.data.occurredAt)) <= arrivedAt
      ) {
        folded.add(row.id)
      }
    }
    const waiting = (await db.execute(sql`
      update notification_outbox
      set status = 'skipped', sent_at = ${now.toISOString()}::timestamptz, last_error = ${FOLDED}
      where status = 'pending'
        and user_id = ${arrival.userId}::uuid
        and circle_id = ${arrival.circleId}::uuid
        and data ->> 'type' = 'place_leave'
        and data ->> 'userId' = ${String(arrival.data.userId)}
        and data ->> 'placeId' <> ${String(arrival.data.placeId)}
        and (data ->> 'occurredAt')::timestamptz <= ${String(arrival.data.occurredAt)}::timestamptz
      returning id
    `)) as unknown as Array<{ id: number }>
    summary.processed += waiting.length
    summary.skipped += waiting.length
  }
  if (folded.size === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({ status: "skipped", sentAt: now, lastError: FOLDED })
    .where(inArray(notificationOutbox.id, [...folded]))
  summary.processed += folded.size
  summary.skipped += folded.size
  return claimed.filter((row) => !folded.has(row.id))
}

/** Whether any of these people has news due that a claim passed over while their card was in flight. */
async function siblingsDue(db: Database, lanes: OutboxRow[][], now: Date): Promise<boolean> {
  const [due] = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.status, "pending"),
        lte(notificationOutbox.nextAttemptAt, now),
        or(
          ...lanes.map((lane) =>
            and(
              eq(notificationOutbox.userId, lane[0]!.userId),
              eq(notificationOutbox.groupKey, lane[0]!.groupKey!),
            ),
          ),
        ),
      ),
    )
    .limit(1)
  return Boolean(due)
}

/**
 * Longer than any one send can take, a card being a single push with its own
 * deadline. A row claimed before this was abandoned by a replica that died,
 * and stops holding back the rest of the person's news.
 */
const IN_FLIGHT_MS = 2 * 60 * 1000

/**
 * Claims the rows that are due. SKIP LOCKED keeps several replicas, or an
 * admin "flush now" racing the scheduler, from claiming one row twice, and
 * the claim stamps next_attempt_at, which is what lets requeueStuckSends
 * tell a send still in flight from one a dead replica abandoned.
 *
 * News for a card already on its way stays where it is. Sent alongside, it
 * would build its card without the line in flight, and whichever reached the
 * phone last would lose the other's. The claims take turns under one lock so
 * each sees what the last one took.
 */
async function claimDue(db: Database, batchSize: number, now: Date): Promise<OutboxRow[]> {
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hearth:outbox:claim'))`)
    const due = tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, "pending"),
          lte(notificationOutbox.nextAttemptAt, now),
          sql`not exists (
            select 1 from ${notificationOutbox} busy
            where busy.status = 'sending'
              and busy.user_id = ${notificationOutbox.userId}
              and busy.group_key = ${notificationOutbox.groupKey}
              and busy.next_attempt_at > ${new Date(now.getTime() - IN_FLIGHT_MS).toISOString()}::timestamptz
          )`,
        ),
      )
      // Nearly everything travels at high priority, since that is what gets
      // through Doze, so the SOS channel has to be its own rank here. An SOS
      // or a possible incident goes ahead of a backlog of ordinary news.
      .orderBy(
        sql`(${notificationOutbox.channel} = 'sos') desc`,
        sql`(${notificationOutbox.priority} = 'high') desc`,
        notificationOutbox.nextAttemptAt,
      )
      .limit(batchSize)
      .for("update", { skipLocked: true })
    return tx
      .update(notificationOutbox)
      .set({ status: "sending", nextAttemptAt: now })
      .where(inArray(notificationOutbox.id, due))
      .returning()
  })
  // RETURNING hands rows back in heap order, whatever the subselect asked
  // for, so the claim decides which rows make the batch and this decides who
  // goes first within it. Ids climb with enqueue order.
  return claimed.sort((a, b) => claimRank(b) - claimRank(a) || a.id - b.id)
}

const claimRank = (row: OutboxRow) =>
  (row.channel === "sos" ? 2 : 0) + (row.priority === "high" ? 1 : 0)

/** Whether the driver can replace a notification already on the phone. */
export const canReplace = (driver: Pick<PushDriver, "provider">): boolean =>
  driver.provider === "expo"

/**
 * Membership is checked again at delivery time, not only when the row was
 * queued. A backlog can sit in the outbox for hours behind a broken provider,
 * and somebody removed from the circle in the meantime must not be handed the
 * family's whereabouts on the way out. Rows with no circle, such as the
 * "test your notifications" push, belong to nobody's membership and stay.
 */
async function dropRowsForFormerMembers(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const gone = await rowsForFormerMembers(db, claimed)
  if (gone.size === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({ status: "skipped", sentAt: now, lastError: "no longer a member of that circle" })
    .where(inArray(notificationOutbox.id, [...gone]))
  summary.processed += gone.size
  summary.skipped += gone.size
  return claimed.filter((row) => !gone.has(row.id))
}

function withDeadline(
  work: Promise<DeliveryResult>,
  ms: number = SEND_TIMEOUT_MS,
): Promise<DeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<DeliveryResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          unreachable: true,
          error: `no answer from the push provider in ${ms / 1000} s`,
        }),
      ms,
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

async function dropPlaceNewsNoLongerShared(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const stale = await placeNewsNoLongerShared(db, claimed, now)
  if (stale.size === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({
      status: "skipped",
      sentAt: now,
      lastError: "no longer shared precisely with that circle",
    })
    .where(inArray(notificationOutbox.id, [...stale]))
  summary.processed += stale.size
  summary.skipped += stale.size
  return claimed.filter((row) => !stale.has(row.id))
}

/**
 * An SOS still queued once it is no longer open, typically a retry after a
 * provider outage. Sent now it would sound the alarm for something that is
 * over, and on a phone that replaces by key it would cover the all clear.
 * An alert that is gone altogether, with the account that raised it, is
 * over too, and would otherwise be retried for ever.
 */
async function dropSosAlreadyResolved(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const raised = claimed.filter((row) => row.data.type === "sos_started" && isSos(row))
  if (raised.length === 0) return claimed

  const open = await db
    .select({ id: sosAlerts.id })
    .from(sosAlerts)
    .where(
      and(
        inArray(sosAlerts.id, [...new Set(raised.map((row) => String(row.data.alertId)))]),
        isNull(sosAlerts.resolvedAt),
      ),
    )
  const stillOpen = new Set(open.map((row) => row.id))
  const stale = raised.filter((row) => !stillOpen.has(String(row.data.alertId)))
  if (stale.length === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({ status: "skipped", sentAt: now, lastError: "resolved before it could be delivered" })
    .where(
      inArray(
        notificationOutbox.id,
        stale.map((row) => row.id),
      ),
    )
  summary.processed += stale.length
  summary.skipped += stale.length
  const dropped = new Set(stale.map((row) => row.id))
  return claimed.filter((row) => !dropped.has(row.id))
}

/**
 * A possible incident whose person has since moved on, or stopped sharing
 * precisely with that circle. Either way "they have not moved since" is no
 * longer the news, and the second is precise information they withdrew.
 */
async function dropIncidentsOvertaken(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  if (!claimed.some((row) => row.data.type === "possible_incident")) return claimed
  const stale = new Set([
    ...(await placeNewsNoLongerShared(db, claimed, now, INCIDENT_NEWS)),
    ...(await incidentsMovedOn(db, claimed)),
  ])
  if (stale.size === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({ status: "skipped", sentAt: now, lastError: "overtaken before it could be delivered" })
    .where(inArray(notificationOutbox.id, [...stale]))
  summary.processed += stale.size
  summary.skipped += stale.size
  return claimed.filter((row) => !stale.has(row.id))
}

const INCIDENT_NEWS = new Set(["possible_incident"])

/**
 * A wake that never reached the provider asked the phone nothing, so it is
 * taken off the count the offline sweep reads. Left on, a server whose own
 * connection was down for an hour has "asked" every phone three times by the
 * time it is back, and calls them all offline before they can get through.
 * Only while it is still the latest wake. Otherwise a newer one, or the
 * phone speaking, has moved the count on already.
 */
async function uncountWakes(db: Database, rows: OutboxRow[]): Promise<void> {
  for (const row of rows) {
    if (!row.silent || row.data.type !== "wake") continue
    const sentBy = new Date(row.createdAt.getTime() + 60_000).toISOString()
    await db
      .update(userPresence)
      .set({ wakeCount: sql`${userPresence.wakeCount} - 1` })
      .where(
        and(
          eq(userPresence.userId, row.userId),
          gt(userPresence.wakeCount, 0),
          sql`${userPresence.wakeRequestedAt} <= ${sentBy}::timestamptz`,
        ),
      )
  }
}

async function dropOfflineNewsOvertaken(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const stale = await offlineNewsOvertaken(db, claimed)
  if (stale.size === 0) return claimed

  await db
    .update(notificationOutbox)
    .set({
      status: "skipped",
      sentAt: now,
      lastError: "the phone reported again before this went out",
    })
    .where(inArray(notificationOutbox.id, [...stale]))
  summary.processed += stale.size
  summary.skipped += stale.size
  return claimed.filter((row) => !stale.has(row.id))
}

const isSos = (row: OutboxRow) =>
  (row.data.type === "sos_started" || row.data.type === "sos_resolved") &&
  typeof row.data.alertId === "string"

/**
 * A replica that dies mid-drain leaves rows stuck in "sending" with nobody to
 * retry them. Only rows claimed before the cutoff are freed: a send still
 * waiting on the provider's HTTP response was claimed moments ago, and
 * reviving that one is how a family gets told twice about the same arrival.
 */
export async function requeueStuckSends(db: Database, claimedBefore: Date): Promise<number> {
  const rows = await db
    .update(notificationOutbox)
    .set({ status: "pending" })
    .where(
      and(
        eq(notificationOutbox.status, "sending"),
        lte(notificationOutbox.nextAttemptAt, claimedBefore),
      ),
    )
    .returning({ id: notificationOutbox.id })
  return rows.length
}

/**
 * In bounded batches, like every bulk delete here. A busy month of rows in
 * one statement holds its locks for as long as it takes, and every enqueue
 * behind it waits. What a pass does not reach is there for the next tick.
 * A row still pending or sending, an SOS being retried among them, is never
 * taken. Nor is an offline alert while its phone is still out, since it is
 * the record of who to tell when the phone comes back.
 */
export async function pruneOutbox(
  db: Database,
  olderThan: Date,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 5000
  const maxBatches = options.maxBatches ?? 20
  let total = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db
      .delete(notificationOutbox)
      .where(
        inArray(
          notificationOutbox.id,
          db
            .select({ id: notificationOutbox.id })
            .from(notificationOutbox)
            .where(
              and(
                inArray(notificationOutbox.status, ["sent", "skipped", "failed"]),
                lte(notificationOutbox.createdAt, olderThan),
                sql`not (
                  ${notificationOutbox.data}->>'type' = 'device_offline'
                  and exists (
                    select 1 from ${events} e
                    join ${userPresence} out on out.user_id = e.actor_user_id
                    where e.id = case when ${notificationOutbox.data}->>'eventId' ~ '^[0-9]+$'
                        then (${notificationOutbox.data}->>'eventId')::bigint end
                      and out.offline_notified_at is not null
                      and e.occurred_at >= out.offline_notified_at
                  )
                )`,
              ),
            )
            .limit(batchSize),
        ),
      )
      .returning({ id: notificationOutbox.id })
    total += deleted.length
    if (deleted.length < batchSize) break
  }
  return total
}

/**
 * Only a receipt says an app was uninstalled. Losing a ticket costs no more
 * than a dead token kept a little longer, so a failure here never touches
 * the send it belongs to.
 */
async function keepTickets(
  db: Database,
  targets: DeliveryTarget[],
  results: DeliveryResult[],
): Promise<void> {
  const tickets = targets.flatMap((target, index) => {
    const id = results[index]?.ticketId
    return id ? [{ id, sessionId: target.sessionId, token: target.token }] : []
  })
  if (tickets.length === 0) return
  try {
    await db.insert(pushTickets).values(tickets).onConflictDoNothing()
  } catch {
    // The session was deleted while the push was on its way.
  }
}

/**
 * Expo has a receipt for most tickets within minutes, and promises one only
 * after half an hour. It keeps receipts for a day.
 */
export const RECEIPT_READY_MS = 30 * 60 * 1000
export const RECEIPT_KEPT_MS = 24 * 60 * 60 * 1000
/** The most ids Expo takes in one call. More is a 400. */
const RECEIPTS_PER_CALL = 1000
const RECEIPT_CALLS_PER_PASS = 5
const STALE_TICKET_BATCH = 5000

/**
 * Reads what became of earlier sends and clears the token of an app that
 * was uninstalled. APNs and FCM tell Expo only after the send was accepted,
 * so a dead token never shows up in the send itself. Nothing is retried on
 * a failed call. The tickets wait for the next pass, and age out after a
 * day if the receipts never come.
 */
export async function checkPushReceipts(
  db: Database,
  driver: PushDriver,
  options: { now?: Date; log?: Pick<FastifyBaseLogger, "error"> } = {},
): Promise<{ read: number; cleared: number }> {
  const outcome = { read: 0, cleared: 0 }
  if (!driver.readReceipts) return outcome
  const now = options.now ?? new Date()

  const expired = new Date(now.getTime() - RECEIPT_KEPT_MS)
  for (let batch = 0; batch < 20; batch += 1) {
    const dropped = await db
      .delete(pushTickets)
      .where(
        inArray(
          pushTickets.id,
          db
            .select({ id: pushTickets.id })
            .from(pushTickets)
            .where(lt(pushTickets.createdAt, expired))
            .limit(STALE_TICKET_BATCH),
        ),
      )
      .returning({ id: pushTickets.id })
    if (dropped.length < STALE_TICKET_BATCH) break
  }

  const ready = new Date(now.getTime() - RECEIPT_READY_MS)
  for (let call = 0; call < RECEIPT_CALLS_PER_PASS; call += 1) {
    const due = await db
      .select()
      .from(pushTickets)
      .where(lte(pushTickets.createdAt, ready))
      .orderBy(pushTickets.createdAt, pushTickets.id)
      .limit(RECEIPTS_PER_CALL)
    if (due.length === 0) break

    let receipts: Record<string, PushReceipt> | null
    try {
      receipts = await driver.readReceipts(due.map((ticket) => ticket.id))
    } catch {
      receipts = null
    }
    if (!receipts) break

    const answered = due.filter((ticket) => receipts[ticket.id])
    const refused = answered.filter(
      (ticket) => receipts[ticket.id]!.error === "InvalidCredentials",
    ).length
    if (refused > 0) {
      options.log?.error(
        { provider: driver.provider, receipts: refused },
        "APNs or FCM refused this server's push credentials; check the keys of the Expo project the app was built with",
      )
    }
    for (const ticket of answered) {
      if (receipts[ticket.id]!.error !== "DeviceNotRegistered") continue
      // Only the token the push went to. The app may have registered a new
      // one on that session since, and that one is alive.
      const cleared = await db
        .update(sessions)
        .set({ pushToken: null, pushProvider: null })
        .where(and(eq(sessions.id, ticket.sessionId), eq(sessions.pushToken, ticket.token)))
        .returning({ id: sessions.id })
      outcome.cleared += cleared.length
    }
    if (answered.length > 0) {
      await db.delete(pushTickets).where(
        inArray(
          pushTickets.id,
          answered.map((ticket) => ticket.id),
        ),
      )
    }
    outcome.read += answered.length
    // The rest have no receipt yet, and asking again straight away gets the
    // same answer.
    if (answered.length < due.length) break
  }
  return outcome
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
