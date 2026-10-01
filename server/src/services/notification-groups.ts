import { createHash } from "node:crypto"

import { and, desc, eq, isNotNull, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { notificationOutbox, type OutboxRow } from "../db/schema"
import { PLACE_NEWS, placeNewsNoLongerShared, rowsForFormerMembers } from "./outbox-visibility"

/**
 * News about one person joins the notification already showing about them,
 * the way a family follows somebody's afternoon: one card for Mum that grows
 * as she leaves home, gets to the shop and comes back, instead of a new buzz
 * and a new card for every fence she crosses. The phone does the replacing,
 * keyed on what the server sends, so every decision is made here.
 */
export interface PushGroup {
  key: string
  /** The card's title, the same for every line in it. */
  title: string
  /** This piece of news as one line of the card. */
  line: string
}

/**
 * Two hours without news ends a thread, so the next one opens a fresh card.
 * A card the family swiped away an afternoon ago should not come back with
 * the whole afternoon in it.
 */
export const THREAD_GAP_MS = 2 * 60 * 60 * 1000

/** Lines a card shows before it starts counting the older ones instead. */
export const THREAD_LINES = 5

/**
 * The same line again this soon, from another circle, is the same news
 * reaching the recipient through a second circle they share with the person.
 */
export const SAME_NEWS_MS = 10 * 60 * 1000

/** Where somebody went: places, trips and check-ins. */
export const outingGroup = (userId: string, name: string, line: string): PushGroup => ({
  key: `outing:${userId}`,
  title: name,
  line,
})

/** What somebody sent: quick messages and location requests. */
export const messagesGroup = (userId: string, name: string, line: string): PushGroup => ({
  key: `messages:${userId}`,
  title: name,
  line,
})

/** How somebody's phone is doing: battery and silence. */
export const phoneGroup = (userId: string, name: string, line: string): PushGroup => ({
  key: `phone:${userId}`,
  title: `${name}'s phone`,
  line,
})

/** How much of an older line a card keeps. */
const OLDER_LINE_CHARS = 100

/** Longer than the longest quick message or note, so the newest line reads whole. */
const NEWEST_LINE_CHARS = 600

/**
 * What the body may weigh. Expo turns away a push over 4096 bytes, title and
 * data included, and a message or a note in a script that takes three bytes a
 * letter fills that quickly.
 */
const BODY_BYTES = 3000

/** Newest first, so the line a collapsed card shows is the news. */
export function threadBody(lines: string[]): string {
  const [newest = "", ...older] = lines
  const shown = [
    clip(newest, NEWEST_LINE_CHARS),
    ...older.slice(0, THREAD_LINES - 1).map((line) => clip(line, OLDER_LINE_CHARS)),
  ]
  let hidden = lines.length - shown.length
  const render = () => (hidden > 0 ? [...shown, `and ${hidden} earlier`] : shown).join("\n")
  while (shown.length > 1 && Buffer.byteLength(render()) > BODY_BYTES) {
    shown.pop()
    hidden += 1
  }
  return render()
}

function clip(line: string, most: number): string {
  const letters = Array.from(line)
  return letters.length <= most ? line : `${letters.slice(0, most - 1).join("")}…`
}

/**
 * The key the phone replaces a card by. APNs takes 64 bytes of collapse id,
 * which a person's id and a thread fit, but a longer key is hashed rather
 * than cut, since two cut keys could meet.
 */
export function replaceKey(groupKey: string, thread: number): string {
  const key = `${groupKey}#${thread}`
  if (Buffer.byteLength(key) <= 64) return key
  return createHash("sha256").update(key).digest("base64url")
}

/**
 * Why a row was not sent, as the administrator reads it in the queue: the
 * card already says this, heard through another circle.
 */
export const ALREADY_SHOWN = "already in the notification about them"

/**
 * Enough earlier rows to fill a card and count the rest. A thread longer
 * than this is a whole day of somebody moving, and the count is still right
 * to within what anyone would read.
 */
const THREAD_ROWS = 100

/**
 * Place news, and a check-in too. A check-in already on its way is still
 * delivered, since somebody pressed a button to share it, but the feed shows
 * its place only while they share precisely, and a rebuilt card follows the
 * feed.
 */
const THREAD_PLACE_NEWS = new Set([...PLACE_NEWS, "check_in"])

export interface Card {
  title: string
  body: string
  replaceKey: string
  /** The id of the row that opened the thread. */
  thread: number
  /** The rows the card carries. They are sent, or retried, together. */
  rows: OutboxRow[]
}

/**
 * The card for one person's news to one recipient, built from every row of
 * theirs that is due, so a backlog lands as one buzz rather than one per
 * line. It continues the recipient's latest card under the same key while
 * news keeps coming, and opens a new one after a quiet spell.
 *
 * Earlier lines go through the same checks as a new row, so none come from a
 * circle the recipient has left, and no place news from a circle the person
 * stopped sharing precisely with. A row that repeats the line before it from
 * another circle is the same news told twice. It comes back as an echo, and
 * the card is null when that is all there was.
 */
export async function composeCard(
  db: Database,
  rows: OutboxRow[],
  now: Date,
): Promise<{ card: Card | null; echoes: OutboxRow[] }> {
  const head = rows.at(-1)!
  const groupKey = head.groupKey!
  const [latest] = await db
    .select({
      thread: notificationOutbox.groupThread,
      line: notificationOutbox.groupLine,
      circleId: notificationOutbox.circleId,
      sentAt: notificationOutbox.sentAt,
    })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.userId, head.userId),
        eq(notificationOutbox.groupKey, groupKey),
        eq(notificationOutbox.status, "sent"),
        isNotNull(notificationOutbox.groupThread),
      ),
    )
    // A card's rows share one sent time, and the newest of them is its top line.
    .orderBy(desc(notificationOutbox.sentAt), desc(notificationOutbox.id))
    .limit(1)

  const quietFor = latest?.sentAt ? now.getTime() - latest.sentAt.getTime() : Infinity
  const continuing = latest?.thread != null && quietFor < THREAD_GAP_MS ? latest : null

  const fresh: OutboxRow[] = []
  const echoes: OutboxRow[] = []
  let before = continuing
    ? { line: continuing.line, circleId: continuing.circleId, apartMs: quietFor }
    : null
  for (const row of rows) {
    const echo =
      before &&
      before.line === row.groupLine &&
      before.circleId !== row.circleId &&
      before.apartMs < SAME_NEWS_MS
    if (echo) {
      echoes.push(row)
      continue
    }
    fresh.push(row)
    before = { line: row.groupLine, circleId: row.circleId, apartMs: 0 }
  }
  if (fresh.length === 0) return { card: null, echoes }

  const thread = continuing?.thread ?? fresh[0]!.id
  const earlier = continuing ? await earlierLines(db, head.userId, groupKey, thread, now) : []
  const lines = [...earlier, ...fresh.map((row) => ({ id: row.id, line: row.groupLine ?? "" }))]
    .sort((a, b) => b.id - a.id)
    .map((entry) => entry.line)
  const newest = fresh.at(-1)!
  return {
    card: {
      title: newest.groupTitle ?? newest.title,
      body: threadBody(lines),
      replaceKey: replaceKey(groupKey, thread),
      thread,
      rows: fresh,
    },
    echoes,
  }
}

async function earlierLines(
  db: Database,
  userId: string,
  groupKey: string,
  thread: number,
  now: Date,
): Promise<Array<{ id: number; line: string }>> {
  const rows = await db
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      circleId: notificationOutbox.circleId,
      data: notificationOutbox.data,
      line: notificationOutbox.groupLine,
    })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.userId, userId),
        eq(notificationOutbox.groupKey, groupKey),
        eq(notificationOutbox.groupThread, thread),
        eq(notificationOutbox.status, "sent"),
      ),
    )
    .orderBy(desc(notificationOutbox.id))
    .limit(THREAD_ROWS)

  const hidden = new Set([
    ...(await rowsForFormerMembers(db, rows)),
    ...(await placeNewsNoLongerShared(db, rows, now, THREAD_PLACE_NEWS)),
  ])
  return rows.flatMap((row) =>
    row.line && !hidden.has(row.id) ? [{ id: row.id, line: row.line }] : [],
  )
}

/** The fence can notice an arrival a fix or two after the trip's last moving one. */
const ARRIVAL_AFTER_TRIP_MS = 10 * 60 * 1000

/**
 * Finishes the line of an arrival already queued for each recipient, and
 * says whose it found. A trip is worked out minutes after the arrival it
 * ended in went out, and its distance belongs on that line rather than in a
 * second buzz. The phone shows it with the next news about the person.
 *
 * The arrival is the latest at the place that happened during the trip, by
 * when it happened rather than when it was queued, since one late upload can
 * queue an earlier visit to the same place alongside it. A copy that was
 * skipped counts as found, whatever the reason: one skipped as an echo was
 * shown through another circle, and every other reason would stop the trip
 * reaching this recipient too.
 */
export async function amendArrivalLine(
  db: Database,
  input: {
    userIds: string[]
    circleId: string
    groupKey: string
    placeId: string
    startedAt: Date
    endedAt: Date
    line: string
  },
): Promise<Set<string>> {
  if (input.userIds.length === 0) return new Set()
  const until = new Date(input.endedAt.getTime() + ARRIVAL_AFTER_TRIP_MS)
  const rows = (await db.execute(sql`
    update notification_outbox set group_line = ${input.line}
    where id in (
      select distinct on (user_id) id from notification_outbox
      where user_id in (${sql.join(
        input.userIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and circle_id = ${input.circleId}::uuid
        and group_key = ${input.groupKey}
        and data->>'type' = 'place_arrive'
        and data->>'placeId' = ${input.placeId}
        and (data->>'occurredAt')::timestamptz
          between ${input.startedAt.toISOString()}::timestamptz and ${until.toISOString()}::timestamptz
        and status <> 'failed'
      order by user_id, (data->>'occurredAt')::timestamptz desc
    )
    returning user_id
  `)) as unknown as Array<{ user_id: string }>
  return new Set(rows.map((row) => row.user_id))
}
