import { DEFAULTS, type LocationFixInput } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { storage } from "@/utils/storage"

import { mmkvStorage } from "./mmkv"

import type { MotionActivity } from "../../modules/hearth-motion"

export type PermissionLevel = "unknown" | "denied" | "foreground" | "always"

/**
 * On, the phone answers the server's pings and goes Live while somebody
 * watches, and the motion sensor says whether it is moving, which costs no
 * location. A drive, where a circle wants crash alerts, is the one thing
 * that runs between the two.
 */
export type TrackingMode = "off" | "on"

export interface TrackingPolicy {
  minUpdateIntervalSeconds: number
  distanceFilterMeters: number
}

interface TrackingState {
  /** The user's master switch. Off means no location leaves the phone. */
  enabled: boolean
  permission: PermissionLevel
  /** The OS location switch, separate from whether we were granted access. */
  servicesEnabled: boolean
  /** False when the person allowed only approximate location, Android's coarse or iOS's reduced accuracy. */
  preciseLocation: boolean
  backgroundActive: boolean
  /** Android only. Records that the dialog was shown, not that it was granted. */
  onboardedPermissions: boolean
  policy: TrackingPolicy
  mode: TrackingMode
  /**
   * Until when somebody has this phone's owner's page open and the phone is
   * on live updates for them. Outlives the process, which iOS may end and
   * relaunch inside the window.
   */
  watchedUntil: string | null
  /**
   * The motion sensor's last word and when it began. Persisted, because the
   * process that answers a ping is often one the OS started for it.
   */
  lastVerdict: MotionActivity | null
  lastVerdictAt: number | null
  /**
   * When the newest fix that came from the OS was taken. A ping to a phone
   * still since then is answered with that fix again, and this is what the
   * hour a repeat may stand in for is counted from.
   */
  lastRealFixAt: string | null
  /** When the drive crash detection runs for began, or null outside one. */
  driveSince: string | null
  /**
   * When the server refused this account's fixes outright, as it does for a
   * deactivated account. Nothing uploads or starts again on its own until a
   * new sign-in or the Sharing switch, since every request would be refused
   * the same way.
   */
  uploadsRefusedAt: string | null
  lastFix: LocationFixInput | null
  lastUploadAt: string | null
  lastError: string | null
  queue: LocationFixInput[]
  /** What the server accepted, not what was sent. */
  uploadedCount: number

  setEnabled(enabled: boolean): void
  setPermission(level: PermissionLevel): void
  setServicesEnabled(enabled: boolean): void
  setPreciseLocation(precise: boolean): void
  setBackgroundActive(active: boolean): void
  setOnboardedPermissions(value: boolean): void
  setPolicy(policy: TrackingPolicy): void
  setMode(mode: TrackingMode): void
  setWatchedUntil(until: string | null): void
  setLastVerdict(verdict: MotionActivity | null, at?: number | null): void
  setLastRealFixAt(at: string | null): void
  setDriveSince(at: string | null): void
  setUploadsRefusedAt(at: string | null): void
  enqueue(fixes: LocationFixInput[]): void
  /** Fixes the native side sent itself. The newest becomes the last fix, and nothing is queued. */
  noteSent(fixes: LocationFixInput[]): void
  dequeue(fixes: LocationFixInput[]): void
  recordUpload(accepted: number): void
  setError(message: string | null): void
  reset(): void
}

/** An offline week of breadcrumbs must not blow up storage. The newest win. */
const MAX_QUEUE = 2000

/**
 * zustand's persist rewrites a store's whole partialized state after every set,
 * with no check on what actually changed. While the queue lived in there, a
 * `setError` on a phone holding a day of backlog serialised half a megabyte to
 * disk, and so did every mode change, permission read and stillness re-anchor.
 * The queue gets its own keys, written only by the actions that change it.
 *
 * Chunked rather than kept as one blob because a single blob makes an outage
 * quadratic: each new fix rewrites every fix already waiting. A delivery now
 * touches the tail chunk, and a drained batch drops whole leading chunks.
 */
const QUEUE_KEY = "hearth.tracking.queue.v1"
const QUEUE_CHUNK_SIZE = 100

interface QueueChunk {
  id: number
  fixes: LocationFixInput[]
}

interface QueueIndex {
  chunkIds: number[]
  nextChunkId: number
  lastFix: LocationFixInput | null
}

let chunks: QueueChunk[] = []
let nextChunkId = 0

const chunkKey = (id: number) => `${QUEUE_KEY}.${id}`

const flatten = () => chunks.flatMap((chunk) => chunk.fixes)

const queueLength = () => chunks.reduce((total, chunk) => total + chunk.fixes.length, 0)

/**
 * Surviving chunks, then the index, then the keys nothing points at any more.
 * A process killed part way through leaves a chunk the index has not adopted
 * yet, which the next launch sweeps, rather than an index naming a chunk that
 * was never written.
 */
function commitQueue(dirty: Set<number>, removed: number[], lastFix: LocationFixInput | null) {
  for (const chunk of chunks) {
    if (dirty.has(chunk.id)) storage.set(chunkKey(chunk.id), JSON.stringify(chunk.fixes))
  }
  const index: QueueIndex = { chunkIds: chunks.map((chunk) => chunk.id), nextChunkId, lastFix }
  storage.set(QUEUE_KEY, JSON.stringify(index))
  for (const id of removed) storage.delete(chunkKey(id))
}

function readIndex(): QueueIndex | null {
  try {
    const raw = storage.getString(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as QueueIndex) : null
  } catch {
    return null
  }
}

function readChunk(id: number): LocationFixInput[] | null {
  try {
    const raw = storage.getString(chunkKey(id))
    const fixes = raw ? (JSON.parse(raw) as LocationFixInput[]) : null
    return Array.isArray(fixes) ? fixes : null
  } catch {
    return null
  }
}

/**
 * Anything the index does not name is a chunk a kill orphaned, or one left by
 * an account that signed out here. Breadcrumbs must not outlive either.
 */
function sweepOrphans() {
  const referenced = new Set(chunks.map((chunk) => chunk.id))
  const prefix = `${QUEUE_KEY}.`
  for (const key of storage.getAllKeys()) {
    if (!key.startsWith(prefix)) continue
    if (!referenced.has(Number(key.slice(prefix.length)))) storage.delete(key)
  }
}

function hydrateQueue(): { queue: LocationFixInput[]; lastFix: LocationFixInput | null } {
  const index = readIndex()
  const ids = Array.isArray(index?.chunkIds) ? index.chunkIds : []
  chunks = []
  for (const id of ids) {
    const fixes = readChunk(id)
    // A chunk that will not parse is a few minutes of breadcrumbs, not a reason
    // to launch with no queue at all.
    if (fixes && fixes.length > 0) chunks.push({ id, fixes })
  }
  nextChunkId = Math.max(index?.nextChunkId ?? 0, ...ids.map((id) => id + 1), 0)
  sweepOrphans()
  return { queue: flatten(), lastFix: index?.lastFix ?? null }
}

function pushFixes(fixes: LocationFixInput[], lastFix: LocationFixInput | null) {
  const dirty = new Set<number>()
  for (const fix of fixes) {
    let tail = chunks[chunks.length - 1]
    if (!tail || tail.fixes.length >= QUEUE_CHUNK_SIZE) {
      tail = { id: nextChunkId++, fixes: [] }
      chunks.push(tail)
    }
    tail.fixes.push(fix)
    dirty.add(tail.id)
  }

  const removed: number[] = []
  let over = queueLength() - MAX_QUEUE
  while (over > 0 && chunks.length > 0) {
    const head = chunks[0]
    if (head.fixes.length > over) {
      head.fixes = head.fixes.slice(over)
      dirty.add(head.id)
      break
    }
    chunks.shift()
    dirty.delete(head.id)
    removed.push(head.id)
    over -= head.fixes.length
  }

  commitQueue(dirty, removed, lastFix)
  return flatten()
}

function dropFixes(sent: Set<string>, lastFix: LocationFixInput | null) {
  const dirty = new Set<number>()
  const removed: number[] = []
  const kept: QueueChunk[] = []
  for (const chunk of chunks) {
    const fixes = chunk.fixes.filter((fix) => !sent.has(fix.recordedAt))
    if (fixes.length === chunk.fixes.length) {
      kept.push(chunk)
      continue
    }
    if (fixes.length === 0) {
      removed.push(chunk.id)
      continue
    }
    chunk.fixes = fixes
    dirty.add(chunk.id)
    kept.push(chunk)
  }
  chunks = kept
  commitQueue(dirty, removed, lastFix)
  return flatten()
}

function clearQueue() {
  const removed = chunks.map((chunk) => chunk.id)
  chunks = []
  storage.delete(QUEUE_KEY)
  for (const id of removed) storage.delete(chunkKey(id))
  sweepOrphans()
}

const restored = hydrateQueue()

/** What builds before the ping kept here. */
const RETIRED_KEYS = [
  "stillAnchor",
  "restingFix",
  "lastDriftCheckAt",
  "driving",
  "activityHistory",
  "motionStillSince",
  "serviceStoppedAt",
  "serviceRefusedAt",
]

export const useTrackingStore = create<TrackingState>()(
  persist(
    (set, get) => ({
      enabled: true,
      permission: "unknown",
      servicesEnabled: true,
      preciseLocation: true,
      backgroundActive: false,
      onboardedPermissions: false,
      policy: {
        minUpdateIntervalSeconds: DEFAULTS.minUpdateIntervalSeconds,
        distanceFilterMeters: DEFAULTS.distanceFilterMeters,
      },
      mode: "off",
      watchedUntil: null,
      lastVerdict: null,
      lastVerdictAt: null,
      lastRealFixAt: null,
      driveSince: null,
      uploadsRefusedAt: null,
      lastFix: restored.lastFix,
      lastUploadAt: null,
      lastError: null,
      queue: restored.queue,
      uploadedCount: 0,

      setEnabled: (enabled) => set(enabled ? { enabled, uploadsRefusedAt: null } : { enabled }),
      setPermission: (permission) => set({ permission }),
      setServicesEnabled: (servicesEnabled) => set({ servicesEnabled }),
      setPreciseLocation: (preciseLocation) => set({ preciseLocation }),
      setBackgroundActive: (backgroundActive) => set({ backgroundActive }),
      setOnboardedPermissions: (onboardedPermissions) => set({ onboardedPermissions }),
      setPolicy: (policy) => set({ policy }),
      setMode: (mode) => set({ mode }),
      setWatchedUntil: (watchedUntil) => set({ watchedUntil }),
      // A verdict repeating the one in force does not move when it began.
      setLastVerdict: (lastVerdict, at = Date.now()) =>
        set((state) =>
          lastVerdict === state.lastVerdict && state.lastVerdictAt != null
            ? {}
            : { lastVerdict, lastVerdictAt: lastVerdict == null ? null : at },
        ),
      setLastRealFixAt: (lastRealFixAt) => set({ lastRealFixAt }),
      setDriveSince: (driveSince) => set({ driveSince }),
      setUploadsRefusedAt: (uploadsRefusedAt) => set({ uploadsRefusedAt }),
      enqueue: (fixes) => {
        const lastFix = fixes[fixes.length - 1] ?? get().lastFix
        set({ queue: pushFixes(fixes, lastFix), lastFix })
      },
      noteSent: (fixes) => {
        const lastFix = fixes[fixes.length - 1] ?? get().lastFix
        set({ queue: pushFixes([], lastFix), lastFix })
      },
      dequeue: (fixes) => {
        // Match by timestamp, not position. `enqueue` may have trimmed the head
        // while an upload was in flight, and a positional slice would then throw
        // away fixes that were never sent.
        const sent = new Set(fixes.map((fix) => fix.recordedAt))
        set({ queue: dropFixes(sent, get().lastFix) })
      },
      recordUpload: (accepted) =>
        set({
          lastUploadAt: new Date().toISOString(),
          lastError: null,
          uploadedCount: get().uploadedCount + accepted,
        }),
      setError: (lastError) => set({ lastError }),
      reset: () => {
        clearQueue()
        set({
          backgroundActive: false,
          mode: "off",
          watchedUntil: null,
          lastVerdict: null,
          lastVerdictAt: null,
          lastRealFixAt: null,
          driveSince: null,
          uploadsRefusedAt: null,
          lastFix: null,
          lastUploadAt: null,
          lastError: null,
          queue: [],
          uploadedCount: 0,
        })
      },
    }),
    {
      name: "hearth.tracking.v1",
      version: 3,
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        permission: state.permission,
        preciseLocation: state.preciseLocation,
        onboardedPermissions: state.onboardedPermissions,
        policy: state.policy,
        mode: state.mode,
        watchedUntil: state.watchedUntil,
        lastVerdict: state.lastVerdict,
        lastVerdictAt: state.lastVerdictAt,
        lastRealFixAt: state.lastRealFixAt,
        driveSince: state.driveSince,
        uploadsRefusedAt: state.uploadsRefusedAt,
        lastUploadAt: state.lastUploadAt,
      }),
      // v3 is the ping: the tiers and the parking spot are gone, and a phone
      // that was moving or parked is on. The classifier's last word stays,
      // dated from now since nothing older is known. The interval the server
      // sends with its next reply replaces the old one.
      //
      // v2 put the motion permission on the setup checklist. The checklist only
      // opens itself once per install, so a phone that finished it before the
      // row existed is walked through it again.
      //
      // v0 carried the queue and lastFix in this blob. Dropping them here
      // instead would hand the merge a stale queue that overwrites the one just
      // read from the new keys, and lose whatever was waiting to upload.
      migrate: (persisted, version) => {
        let state = (persisted ?? {}) as Record<string, unknown>
        if (version < 1) {
          const { queue, lastFix, ...rest } = state as {
            queue?: LocationFixInput[]
            lastFix?: LocationFixInput | null
          }
          const carried = queue?.length ? pushFixes(queue, lastFix ?? null) : restored.queue
          state = { ...rest, queue: carried, lastFix: lastFix ?? restored.lastFix }
        }
        if (version < 2) state = { ...state, onboardedPermissions: false }
        if (version < 3) {
          const { mode, policy: _policy, ...rest } = state
          for (const key of RETIRED_KEYS) delete rest[key]
          state = {
            ...rest,
            mode: mode === "moving" || mode === "stationary" ? "on" : "off",
            lastVerdictAt: rest.lastVerdict ? Date.now() : null,
          }
        }
        return state as unknown as TrackingState
      },
    },
  ),
)
