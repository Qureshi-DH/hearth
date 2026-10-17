import { load, remove, save } from "@/utils/storage"

/**
 * What the tracker did and why, kept on the phone. A family reports "the
 * notification stayed" or "it never noticed I left", and without this the
 * only answer was a guess. Newest last, survives a process kill, and the You
 * screen shows and shares it. A thousand lines because the evidence for a
 * phone that went quiet overnight is the twelve hours before somebody looked.
 *
 * Kept in chunks behind an index, the way the upload queue is, so a line
 * costs one short chunk on disk. As one blob, every line would rewrite all
 * thousand, three times a second while somebody watches Live.
 */
const KEY = "hearth.tracklog.v2"
const LEGACY_KEY = "hearth.tracklog.v1"
const CAP = 1000
const CHUNK_SIZE = 100

export interface TrackerLogEntry {
  at: string
  what: string
  detail?: Record<string, unknown>
}

interface Chunk {
  id: number
  entries: TrackerLogEntry[]
}

interface Index {
  ids: number[]
  next: number
}

let chunks: Chunk[] | null = null
let nextId = 0

const chunkKey = (id: number) => `${KEY}.${id}`

function writeIndex(list: Chunk[]): void {
  save(KEY, { ids: list.map((chunk) => chunk.id), next: nextId } satisfies Index)
}

function loaded(): Chunk[] {
  if (chunks) return chunks
  const index = load<Index>(KEY)
  const list: Chunk[] = []
  if (index && Array.isArray(index.ids)) {
    for (const id of index.ids) {
      const entries = load<TrackerLogEntry[]>(chunkKey(id))
      if (Array.isArray(entries) && entries.length > 0) list.push({ id, entries })
    }
    nextId = Math.max(index.next ?? 0, ...index.ids.map((id) => id + 1), 0)
  } else {
    const legacy = load<TrackerLogEntry[]>(LEGACY_KEY)
    if (Array.isArray(legacy)) {
      for (let i = 0; i < legacy.length; i += CHUNK_SIZE) {
        const chunk = { id: nextId++, entries: legacy.slice(i, i + CHUNK_SIZE) }
        save(chunkKey(chunk.id), chunk.entries)
        list.push(chunk)
      }
      writeIndex(list)
    }
    remove(LEGACY_KEY)
  }
  chunks = list
  return list
}

function count(list: Chunk[]): number {
  return list.reduce((total, chunk) => total + chunk.entries.length, 0)
}

export function logTracker(what: string, detail?: Record<string, unknown>): void {
  const list = loaded()
  let tail = list[list.length - 1]
  let indexChanged = false
  if (!tail || tail.entries.length >= CHUNK_SIZE) {
    tail = { id: nextId++, entries: [] }
    list.push(tail)
    indexChanged = true
  }
  tail.entries.push({ at: new Date().toISOString(), what, ...(detail ? { detail } : {}) })
  save(chunkKey(tail.id), tail.entries)

  let over = count(list) - CAP
  while (over > 0 && list.length > 1) {
    const head = list[0]!
    if (head.entries.length > over) {
      head.entries = head.entries.slice(over)
      save(chunkKey(head.id), head.entries)
      break
    }
    list.shift()
    remove(chunkKey(head.id))
    over -= head.entries.length
    indexChanged = true
  }
  if (indexChanged) writeIndex(list)
}

export function readTrackerLog(): TrackerLogEntry[] {
  return loaded().flatMap((chunk) => chunk.entries)
}

export function clearTrackerLog(): void {
  for (const chunk of loaded()) remove(chunkKey(chunk.id))
  chunks = []
  writeIndex(chunks)
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
