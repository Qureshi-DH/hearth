import { translate } from "@/i18n/translate"

// The server takes fixes stamped up to five minutes ahead of its own clock, so
// a past moment can arrive looking that far into the future.
const CLOCK_SKEW_MS = 5 * 60_000

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return translate("common:never")
  const ahead = Date.parse(iso) - now
  if (ahead > CLOCK_SKEW_MS) return timeUntil(ahead)
  const delta = Math.max(0, -ahead)
  const seconds = Math.round(delta / 1000)
  if (seconds < 45) return translate("common:justNow")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return translate("time:minutesAgo", { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return translate("time:hoursAgo", { count: hours })
  const days = Math.round(hours / 24)
  return translate("time:daysAgo", { count: days })
}

function timeUntil(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return translate("time:inMinutes", { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return translate("time:inHours", { count: hours })
  return translate("time:inDays", { count: Math.round(hours / 24) })
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startOfToday - startOfThat) / 86_400_000)
  if (diffDays === 0) return translate("activity:today")
  if (diffDays === 1) return translate("activity:yesterday")
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** "3:15 PM" today, "Yesterday 3:15 PM" before that: when somebody arrived. */
export function sinceTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? formatClock(iso) : `${dayLabel(iso, now)} ${formatClock(iso)}`
}

export function formatWhen(iso: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${formatClock(iso)}`
}
