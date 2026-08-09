import { useEffect, useReducer } from "react"
import type { MemberPresence } from "@hearth/shared"

/**
 * A phone on the live tier reports every five seconds, so a fix older than
 * this is not what they are doing now, whatever the fifteen-minute stale
 * rule says about the map.
 */
export const LIVE_FRESH_MS = 30_000
/**
 * A watch reaches the phone through the next upload reply or a silent push;
 * a moving phone uploads within a minute. Two of those without a word and
 * the phone is not going to answer this ask.
 */
export const LIVE_UNANSWERED_MS = 120_000
const TICK_MS = 5_000

export type Liveness = "asking" | "live" | "unanswered" | "ended"

type Entry = Pick<MemberPresence, "recordedAt"> | null | undefined

/**
 * What the Live page may honestly claim about a phone. `askedAt` is when
 * the viewer last asked for live updates, not counting the holds that keep
 * a window open, and `until` is when the granted window lapses, null while
 * the server has not answered. A fix counts as an answer only when it was
 * recorded after the ask: the one already on the map at open is what made
 * the viewer look, not a reply.
 */
export function judgeLiveness(
  entry: Entry,
  askedAt: number | null,
  until: number | null,
  now: number,
): Liveness {
  const { answered, asked } = answerOf(entry?.recordedAt, askedAt, now)
  if (answered != null && now - answered <= LIVE_FRESH_MS) return "live"
  if (until != null && now > until) return "ended"
  if (now - (answered ?? asked) > LIVE_UNANSWERED_MS) return "unanswered"
  return "asking"
}

function answerOf(recordedAt: string | null | undefined, askedAt: number | null, now: number) {
  const asked = askedAt ?? now
  const recorded = recordedAt ? Date.parse(recordedAt) : null
  return { asked, answered: recorded != null && recorded > asked ? recorded : null }
}

/** The moments after `now` at which the verdict can change on the clock alone. */
export function changesAhead(
  recordedAt: string | null | undefined,
  askedAt: number | null,
  until: number | null,
  now: number,
): number[] {
  const { answered, asked } = answerOf(recordedAt, askedAt, now)
  return [
    answered != null ? answered + LIVE_FRESH_MS : null,
    (answered ?? asked) + LIVE_UNANSWERED_MS,
    until,
  ]
    .filter((moment): moment is number => moment != null && moment > now)
    .sort((a, b) => a - b)
}

export function useLiveness(
  entry: Entry,
  askedAt: number | null,
  until: number | null = null,
): Liveness {
  const recordedAt = entry?.recordedAt ?? null
  const [, wake] = useReducer((count: number) => count + 1, 0)
  // The verdict changes with the clock as much as with the data, so the page
  // is woken to reconsider: at the exact moments it would flip, so "live"
  // does not linger past thirty seconds, and every few seconds in between
  // so "last seen" keeps counting.
  useEffect(() => {
    const start = Date.now()
    const tick = setInterval(wake, TICK_MS)
    const flips = changesAhead(recordedAt, askedAt, until, start).map((moment) =>
      setTimeout(wake, moment - start + 1),
    )
    return () => {
      clearInterval(tick)
      flips.forEach((flip) => clearTimeout(flip))
    }
  }, [recordedAt, askedAt, until])
  return judgeLiveness(entry, askedAt, until, Date.now())
}
