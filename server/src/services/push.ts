import type postgres from "postgres"
import { MUTABLE_EVENT_TYPES, type PushProvider } from "@hearth/shared"
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"

import type { Database } from "../db/client"
import {
  circleMembers,
  notificationOutbox,
  sessions,
  sosAlerts,
  type OutboxRow,
} from "../db/schema"
import { ALREADY_SHOWN, composeCard, type PushGroup } from "./notification-groups"
import { placeNewsNoLongerShared, rowsForFormerMembers } from "./outbox-visibility"
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

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
    }
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`

    const ttl = silentTtlSeconds(message.data)
    const queuedAt = Math.floor((message.queuedAt?.getTime() ?? Date.now()) / 1000)
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
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
              sound: message.channel === "sos" ? "default" : null,
              // Without this iOS files an SOS as an ordinary alert, so Focus or Do
              // Not Disturb silences the one notification that must not be
              // silenced. Android's equivalent is the channel's bypassDnd.
              interruptionLevel: message.channel === "sos" ? "time-sensitive" : undefined,
              priority: message.priority === "high" ? "high" : "default",
              channelId: message.channel ?? "default",
              // So an SOS is still shown when the recipient already has the app open.
              _displayInForeground: message.channel === "sos",
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
      return { ok: false, error: `ntfy http ${response.status}: ${await safeText(response)}` }
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
): Promise<string[]> {
  const rows = await db
    .select({ userId: circleMembers.userId, notifications: circleMembers.notifications })
    .from(circleMembers)
    .where(eq(circleMembers.circleId, circleId))

  const now = Date.now()
  const silenceable = (MUTABLE_EVENT_TYPES as readonly string[]).includes(eventType)

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
      return !prefs.muted.includes(eventType as never)
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

export async function drainOutbox(
  db: Database,
  driver: PushDriver,
  options: { batchSize?: number; concurrency?: number; now?: Date; sendTimeoutMs?: number } = {},
): Promise<DrainSummary> {
  const batchSize = options.batchSize ?? 50
  const concurrency = options.concurrency ?? DEFAULT_SEND_CONCURRENCY
  const now = options.now ?? new Date()
  const summary: DrainSummary = { processed: 0, sent: 0, failed: 0, skipped: 0, waiting: false }

  const allClaimed = await claimDue(db, batchSize, now)
  if (allClaimed.length === 0) return summary

  const members = await dropRowsForFormerMembers(db, allClaimed, now, summary)
  const shared = await dropPlaceNewsNoLongerShared(db, members, now, summary)
  const claimed = await dropSosAlreadyResolved(db, shared, now, summary)
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
      summary.failed += lane.length
      return
    }

    const message: PushMessage = {
      userId: head.userId,
      circleId: head.circleId,
      title: head.title,
      body: head.body,
      data: head.data,
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
        data: newest.data,
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
      await settle(carried, {
        status: "sent",
        sentAt: now,
        attempts: sql`${notificationOutbox.attempts} + 1`,
        groupThread,
      })
      summary.sent += carried.length
      return
    }

    const lastError = results.find((result) => result.error)?.error ?? "delivery failed"
    for (const row of carried) {
      const attempts = row.attempts + 1
      const delaySeconds = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] ?? 3600
      const retryAt = Date.now() + delaySeconds * 1000
      const exhausted = attempts >= MAX_ATTEMPTS || (row.silent && retryAt >= expiresAt)
      await settle([row], {
        status: exhausted ? "failed" : "pending",
        attempts,
        lastError,
        nextAttemptAt: new Date(retryAt),
      })
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
      .orderBy(
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
  return claimed.sort(
    (a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.id - b.id,
  )
}

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
      () => resolve({ ok: false, error: `no answer from the push provider in ${ms / 1000} s` }),
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
 * An SOS still queued once it was resolved, typically a retry after a
 * provider outage. Sent now it would sound the alarm for something that is
 * over, and on a phone that replaces by key it would cover the all clear.
 */
async function dropSosAlreadyResolved(
  db: Database,
  claimed: OutboxRow[],
  now: Date,
  summary: DrainSummary,
): Promise<OutboxRow[]> {
  const raised = claimed.filter((row) => row.data.type === "sos_started" && isSos(row))
  if (raised.length === 0) return claimed

  const resolved = await db
    .select({ id: sosAlerts.id })
    .from(sosAlerts)
    .where(
      and(
        inArray(sosAlerts.id, [...new Set(raised.map((row) => String(row.data.alertId)))]),
        isNotNull(sosAlerts.resolvedAt),
      ),
    )
  const over = new Set(resolved.map((row) => row.id))
  const stale = raised.filter((row) => over.has(String(row.data.alertId)))
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
