import type { SharingState, SosReason } from "@hearth/shared"
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, circles, sosAlerts, userPresence } from "../db/schema"
import { forbidden, tooManyRequests } from "../lib/errors"
import { sendControl } from "./control"
import { preciseSinceAfter, projectPresence, sharesPreciselySql } from "./presence"

export type SosAlertRow = typeof sosAlerts.$inferSelect

/**
 * The note an app from before `reason` puts on the SOS its crash prompt
 * raises when nobody answers. English is the only language those apps
 * shipped, so the note alone tells the crash alert from a press.
 */
export const LEGACY_INCIDENT_NOTE =
  "Possible collision detected automatically. No answer from the phone."

export function sosReason(body: { note?: string | null; reason?: SosReason } | null | undefined) {
  if (body?.reason) return body.reason
  return body?.note === LEGACY_INCIDENT_NOTE ? "incident" : "sos"
}

/**
 * How far ahead the server holds the raiser's phone on Live while an alert is
 * open. Every upload reply names the window again, so it only runs out on a
 * phone whose uploads have stopped getting through for longer than this, or
 * this long after the all clear. A viewer's ten minute watch would leave the
 * GPS running at full tilt well after the person said they were safe.
 */
export const SOS_LIVE_SECONDS = 2 * 60

/**
 * Fresh alarms per person in ten minutes. A press on an alert that is already
 * open raises nothing and is never counted, so this only meets somebody who
 * raised, resolved and raised again five times over, which is a game rather
 * than an emergency, and everyone in their circles has been woken for each.
 */
export const SOS_FRESH_RAISES = 5

export interface RaisedSos {
  /** One per circle it is open in, the requested circle first. */
  alerts: SosAlertRow[]
  created: SosAlertRow[]
  /** Open before this request, so their circles have been told already. */
  alreadyOpen: SosAlertRow[]
}

/** Postgres gave up on the transaction for a reason that trying again settles. */
function retryable(error: unknown): boolean {
  for (let cause = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const code = (cause as { code?: unknown }).code
    if (code === "40P01" || code === "40001") return true
  }
  return false
}

/**
 * Opens the raiser's alert in every circle the reason reaches, or finds it
 * already open there. The member rows are locked first, so two presses racing
 * from the same person, a double tap or the phone and the tablet, queue behind
 * one another and the second finds what the first opened. Without the lock
 * both find nothing open, and every circle is woken twice for one emergency.
 *
 * Other writes take several of a member's rows in whatever order the scan
 * finds them, so Postgres can end up breaking a deadlock by failing this
 * side. An SOS that answered 500 for that would be the worst way to lose one,
 * so the transaction is tried again.
 */
export async function openSosAlerts(
  db: Database,
  input: { userId: string; circleId: string; note: string | null; reason: SosReason },
): Promise<RaisedSos> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await raiseOnce(db, input)
    } catch (error) {
      if (attempt >= 3 || !retryable(error)) throw error
    }
  }
}

function raiseOnce(
  db: Database,
  input: { userId: string; circleId: string; note: string | null; reason: SosReason },
): Promise<RaisedSos> {
  return db.transaction(async (tx) => {
    const memberships = await tx
      .select({ circleId: circleMembers.circleId, settings: circles.settings })
      .from(circleMembers)
      .innerJoin(circles, eq(circles.id, circleMembers.circleId))
      .where(eq(circleMembers.userId, input.userId))
      .orderBy(asc(circleMembers.circleId))
      .for("update", { of: circleMembers })

    const targets = memberships
      .filter(
        (row) =>
          input.reason === "sos" ||
          row.circleId === input.circleId ||
          row.settings.incidentDetection,
      )
      .map((row) => row.circleId)
    if (!targets.includes(input.circleId)) throw forbidden("You are not a member of this circle.")

    const open = await tx
      .select()
      .from(sosAlerts)
      .where(
        and(
          eq(sosAlerts.userId, input.userId),
          isNull(sosAlerts.resolvedAt),
          inArray(sosAlerts.circleId, targets),
        ),
      )
    const openByCircle = new Map(open.map((row) => [row.circleId, row]))
    const missing = targets.filter((circleId) => !openByCircle.has(circleId))

    let created: SosAlertRow[] = []
    if (missing.length > 0) {
      // Alerts raised together share the transaction's now(), so this counts
      // raises rather than circles.
      const [recent] = await tx
        .select({ raises: sql<number>`count(distinct ${sosAlerts.startedAt})::int` })
        .from(sosAlerts)
        .where(
          and(
            eq(sosAlerts.userId, input.userId),
            gt(sosAlerts.startedAt, sql`now() - interval '10 minutes'`),
          ),
        )
      if ((recent?.raises ?? 0) >= SOS_FRESH_RAISES) {
        throw tooManyRequests("Too many alerts raised in the last ten minutes.")
      }
      created = await tx
        .insert(sosAlerts)
        .values(missing.map((circleId) => ({ circleId, userId: input.userId, note: input.note })))
        .returning()
    }

    // An emergency is not the moment to respect ghost mode, in any circle it
    // reaches, and a press on an open alert is the person asking again.
    // resume_to_state goes with the pause it belonged to. Left behind, the next
    // pause coalesces onto it, and one raised during an approximate pause would
    // make an unrelated pause weeks later resume to approximate rather than to
    // the precise state this sets.
    await tx
      .update(circleMembers)
      .set({
        sharingState: "precise",
        preciseSince: preciseSinceAfter("precise"),
        pausedUntil: null,
        resumeToState: null,
      })
      .where(and(eq(circleMembers.userId, input.userId), inArray(circleMembers.circleId, targets)))

    const byCircle = new Map([
      ...openByCircle,
      ...created.map((row) => [row.circleId, row] as const),
    ])
    const alerts = [
      input.circleId,
      ...targets.filter((circleId) => circleId !== input.circleId),
    ].map((circleId) => byCircle.get(circleId)!)
    return { alerts, created, alreadyOpen: [...openByCircle.values()] }
  })
}

/**
 * Which of one person's alerts each member hears about, so somebody who shares
 * several circles with them is told once. The earliest alert wins, then the
 * lowest circle id. The alarm and the all clear both pick by this rule, so the
 * all clear names the alert the alarm named, and a phone that replaces one
 * card with the other does.
 */
export function assignRecipients(
  alerts: Array<Pick<SosAlertRow, "id" | "circleId" | "startedAt">>,
  members: Array<{ circleId: string; userId: string }>,
  skip: ReadonlySet<string>,
): Map<string, string[]> {
  const order = [...alerts].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.circleId < b.circleId ? -1 : 1),
  )
  const assigned = new Map<string, string[]>(alerts.map((alert) => [alert.id, []]))
  const told = new Set(skip)
  for (const alert of order) {
    for (const member of members) {
      if (member.circleId !== alert.circleId || told.has(member.userId)) continue
      told.add(member.userId)
      assigned.get(alert.id)!.push(member.userId)
    }
  }
  return assigned
}

/**
 * Until when the phone should be on Live. That is the window a family
 * member's watch holds, or a short one while the person has an alert open in
 * a circle they still share precisely with, whichever ends later. Read, never
 * written, so an SOS never moves the window a watch is measured against. A
 * circle they have turned down or left would throw the live fixes away.
 */
export async function liveUntil(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<Date | null> {
  const [row] = await db
    .select({
      watchedUntil: userPresence.watchedUntil,
      sos: sql<boolean>`exists (
        select 1 from ${sosAlerts}
        where ${sosAlerts.userId} = ${userPresence.userId}
          and ${sosAlerts.resolvedAt} is null
          and ${sharesPreciselySql(sosAlerts.circleId, sosAlerts.userId)}
      )`,
    })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)
  const watched =
    row?.watchedUntil && row.watchedUntil.getTime() > now.getTime() ? row.watchedUntil : null
  const sos = row?.sos ? new Date(now.getTime() + SOS_LIVE_SECONDS * 1000) : null
  if (!watched) return sos
  if (!sos) return watched
  return watched.getTime() > sos.getTime() ? watched : sos
}

/**
 * Puts the raiser's phone on Live now rather than at its next upload, which
 * on a phone lying still may be a quarter of an hour off. A phone with its
 * control channel open has the ask within a second. One without it is the
 * phone in the raiser's hand, and its next upload reply carries the window.
 */
export async function startSosLive(db: Database, userId: string, now = new Date()): Promise<void> {
  const until = await liveUntil(db, userId, now)
  if (!until) return
  const seconds = Math.ceil((until.getTime() - now.getTime()) / 1000)
  await sendControl(db, userId, { command: "watch", seconds }, now)
}

/**
 * Where a viewer may see the raiser of an alert, by the projection the map
 * uses, the phone's own sharing switch and the circle's pause setting
 * included. Raising an alert un-pauses the raiser by writing their sharing
 * state, so reading user_presence raw would be a bypass on top of that, and
 * the alert would go on serving a position the map has stopped showing.
 * Nothing once the alert is resolved, or once they have left the circle.
 */
export function alertPosition(
  input: {
    alert: Pick<SosAlertRow, "id" | "userId" | "resolvedAt">
    member: {
      sharingState: SharingState
      pausedUntil: Date | null
      resumeToState: SharingState | null
    } | null
    presence: typeof userPresence.$inferSelect | null
    allowSharingPause: boolean | undefined
  },
  viewerId: string,
  now = new Date(),
): { lat: number | null; lon: number | null; recordedAt: string | null } | null {
  if (!input.member || input.alert.resolvedAt) return null
  const presence = input.presence
  return projectPresence(
    {
      userId: input.alert.userId,
      sharingState: input.member.sharingState,
      pausedUntil: input.member.pausedUntil,
      resumeToState: input.member.resumeToState,
      allowSharingPause: input.allowSharingPause,
      lat: presence?.lat ?? null,
      lon: presence?.lon ?? null,
      accuracyMeters: presence?.accuracyMeters ?? null,
      recordedAt: presence?.recordedAt ?? null,
      batteryLevel: presence?.batteryLevel ?? null,
      isCharging: presence?.isCharging ?? null,
      activity: presence?.activity ?? null,
      speedMps: presence?.speedMps ?? null,
      headingDegrees: presence?.headingDegrees ?? null,
      health: presence?.health ?? null,
    },
    viewerId,
    { atPlace: null, sosAlertId: input.alert.id, now },
  )
}
