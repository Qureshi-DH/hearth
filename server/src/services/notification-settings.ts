import type { NotificationSettings, QuietHours } from "@hearth/shared"
import { eq } from "drizzle-orm"

import type { Database } from "../db/client"
import { users } from "../db/schema"
import { knownTimeZone } from "./place-news"

export const NO_SETTINGS: NotificationSettings = {
  timeZone: null,
  clock: null,
  quietHours: null,
  mutedPeople: [],
}

export interface SettingsPatch {
  timeZone?: string | null
  clock?: NotificationSettings["clock"]
  quietHours?: QuietHours | null
  mutedPeople?: string[]
}

/**
 * Merges what a phone sent into what is stored. A time zone this server's
 * clock library does not know is kept as it was rather than refused, since
 * the phone has no other answer to give and a refusal would be a 4xx in
 * ordinary use.
 */
export async function updateNotificationSettings(
  db: Database,
  userId: string,
  patch: SettingsPatch,
): Promise<NotificationSettings> {
  const [row] = await db
    .select({ settings: users.notificationSettings })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const current = { ...NO_SETTINGS, ...(row?.settings ?? {}) }
  let timeZone = current.timeZone
  if (patch.timeZone === null) timeZone = null
  else if (patch.timeZone !== undefined) timeZone = knownTimeZone(patch.timeZone) ?? timeZone
  const next: NotificationSettings = {
    timeZone,
    clock: patch.clock === undefined ? current.clock : patch.clock,
    quietHours: patch.quietHours === undefined ? current.quietHours : patch.quietHours,
    mutedPeople:
      patch.mutedPeople === undefined
        ? current.mutedPeople
        : [...new Set(patch.mutedPeople.filter((id) => id !== userId))],
  }
  await db
    .update(users)
    .set({ notificationSettings: next, updatedAt: new Date() })
    .where(eq(users.id, userId))
  return next
}

const minutesOf = (clock: string) => {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number)
  return hours * 60 + minutes
}

/**
 * When the recipient's quiet hours end, if they are in them now. Read on the
 * phone's own clock, so 22:00 means ten at night where the phone is. A phone
 * that never said where it is is read in UTC.
 */
export function quietHoursEnd(settings: NotificationSettings, now: Date): Date | null {
  const quiet = settings.quietHours
  if (!quiet) return null
  const from = minutesOf(quiet.from)
  const until = minutesOf(quiet.until)
  if (from === until) return null

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: knownTimeZone(settings.timeZone) ?? "UTC",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  const local = part("hour") * 60 + part("minute")

  const inside = from < until ? local >= from && local < until : local >= from || local < until
  if (!inside) return null
  const minutesLeft = (until - local + 24 * 60) % (24 * 60)
  const startOfMinute = now.getTime() - (now.getTime() % 60_000)
  return new Date(startOfMinute + minutesLeft * 60_000)
}

/**
 * What quiet hours never hold. The safety alerts, and the test somebody
 * pressed a button for and is waiting to see.
 */
const ALWAYS_THROUGH = new Set(["sos_started", "sos_resolved", "possible_incident", "test"])

/** Whether quiet hours may hold or drop news of this kind. */
export const quietHoursApply = (type: unknown): boolean =>
  typeof type === "string" && !ALWAYS_THROUGH.has(type)
