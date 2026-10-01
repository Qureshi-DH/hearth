import type { AdminPhone, AdminPhoneState } from "@hearth/shared"

import { plural } from "./format"

/** Worst first, so the phone that needs a hand is at the top. */
const STATE_ORDER: AdminPhoneState[] = ["offline", "never", "quiet", "parked", "reporting", "none"]

export function sortPhones(phones: readonly AdminPhone[]): AdminPhone[] {
  return [...phones].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      Number(b.issues.length > 0) - Number(a.issues.length > 0) ||
      a.displayName.localeCompare(b.displayName),
  )
}

interface PhonesSummary {
  /** Quiet and parked phones count, since neither has been silent long enough to tell the family. */
  heard: number
  /** Leaves out accounts only ever used in a browser. */
  total: number
  tally: Record<AdminPhoneState, number>
  foot: string
  tone: "good" | "warning" | "danger"
}

export function phonesSummary(phones: readonly AdminPhone[]): PhonesSummary {
  const tally: Record<AdminPhoneState, number> = {
    reporting: 0,
    quiet: 0,
    parked: 0,
    offline: 0,
    never: 0,
    none: 0,
  }
  for (const phone of phones) tally[phone.state] += 1
  const heard = tally.reporting + tally.quiet + tally.parked
  const total = phones.length - tally.none
  const withIssues = phones.filter((phone) => phone.issues.length > 0).length

  const summary = (foot: string, tone: PhonesSummary["tone"]) => ({
    heard,
    total,
    tally,
    foot,
    tone,
  })
  if (tally.offline > 0) return summary(`${tally.offline} stopped reporting`, "danger")
  if (withIssues > 0) {
    return summary(`${plural(withIssues, "phone has", "phones have")} a setting off`, "warning")
  }
  if (tally.never > 0) return summary(`${tally.never} never reported`, "warning")
  if (total === 0) return summary("No phones signed in yet", "warning")
  return summary("All phones are reporting", "good")
}

/**
 * A failed request with an older answer still in hand counts as ready: the
 * numbers stay up, and the header says they are not updating.
 */
export type Status = "loading" | "failed" | "ready"

export function statusOf(...queries: Array<{ data: unknown; isError: boolean }>): Status {
  if (queries.every((query) => query.data !== undefined)) return "ready"
  if (queries.some((query) => query.data === undefined && query.isError)) return "failed"
  return "loading"
}

export function changeOnYesterday(
  today: number,
  yesterday: number,
): { text: string; tone: "up" | "down" | "flat" } {
  if (yesterday === 0) return { text: "None yesterday", tone: "flat" }
  const change = Math.round(((today - yesterday) / yesterday) * 100)
  if (change === 0) return { text: "Same as yesterday", tone: "flat" }
  return change > 0
    ? { text: `${change}% more than yesterday`, tone: "up" }
    : { text: `${-change}% fewer than yesterday`, tone: "down" }
}
