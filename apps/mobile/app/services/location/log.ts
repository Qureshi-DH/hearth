import { load, save } from "@/utils/storage"

/**
 * What the tracker did and why, kept on the phone. A family reports "the
 * notification stayed" or "it never noticed I left", and without this the
 * only answer was a guess. Newest last, survives a process kill, and the You
 * screen shows and shares it. A thousand lines because the evidence for a
 * phone that went quiet overnight is the twelve hours before somebody looked.
 */
const KEY = "hearth.tracklog.v1"
const CAP = 1000

export interface TrackerLogEntry {
  at: string
  what: string
  detail?: Record<string, unknown>
}

let entries: TrackerLogEntry[] | null = null

function all(): TrackerLogEntry[] {
  entries ??= load<TrackerLogEntry[]>(KEY) ?? []
  return entries
}

export function logTracker(what: string, detail?: Record<string, unknown>): void {
  const list = all()
  list.push({ at: new Date().toISOString(), what, ...(detail ? { detail } : {}) })
  if (list.length > CAP) list.splice(0, list.length - CAP)
  save(KEY, list)
}

export function readTrackerLog(): TrackerLogEntry[] {
  return [...all()]
}

export function clearTrackerLog(): void {
  entries = []
  save(KEY, entries)
}

/**
 * The tracker registers what a shared log should open with: its mode, anchor,
 * queue and service state. Registered rather than imported, since the tracker
 * imports this module and the header needs the tracker.
 */
let header: (() => string) | null = null

export function setTrackerLogHeader(provider: () => string): void {
  header = provider
}

/** One line per entry, for sharing, under a header saying what the tracker believes right now. */
export function formatTrackerLog(
  list: TrackerLogEntry[] = readTrackerLog(),
  head: string = header?.() ?? "",
): string {
  const lines = list.map((entry) => {
    const detail = entry.detail ? " " + JSON.stringify(entry.detail) : ""
    return `${entry.at} ${entry.what}${detail}`
  })
  return head ? `${head}\n\n${lines.join("\n")}` : lines.join("\n")
}
