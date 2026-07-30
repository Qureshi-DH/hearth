import { load, save } from "@/utils/storage"

/**
 * What the tracker did and why, kept on the phone. A family reports "the
 * notification stayed" or "it never noticed I left", and without this the
 * only answer was a guess. Two hundred lines, newest last, survive a process
 * kill, and the You screen shows and shares them.
 */
const KEY = "hearth.tracklog.v1"
const CAP = 300

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

/** One line per entry, for sharing. */
export function formatTrackerLog(list: TrackerLogEntry[] = readTrackerLog()): string {
  return list
    .map((entry) => {
      const detail = entry.detail ? " " + JSON.stringify(entry.detail) : ""
      return `${entry.at} ${entry.what}${detail}`
    })
    .join("\n")
}
