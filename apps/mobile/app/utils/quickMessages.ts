import {
  DEFAULTS,
  QUICK_MESSAGES,
  plausibleActivity,
  type MemberPresence,
  type QuickMessageKey,
} from "@hearth/shared"

import { ApiError } from "@/services/api"

type QuickMessage = (typeof QUICK_MESSAGES)[number]

type Situation = Pick<
  MemberPresence,
  "batteryLevel" | "isCharging" | "activity" | "speedMps" | "stale" | "issues"
>

/**
 * Every quick message, with the ones that fit what the other phone last said
 * about itself first. Somebody looking at a phone on 9% wants "charge your
 * phone" at the top of the list rather than under "drive safe". Nothing is
 * taken away, since the phone's word may be minutes old and the sender knows
 * more than it does. The battery line is the circle's own, the one its low
 * battery alert fires at.
 */
export function quickMessagesFor(
  situation: Situation | null | undefined,
  lowBatteryThreshold: number = DEFAULTS.lowBatteryThreshold,
): readonly QuickMessage[] {
  const first: QuickMessageKey[] = []
  if (situation) {
    const battery = situation.batteryLevel
    if (battery != null && battery <= lowBatteryThreshold && !situation.isCharging) {
      first.push("charge_phone")
    }
    if (situation.stale || (situation.issues?.length ?? 0) > 0) {
      first.push("open_hearth", "where_are_you", "call_me")
    } else if (plausibleActivity(situation.activity, situation.speedMps) === "driving") {
      first.push("slow_down", "drive_safe")
    }
  }
  const rank = (key: QuickMessageKey) => {
    const index = first.indexOf(key)
    return index === -1 ? first.length + QUICK_MESSAGES.findIndex((q) => q.key === key) : index
  }
  return [...QUICK_MESSAGES].sort((a, b) => rank(a.key) - rank(b.key))
}

/**
 * Sends a quick message by its key. The store app updates before a family's
 * own server does, and a server from before the message existed refuses a key
 * it has never heard of, so the same words then go as the message's text,
 * which every version takes. The feed and the notification read the same.
 */
export async function sendQuickMessage(
  send: (message: { quickKey?: QuickMessageKey; body?: string }) => Promise<unknown>,
  quick: QuickMessage,
): Promise<void> {
  try {
    await send({ quickKey: quick.key })
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "validation_error") throw error
    await send({ body: quick.body })
  }
}
