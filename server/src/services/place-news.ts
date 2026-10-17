import { formatDistance, type NotificationSettings } from "@hearth/shared"

/**
 * News of where somebody went is only worth a buzz while it is still news.
 * Doze, a tunnel or a flat cell can hold an upload back for half an hour and
 * "they got to school" is still worth hearing then. Older, it is history,
 * which belongs in the feed. Arrivals, departures and trips share the limit,
 * so a late upload cannot push one of them and not the others.
 */
export const PLACE_NEWS_CATCH_UP_MS = 30 * 60 * 1000

/** Later than this and the words say when it happened, since the buzz no longer does. */
export const LATE_AFTER_MS = 2 * 60 * 1000

/** How the person a notification goes to reads distances and times. */
export interface Reader {
  units: "metric" | "imperial"
  timeZone: string | null
  clock: NotificationSettings["clock"]
}

export const DEFAULT_READER: Reader = { units: "metric", timeZone: null, clock: null }

export interface Journey {
  /** The place the person set out from, in the circle being told. */
  from: string | null
  meters: number
  /** Null when the fixes cannot say when they set off. */
  seconds: number | null
}

/**
 * What place news is worded from. It rides on the outbox row, so the drain
 * can word it for the person it is going to at the moment it goes, in their
 * units and on their clock, and say when it happened if it has been held.
 */
export interface Wording {
  who: string
  kind: "arrive" | "leave" | "stop"
  /** The place arrived at or left. Null for a stop. */
  place: string | null
  journey: Journey | null
  /** When it happened, ISO. */
  at: string
  /** ISO. A notification sent after this says when it happened. */
  lateAfter: string
}

/** The standalone body and the line a person's card shows. */
export function wordPlaceNews(
  wording: Wording,
  reader: Reader = DEFAULT_READER,
  now: Date = new Date(),
): { body: string; line: string } {
  const when = now.getTime() > Date.parse(wording.lateAfter) ? happened(wording, reader, now) : ""
  const journey = wording.journey
  let line: string
  if (wording.kind === "arrive") {
    const route =
      journey?.from != null
        ? `, ${formatDistance(journey.meters, reader.units)} from ${journey.from}${
            journey.seconds != null ? ` in ${duration(journey.seconds)}` : ""
          }`
        : ""
    line = `Arrived at ${wording.place}${when}${route}`
  } else if (wording.kind === "leave") {
    line = `Left ${wording.place}${when}`
  } else {
    const distance = formatDistance(journey?.meters ?? 0, reader.units)
    line = journey?.from
      ? `Stopped ${distance} from ${journey.from}${when}`
      : `Stopped after ${distance}${when}`
  }
  return { body: `${wording.who} ${line.charAt(0).toLowerCase()}${line.slice(1)}`, line }
}

/**
 * " at 8:31" on the reader's clock. A phone that never said which time zone
 * it is in gets how long ago instead, which is right whatever the zone.
 */
function happened(wording: Wording, reader: Reader, now: Date): string {
  const at = new Date(wording.at)
  if (reader.timeZone) {
    try {
      return ` at ${clockTime(at, reader.timeZone, reader.clock)}`
    } catch {
      // A zone this server's ICU does not know. How long ago still holds.
    }
  }
  return ` ${duration((now.getTime() - at.getTime()) / 1000)} ago`
}

export function clockTime(at: Date, timeZone: string, clock: Reader["clock"]): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: clock === "12h" ? "h12" : "h23",
  }).formatToParts(at)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ""
  const time = `${Number(part("hour"))}:${part("minute")}`
  return clock === "12h" ? `${time} ${part("dayPeriod")}` : time
}

export function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
}

/** The time zone a phone reported, if this server can read it. */
export function knownTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return null
  }
}
