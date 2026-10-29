import { AppState, Platform } from "react-native"
import * as BackgroundTask from "expo-background-task"
import * as Battery from "expo-battery"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {
  haversineMeters,
  type ActivityType,
  type LocationFixInput,
  type LocationSource,
} from "@hearth/shared"

import { ApiError, api, endpoints } from "@/services/api"
import { tokenListeners } from "@/services/api/tokenListeners"
import { checkIncident, noteIncidentFix, raiseIncident } from "@/services/incidentAlarm"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { control, setControlHandler } from "@/services/location/control"
import { startDriveSensors, stopDriveSensors } from "@/services/location/driveSensors"
import { noteDriveFix } from "@/services/location/driveSpeeds"
import { logTracker, setTrackerLogHeader } from "@/services/location/log"
import {
  inMovingVehicle,
  motionPermission,
  queryMotion,
  startMotion,
  stillThroughout,
  stopMotion,
  type MotionActivity,
  type MotionRecord,
  type Subscription,
} from "@/services/location/motion"
import * as native from "@/services/location/nativeTracker"
import { useTrackingStore, type PermissionLevel, type TrackingPolicy } from "@/stores/tracking"

/**
 * Where the phone is, when somebody asks. The server pings each phone on
 * its circle's interval, and a little sooner while its last fix had it on
 * the move. The motion sensor, which costs no location, says whether it has
 * moved since its last fix: a phone lying still answers with that fix again
 * and location is never switched on, and one that moved answers with one
 * Wi-Fi grade fix. Opening somebody's page asks for a fresh fix, and Live
 * puts the phone on a GPS fix a second for as long as they watch. Moving
 * switches on no tracking. A drive, where a circle wants crash alerts, runs
 * the GPS for the detector's speed, and those fixes stay on the phone.
 *
 * On Android the native side answers the ping and Live on its own, from the
 * push handler, with the session's upload key, and starts a drive from the
 * classifier's transition. This side tells it whether sharing and crash
 * alerts are on and learns from its queue what it did. On iOS a silent push
 * wakes this side for the ping, Core Motion's history answers whether the
 * phone moved, and a location session runs for a Live window or a drive.
 */

export const BACKGROUND_LOCATION_TASK = "hearth-background-location"
/** Must match BGTaskSchedulerPermittedIdentifiers in app.json. */
export const BACKGROUND_SYNC_TASK = "com.binary.rewind.hearth.sync"
/** The React Native headless task Android runs for a session with no upload key; registered in index.tsx. */
export const HEADLESS_TASK = "HearthTracker"
/** Builds before 1.3.4 armed a fence around the parking spot under this name. */
const LEGACY_GEOFENCE_TASK = "hearth-stationary-geofence"

const MAX_BATCH = 200

/** A fix a second, every one uploaded, for as long as somebody is watching. */
const LIVE_INTERVAL_MS = 1_000
/**
 * How long a ping may answer with the last fix while the motion sensor has
 * the phone lying still. Past this, one real fix proves it right, so a
 * departure it missed costs the family at most this long. The native side's
 * own figure, Departure.STILL_REUSE_MS.
 */
const STILL_REUSE_MS = 60 * 60 * 1000
/** A drive whose GPS has had the phone standing this long is over, whatever the classifier says. */
const DRIVE_STANDING_MS = 10 * 60 * 1000
const DRIVE_STANDING_MPS = 2
/** On iOS, how long the motion sensor has to keep the phone on foot or still before a drive ends. */
const DRIVE_OUT_OF_VEHICLE_MS = 3 * 60 * 1000
/** How far before the last fix Core Motion's history is read from, for the record in force then. */
const MOTION_HISTORY_MS = 6 * 60 * 60 * 1000
/** How far back a ping looks for the drive's newest record. */
const DRIVE_HISTORY_MS = 20 * 60 * 1000
/** A drive fix this fresh answers a ping in its place. */
const DRIVE_FIX_FRESH_MS = 30_000
/**
 * Android's getCurrentPositionAsync has no timeout of its own, and a request
 * a background app makes can hang for the life of the process. iOS gives a
 * silent push about thirty seconds. Every one-shot fix waits this long.
 */
const FIX_TIMEOUT_MS = 20_000
/** The OS's last fix may stand in for one that never came while it is this fresh. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000
/**
 * A fresh request answered with a fix older than this was answered from the
 * OS's cache, and is asked again. The server never moves presence back in
 * time, so an app opened after hours away would otherwise leave the row
 * saying "two hours ago, at home".
 */
const FRESH_FIX_MAX_AGE_MS = 60 * 1000
/** At or under this a fix came from GPS; above it, from Wi-Fi or a cell. */
const GPS_CLASS_ACCURACY_METERS = 30

/** A failed upload tries again on this ladder, then waits for the next fix. */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]
/**
 * While live the next fix is a second away, so waiting for it is no
 * back-off at all, and the slowest step repeats. Every fix stays queued for
 * when the server can be reached again, whatever locked the phone out.
 */
const LIVE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]
/**
 * A live upload carries a second's fixes and comes back well inside this.
 * One that has not is stuck on a dead connection, and a fresh request gets
 * through where waiting the full half minute froze the viewer's map.
 */
const LIVE_UPLOAD_TIMEOUT_MS = 4_000

/**
 * What a fix says the phone is doing, with no classifier to ask. The same
 * rule as UploadWire.activity on the Android side, which labels the pings
 * it sends itself.
 */
const DRIVING_SPEED_MPS = 6
const STILL_SPEED_MPS = 0.5
const STILL_SLACK_METERS = 50
/** Looser than this, two fixes in the same place prove nothing about staying put. */
const STILL_MAX_ACCURACY_METERS = 100
const LABEL_MIN_GAP_MS = 60_000
const LABEL_MAX_GAP_MS = 60 * 60 * 1000

type BatterySnapshot = { batteryLevel: number | null; isCharging: boolean | null }

async function batterySnapshot(): Promise<BatterySnapshot> {
  try {
    const [level, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ])
    return {
      batteryLevel: level >= 0 ? Math.round(level * 100) / 100 : null,
      isCharging:
        state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL
          ? true
          : state === Battery.BatteryState.UNPLUGGED
            ? false
            : null,
    }
  } catch {
    return { batteryLevel: null, isCharging: null }
  }
}

export function toFix(
  location: Location.LocationObject,
  source: LocationSource,
  battery: BatterySnapshot,
  previous: LocationFixInput | null = useTrackingStore.getState().lastFix,
): LocationFixInput {
  const c = location.coords
  // iOS reports a negative accuracy to mean "this component is invalid",
  // which is routine for altitude on a Wi-Fi or cell derived fix. The server
  // would reject the whole batch over it.
  const accuracy = c.accuracy != null && c.accuracy >= 0 ? c.accuracy : null
  const fix: LocationFixInput = {
    recordedAt: new Date(location.timestamp).toISOString(),
    lat: c.latitude,
    lon: c.longitude,
    accuracyMeters: accuracy,
    altitudeMeters: c.altitude ?? null,
    altitudeAccuracyMeters:
      c.altitudeAccuracy != null && c.altitudeAccuracy >= 0 ? c.altitudeAccuracy : null,
    speedMps: measuredSpeed(c.speed, accuracy),
    headingDegrees: c.heading != null && c.heading >= 0 ? c.heading : null,
    batteryLevel: battery.batteryLevel,
    isCharging: battery.isCharging,
    source,
  }
  // The server reads "still" as a phone meant to be quiet, and the family
  // sees a car for a drive. Road speed the GPS measured is a drive whatever
  // was said a minute ago. Otherwise the motion sensor knows, where it said
  // so before the fix was taken, and a still it said is no answer to a fix
  // that measured the phone moving.
  const speed = fix.speedMps
  if (speed != null && speed >= DRIVING_SPEED_MPS) return { ...fix, activity: "driving" }
  const verdict = classifierActivity(location.timestamp)
  const usable = verdict != null && !(verdict === "still" && speed != null && speed >= 1)
  return { ...fix, activity: usable ? verdict : pingActivity(fix, previous) }
}

/** The motion sensor's word in force at `at`, in the server's terms, or null where it had none. */
function classifierActivity(at: number): ActivityType | null {
  const { lastVerdict: verdict, lastVerdictAt } = useTrackingStore.getState()
  if (lastVerdictAt == null || lastVerdictAt > at) return null
  switch (verdict) {
    case "automotive":
      return "driving"
    case "still":
    case "walking":
    case "running":
    case "cycling":
      return verdict
    default:
      return null
  }
}

/**
 * Android hands over 0 for a speed it never measured, where iOS says -1, and
 * a Wi-Fi or cell fix never measures one. Read as a real zero, every network
 * fix on Android was a car that had stopped. A zero on a GPS fix is a real
 * stop and stays.
 */
function measuredSpeed(speed: number | null | undefined, accuracy: number | null): number | null {
  if (speed == null || speed < 0) return null
  if (
    Platform.OS === "android" &&
    speed === 0 &&
    (accuracy == null || accuracy > GPS_CLASS_ACCURACY_METERS)
  ) {
    return null
  }
  return speed
}

/**
 * A speed the GPS measured says what the phone is doing outright. Otherwise
 * the fix before it does, when the two are far enough apart in time to mean
 * anything: no further apart than their error circles is a phone that
 * stayed put, and road speed between them is a drive. Anything else is not
 * known. A cell estimate a kilometre wide can hide a drive inside its error
 * circle, so "still" is only said of fixes sharp enough to show it, and a
 * drive is measured on what the circles cannot explain.
 */
export function pingActivity(
  fix: Pick<LocationFixInput, "lat" | "lon" | "recordedAt" | "accuracyMeters" | "speedMps">,
  previous: Pick<LocationFixInput, "lat" | "lon" | "recordedAt" | "accuracyMeters"> | null,
): ActivityType {
  const speed = fix.speedMps
  if (speed != null) {
    if (speed >= DRIVING_SPEED_MPS) return "driving"
    if (speed < STILL_SPEED_MPS) return "still"
    return "unknown"
  }
  if (!previous) return "unknown"
  const gap = Date.parse(fix.recordedAt) - Date.parse(previous.recordedAt)
  if (!(gap >= LABEL_MIN_GAP_MS && gap <= LABEL_MAX_GAP_MS)) return "unknown"
  const moved = haversineMeters(previous, fix)
  const error = (fix.accuracyMeters ?? 0) + (previous.accuracyMeters ?? 0)
  const sharp =
    (fix.accuracyMeters ?? Infinity) <= STILL_MAX_ACCURACY_METERS &&
    (previous.accuracyMeters ?? Infinity) <= STILL_MAX_ACCURACY_METERS
  if (sharp && moved <= error + STILL_SLACK_METERS) return "still"
  return (moved - error) / (gap / 1000) >= DRIVING_SPEED_MPS ? "driving" : "unknown"
}

/**
 * iOS hands over bursts of near-identical samples on a fresh session. The
 * live stream needs a fix a second, not three.
 */
export function thin(
  fixes: LocationFixInput[],
  previous: LocationFixInput | null,
  minIntervalMs: number,
): LocationFixInput[] {
  const kept: LocationFixInput[] = []
  let last = previous
  for (const fix of fixes) {
    if (
      last &&
      fix.source !== "manual" &&
      fix.source !== "sos" &&
      Date.parse(fix.recordedAt) - Date.parse(last.recordedAt) < minIntervalMs / 2
    ) {
      continue
    }
    kept.push(fix)
    last = fix
  }
  return kept
}

let flushing: Promise<void> | null = null
let flushAgain = false
/** Live uploads that timed out in a row. Two is a slow network rather than a stuck request. */
let liveTimeouts = 0

/**
 * Network failures leave the queue intact for the next attempt. A 4xx that is
 * not an auth problem means the batch itself is bad, so it gets dropped. One
 * poison fix must not wedge the pipeline forever. The next batch waits on
 * the retry ladder, since a firewall in front of the server can lock the
 * phone out for a 4xx, and a 403 from Hearth itself ends sharing.
 *
 * Single flight, and a call that lands while one is running asks for one more
 * pass after it, so a fix enqueued as the loop was ending is not left waiting
 * for the next one.
 */
export function flush(): Promise<void> {
  if (flushing) {
    flushAgain = true
    return flushing
  }
  flushing = (async () => {
    do {
      flushAgain = false
      await doFlush()
    } while (flushAgain)
  })().finally(() => {
    flushing = null
    // Every delivery, retry and sync pass comes through here, and an
    // incident's countdown or unsent alert is decided on the same beat.
    void checkIncident()
  })
  return flushing
}

async function doFlush(): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled || store.uploadsRefusedAt) return
  if (!useAuthStore.getState().serverUrl) return
  if (useTrackingStore.getState().queue.length === 0) return
  if (!(await tokenVault.hydrate())) return

  while (useTrackingStore.getState().queue.length > 0) {
    const batch = useTrackingStore.getState().queue.slice(0, MAX_BATCH)
    const live = watchedNow()
    const sentAt = Date.now()
    try {
      const result = await endpoints.locations.upload(
        batch,
        live && liveTimeouts < 2 ? { timeoutMs: LIVE_UPLOAD_TIMEOUT_MS } : undefined,
      )
      liveTimeouts = 0
      useTrackingStore.getState().dequeue(batch)
      useTrackingStore.getState().recordUpload(result.accepted)
      clearRetry()
      // The server just answered, so an alert waiting for a signal goes now.
      void checkIncident({ online: true })
      if (watchedNow()) {
        tallyLive({ sent: batch.length, accepted: result.accepted })
      } else {
        logTracker("flush", {
          sent: batch.length,
          accepted: result.accepted,
          queued: useTrackingStore.getState().queue.length,
        })
      }
      void adoptWatch(result.watchedUntil, result.serverTime, sentAt)
      adoptPolicy(result.policy)
    } catch (error) {
      const queued = useTrackingStore.getState().queue.length
      if (error instanceof ApiError) {
        // Again at once on a fresh request, with the same fixes in the same
        // order. A second timeout in a row is the network, and the ladder
        // takes over.
        if (live && error.code === "timeout") {
          liveTimeouts += 1
          if (liveTimeouts === 1) {
            logTracker("flush failed", { status: "timeout", queued, again: true })
            continue
          }
        }
        if (error.isNetwork || error.isForeign || error.status >= 500 || error.status === 429) {
          useTrackingStore.getState().setError(error.message)
          logTracker("flush failed", { status: error.isNetwork ? "network" : error.status, queued })
          scheduleRetry()
          return
        }
        // The client refreshes on a 401 before this sees one, and a refusal
        // clears the tokens. Tokens still held mean the refresh got no
        // answer, from the network or a server mid-deploy, and the session
        // is fine.
        if (error.status === 401 && tokenVault.peek()) {
          useTrackingStore.getState().setError("Could not reach the server.")
          logTracker("flush failed", { status: "refresh", queued })
          scheduleRetry()
          return
        }
        if (error.status === 401) {
          useTrackingStore.getState().setError("Signed out. Sharing paused.")
          logTracker("flush failed", { status: 401, queued })
          return
        }
        // Hearth answers a deactivated account 403 on every request, so the
        // next fix would be refused the same way.
        if (error.status === 403) {
          await refuseUploads(error.message)
          return
        }
        // A validation failure, so this batch will never succeed.
        useTrackingStore.getState().dequeue(batch)
        useTrackingStore.getState().setError(error.message)
        logTracker("flush failed", { status: error.status, dropped: batch.length, queued })
        scheduleRetry()
        return
      }
      useTrackingStore.getState().setError((error as Error).message)
      logTracker("flush failed", { status: "error", error: (error as Error).message, queued })
      scheduleRetry()
      return
    }
  }
}

/** The interval comes back with every upload, and the foreground heartbeat runs on it. */
function adoptPolicy(policy: TrackingPolicy | undefined): void {
  if (!policy) return
  const current = useTrackingStore.getState().policy
  if (
    policy.minUpdateIntervalSeconds === current.minUpdateIntervalSeconds &&
    policy.distanceFilterMeters === current.distanceFilterMeters
  ) {
    return
  }
  useTrackingStore.getState().setPolicy(policy)
}

async function refuseUploads(message: string): Promise<void> {
  useTrackingStore.getState().setUploadsRefusedAt(new Date().toISOString())
  logTracker("refused", { status: 403 })
  await stopTracking().catch(() => undefined)
  useTrackingStore.getState().setError(message)
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0

/**
 * The next ping is minutes off, so a failed upload retries on a short ladder
 * that covers a network away for a moment. It is bounded, so a phone with no
 * coverage does not spend its battery hammering, and an upload that gets
 * through starts it over.
 */
function scheduleRetry(): void {
  if (retryTimer) return
  const live = watchedNow()
  const ladder = live ? LIVE_RETRY_DELAYS_MS : RETRY_DELAYS_MS
  const delay = ladder[retryAttempt] ?? (live ? ladder[ladder.length - 1] : undefined)
  if (delay == null) {
    retryAttempt = 0
    return
  }
  retryAttempt += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flush()
  }, delay)
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryAttempt = 0
}

/**
 * Fixes from an iOS location session, and the ones the Android side took
 * and left in its queue. Those it sent itself say where the phone is and are
 * not sent again. A drive's fixes are for crash detection and go nowhere
 * else, and a still phone's repeated fix is no new reading of where it is.
 */
export async function ingest(
  locations: Location.LocationObject[],
  source: LocationSource,
  {
    sent = false,
    local = false,
    repeated = false,
  }: { sent?: boolean; local?: boolean; repeated?: boolean } = {},
): Promise<void> {
  if (locations.length === 0) return
  const battery = await batterySnapshot()
  const state = useTrackingStore.getState()
  const all: LocationFixInput[] = []
  let previous = state.lastFix
  for (const location of locations) {
    const fix = toFix(location, source, battery, previous)
    all.push(fix)
    previous = fix
  }
  // Whenever they arrive. The crash check reads the speed either side of a
  // jolt, and a crashed car does not drive on.
  if (!repeated) {
    for (const fix of all) {
      noteDriveFix(fix)
      noteIncidentFix(fix)
    }
  }
  if (local) {
    // The phone's own last fix, which the detector stamps its samples with
    // while it is this fresh, and what a ping after the drive repeats from.
    // Still nothing is uploaded.
    state.noteSent(all)
    noteRealFix(all[all.length - 1]!)
    await onDriveFixes(all)
    // Nothing is uploaded on a drive, so nothing else comes through flush,
    // and a countdown run out with the screen off is decided on the drive's
    // own beat, every few seconds.
    void checkIncident()
    return
  }
  if (!repeated) noteRealFix(all[all.length - 1]!)
  const live = watchedNow()
  if (sent) {
    state.noteSent(all)
    if (live)
      tallyLive({ fixes: all.length, kept: all.length }, all[all.length - 1]!.accuracyMeters)
    else logTracker("fixes", { got: all.length, sent: true })
  } else {
    const kept = live ? thin(all, state.lastFix, LIVE_INTERVAL_MS) : all
    if (kept.length > 0) state.enqueue(kept)
    if (live)
      tallyLive({ fixes: all.length, kept: kept.length }, all[all.length - 1]!.accuracyMeters)
    else logTracker("fixes", { got: all.length, kept: kept.length })
  }
  // The live session delivers on its interval, so the first fix past the
  // window is what ends it, whether or not the timer got there.
  if (source === "background") await endWatchIfOver()
  // A retry already waiting is left to its timer, so a firewall that locked
  // the address out is not met with a request for every fix.
  if (!retryTimer) await flush()
}

/**
 * Live delivers a fix a second, and a line for each delivery and each
 * upload would rewrite the log every second and push the night's evidence
 * out of it within minutes. While live they are counted instead, and go
 * into the log as one line every half minute and one when the window ends.
 */
const LIVE_LOG_EVERY_MS = 30_000

interface LiveTally {
  since: number
  fixes: number
  kept: number
  sent: number
  accepted: number
  acc: number | null
}
let liveTally: LiveTally | null = null

function tallyLive(
  counts: Partial<Pick<LiveTally, "fixes" | "kept" | "sent" | "accepted">>,
  accuracy?: number | null,
): void {
  const now = Date.now()
  const tally = (liveTally ??= { since: now, fixes: 0, kept: 0, sent: 0, accepted: 0, acc: null })
  tally.fixes += counts.fixes ?? 0
  tally.kept += counts.kept ?? 0
  tally.sent += counts.sent ?? 0
  tally.accepted += counts.accepted ?? 0
  if (accuracy !== undefined) tally.acc = accuracy == null ? null : Math.round(accuracy)
  if (now - tally.since >= LIVE_LOG_EVERY_MS) logLiveTally()
}

function logLiveTally(): void {
  if (!liveTally) return
  const { since: _since, ...counts } = liveTally
  liveTally = null
  logTracker("live", { ...counts, queued: useTrackingStore.getState().queue.length })
}

/**
 * Fixes still being acquired, which the heartbeat counts as fresh. Counted
 * and dated: the count says one is in flight, the deadline says for how long
 * that can be believed, so a native request that never settles cannot hold
 * the heartbeat off for the rest of the process.
 */
let acquiring = 0
let acquiringUntil = 0

function acquisitionStarted(timeoutMs: number): void {
  acquiring += 1
  acquiringUntil = Math.max(acquiringUntil, Date.now() + timeoutMs)
}

function acquisitionEnded(): void {
  acquiring = Math.max(0, acquiring - 1)
  if (acquiring === 0) acquiringUntil = 0
}

function acquisitionInFlight(): boolean {
  return acquiring > 0 && Date.now() < acquiringUntil
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * One fix, bounded. When the fresh one is late, the fix the OS already has
 * will do where the caller says so: a ping wants to know the phone is alive
 * more than it wants a new estimate.
 */
async function acquireFix(
  accuracy: Location.Accuracy,
  timeoutMs: number,
  lastKnown: boolean,
): Promise<{ location: Location.LocationObject; cached: boolean }> {
  const started = Date.now()
  try {
    let location = await withDeadline(
      Location.getCurrentPositionAsync({ accuracy }),
      timeoutMs,
      "Location request",
    )
    const age = Date.now() - location.timestamp
    if (age > FRESH_FIX_MAX_AGE_MS) {
      // The cache answered. One more ask, inside the same deadline, is
      // what gets the OS to actually look; a second cached answer is all
      // it has, and is taken as it is.
      logTracker("report stale", { age: Math.round(age / 1000) })
      const remaining = Math.max(1_000, timeoutMs - (Date.now() - started))
      location = await withDeadline(
        Location.getCurrentPositionAsync({ accuracy }),
        remaining,
        "Location request",
      )
    }
    return { location, cached: false }
  } catch (error) {
    if (!lastKnown) throw error
    const last = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
    }).catch(() => null)
    if (!last) throw error
    return { location: last, cached: true }
  }
}

interface ReportOptions {
  timeoutMs?: number
  /** Whether the OS's last fix may stand in when the fresh one is late. */
  lastKnown?: boolean
}

function sharingOn(): boolean {
  const { enabled, mode } = useTrackingStore.getState()
  return enabled && mode !== "off"
}

/**
 * One fix, uploaded. A check-in and an SOS are the person asking, and get
 * the GPS. Everything else is a ping, and Wi-Fi grade is what a ping is.
 */
export async function reportNow(
  source: LocationSource = "manual",
  accuracy: Location.Accuracy = source === "sos"
    ? Location.Accuracy.Highest
    : source === "manual"
      ? Location.Accuracy.High
      : Location.Accuracy.Balanced,
  { timeoutMs = FIX_TIMEOUT_MS, lastKnown = true }: ReportOptions = {},
): Promise<LocationFixInput | null> {
  // A nudge still reaches the phone over the UI socket with sharing off,
  // and a fix queued then would upload the day sharing comes back.
  const asked = source === "manual" || source === "sos"
  if (!asked && !sharingOn()) return null
  const owner = useAuthStore.getState().user?.id
  const started = Date.now()
  logTracker("report", { source, accuracy })
  acquisitionStarted(timeoutMs)
  try {
    const { location, cached } = await acquireFix(accuracy, timeoutMs, lastKnown)
    // A fix can take a while. Sharing may have gone off meanwhile, or the
    // account may have signed out and somebody else signed in.
    if (useAuthStore.getState().user?.id !== owner || (!asked && !sharingOn())) {
      logTracker("report dropped", { source })
      return null
    }
    const fix = toFix(location, source, await batterySnapshot())
    useTrackingStore.getState().enqueue([fix])
    if (!cached) noteRealFix(fix)
    logTracker("report done", {
      source,
      acc: Math.round(fix.accuracyMeters ?? -1),
      ms: Date.now() - started,
      age: Math.max(0, Math.round((Date.now() - location.timestamp) / 1000)),
      activity: fix.activity,
      ...(cached ? { cached } : {}),
    })
    await flush()
    return fix
  } catch (error) {
    const message = (error as Error).message
    useTrackingStore.getState().setError(message)
    logTracker("report failed", { source, ms: Date.now() - started, error: message })
    return null
  } finally {
    acquisitionEnded()
  }
}

/**
 * The ping, from the app's side, while somebody has it open. The server's
 * own ping would bring the service up on Android, and a foreground app
 * needs none for one fix. Same interval, so a phone in use is reported no
 * more often than one in a pocket.
 */
let heartbeat: ReturnType<typeof setTimeout> | null = null

export function startForegroundHeartbeat(): void {
  void heartbeatTick()
  // Signed out, or sharing off, leaves a timer nothing to find every interval.
  // startTracking is the way back from "off" and it calls in again.
  if (useTrackingStore.getState().mode === "off") return
  if (!heartbeat) scheduleHeartbeat()
}

export function stopForegroundHeartbeat(): void {
  if (heartbeat) clearTimeout(heartbeat)
  heartbeat = null
}

/** A chain rather than setInterval, so a circle changing its interval applies at the next tick. */
function scheduleHeartbeat(): void {
  heartbeat = setTimeout(() => {
    scheduleHeartbeat()
    void heartbeatTick()
  }, intervalMs())
}

function intervalMs(): number {
  return useTrackingStore.getState().policy.minUpdateIntervalSeconds * 1000
}

async function heartbeatTick(): Promise<void> {
  const store = useTrackingStore.getState()
  if (AppState.currentState !== "active") return
  if (!store.enabled || store.mode === "off" || watchedNow()) return
  if (store.permission === "denied") {
    logTracker("heartbeat skipped", { reason: "permission" })
    return
  }
  if (!store.servicesEnabled) {
    logTracker("heartbeat skipped", { reason: "services" })
    return
  }
  if (acquisitionInFlight()) {
    logTracker("heartbeat skipped", { reason: "acquiring" })
    return
  }
  // What the native side sent, and what the classifier said, comes first.
  if (androidNative()) await processNativeQueue()
  const last = useTrackingStore.getState().lastFix
  const age = last ? Date.now() - Date.parse(last.recordedAt) : Infinity
  if (age < intervalMs()) return
  // A phone on the bed with the app open is still not moving.
  if (await stillSinceLastFix()) {
    await repeatLastFix()
    return
  }
  await considerDrive()

  acquisitionStarted(FIX_TIMEOUT_MS)
  try {
    const { location } = await acquireFix(Location.Accuracy.Balanced, FIX_TIMEOUT_MS, false)
    // A ping like the server's, and read like one. The server keeps
    // "heartbeat" out of trips, from a time when it meant a parked phone
    // reporting on a timer while it sat on the table with the app open.
    const fix = toFix(location, "nudge", await batterySnapshot())
    useTrackingStore.getState().enqueue([fix])
    noteRealFix(fix)
    await flush()
  } catch (error) {
    // Not reportNow, because that pins the failure on the You screen, and a
    // fix that times out indoors would repaint it red every interval.
    logTracker("report failed", { source: "heartbeat", error: (error as Error).message })
  } finally {
    acquisitionEnded()
  }
}

// The channel does not import the tracker, so the tracker hands it what to
// call. At module scope for the same reason as the tasks below.
setControlHandler({
  watch: (seconds) => enterWatched(seconds),
  wake: async (ping) => {
    await wakeFix({ ping })
  },
})

// defineTask has to run at module scope. The OS can hand us a background event
// before any React code has mounted.
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    useTrackingStore.getState().setError(error.message)
    logTracker("delivery failed", { error: error.message })
    // Most often the permission taken away, which the family should hear.
    await checkStatusInBackground()
    return
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? []
  // Only Live and an iPhone's drive run a session. One still delivering
  // outside both is left over, from a build before the ping or a stop that
  // never landed.
  if (Platform.OS === "ios" && watchedNow()) {
    await ingest(locations, "background")
    return
  }
  if (Platform.OS === "ios" && useTrackingStore.getState().driveSince) {
    // The window may have run out with the app suspended before its timer.
    await endWatchIfOver()
    await ingest(locations, "background", { local: true })
    return
  }
  // The window may have run out with the app suspended before its timer,
  // and the watch is closed the same way the timer would have closed it.
  await endWatchIfOver()
  await stopLocationSession()
})

/**
 * What the native side did while this side was down, or has just done: the
 * fixes it sent or could not send, and what happened on the way. One pass
 * at a time, and a poke landing mid pass asks for one more.
 */
let draining: Promise<void> | null = null
let drainAgain = false

export function processNativeQueue(): Promise<void> {
  if (!native.nativeTrackerAvailable) return Promise.resolve()
  if (draining) {
    drainAgain = true
    return draining
  }
  draining = (async () => {
    do {
      drainAgain = false
      await drainNativeQueue()
    } while (drainAgain)
  })().finally(() => {
    draining = null
  })
  return draining
}

async function drainNativeQueue(): Promise<void> {
  const fixes = await native.drainFixes().catch(() => [])
  // The service goes down a moment after it is told to, and what it saw
  // in between belongs to a session that has ended or to sharing that is
  // off. Kept, it would upload with the next account to track here.
  if (fixes.length > 0 && !sharingOn()) {
    logTracker("native dropped", { fixes: fixes.length })
  } else if (fixes.length > 0) {
    fixes.sort((a, b) => a.timestamp - b.timestamp)
    // In order, in runs of one kind, so the stream reads as one whichever
    // side sent each fix.
    type Queued = Location.LocationObject & { sent?: boolean; local?: boolean; repeated?: boolean }
    const kind = (fix: Queued) => ({
      sent: Boolean(fix.sent),
      local: Boolean(fix.local),
      repeated: Boolean(fix.repeated),
    })
    const sameKind = (a: Queued, b: Queued) => JSON.stringify(kind(a)) === JSON.stringify(kind(b))
    let run: Queued[] = []
    for (const fix of fixes as Queued[]) {
      if (run.length > 0 && !sameKind(run[0]!, fix)) {
        await ingest(run, "background", kind(run[0]!))
        run = []
      }
      run.push(fix)
    }
    await ingest(run, "background", kind(run[0]!))
  }
  const events = await native.drainEvents().catch(() => [])
  for (const event of events) {
    try {
      await onNativeEvent(event)
    } catch (error) {
      logTracker("native event failed", { type: event.type, error: (error as Error).message })
    }
  }
}

async function onNativeEvent(event: native.NativeEvent): Promise<void> {
  switch (event.type) {
    case "transition":
      useTrackingStore.getState().setLastVerdict(event.activity, event.at)
      logTracker("motion", { activity: event.activity, source: "transition" })
      return
    case "drive":
      await beginDrive("motion")
      return
    case "drive over":
      await finishDrive(event.reason, { native: true })
      return
    case "service":
      logTracker("native service", {
        status: event.status,
        reason: event.reason,
        ...(event.error ? { error: event.error } : {}),
      })
      return
    case "boot":
      logTracker("native boot", event.reboot ? { reboot: true } : {})
      // Switched off and carried somewhere: nothing the sensor said before
      // still holds, and no drive survived it.
      if (event.reboot) {
        useTrackingStore.getState().setLastVerdict(null)
        await finishDrive("reboot", { native: true })
      }
      return
    case "push":
      // "normal" against "high" is FCM having demoted the ask, which no
      // longer lets the service start from the background.
      logTracker("push", {
        kind: event.kind,
        priority: event.priority,
        original: event.original,
        late: event.lateMs == null ? null : Math.round(event.lateMs / 1000),
      })
      return
    case "exit":
      logTracker("exit", {
        reason: event.reason,
        description: event.description,
        importance: event.importance,
        at: new Date(event.at).toISOString(),
      })
      return
    case "start":
      logTracker("start", { reason: event.reason, forceStopped: event.forceStopped })
      return
    case "power":
      logTracker("power", {
        bucket: event.bucket ?? null,
        exempt: event.exempt,
        restricted: event.restricted ?? null,
        saver: event.saver,
      })
      return
    case "uploaded":
      await onNativeUpload(event)
      return
    case "upload":
      logTracker("native flush failed", { status: event.status, code: event.code })
      return
    case "wake":
      logTracker("native wake", {
        ...(event.still ? { still: true, sent: event.sent ?? false } : {}),
        ...(event.fix === false ? { fix: false } : {}),
        ...(event.service === false ? { service: false, sent: event.sent ?? false } : {}),
      })
      return
    case "watch":
      adoptNativeWatch(event.until, event.at)
      return
    case "watch over":
      if (useTrackingStore.getState().watchedUntil) await endWatch("released", { native: true })
      return
  }
}

/** The answer to an upload the native side sent, read as doFlush reads its own. */
async function onNativeUpload(
  event: Extract<native.NativeEvent, { type: "uploaded" }>,
): Promise<void> {
  useTrackingStore.getState().recordUpload(event.accepted ?? 0)
  if (watchedNow()) tallyLive({ sent: event.sent, accepted: event.accepted ?? 0 })
  else logTracker("flush", { sent: event.sent, accepted: event.accepted ?? 0, native: true })
  await adoptWatch(event.watchedUntil, event.serverTime, event.sentAt)
  adoptPolicy(event.policy)
}

/**
 * The service went live on a push, before this side heard. The window is
 * taken as the service holds it, and nothing is started, since the service
 * is already doing it.
 */
function adoptNativeWatch(until: number, openedAt: number): void {
  if (until <= Date.now()) return
  const store = useTrackingStore.getState()
  const held = store.watchedUntil ? Date.parse(store.watchedUntil) : 0
  windowTakenAt = Math.max(windowTakenAt, openedAt)
  liveInPlace = true
  if (until <= held) return
  logTracker("watched", { seconds: Math.round((until - Date.now()) / 1000), native: true })
  store.setWatchedUntil(new Date(until).toISOString())
  armWatchTimer()
}

/**
 * Android starts this in a process it woke with no screen and no React
 * tree: for a session with no upload key, whose push also reaches the wake
 * task in notifications.ts, and for the length of a drive, which holds it
 * open for crash detection. Everything it needs is in module scope.
 */
export async function runHeadlessTask(data: { reason?: string } = {}): Promise<void> {
  if (data.reason === "awake") return keepTrackerAwake()
  logTracker("headless", { reason: data.reason ?? "unknown" })
  await processNativeQueue()
}

/**
 * React Native runs no JavaScript timer while the app is in the background
 * and no headless task is open, and the crash detector is JavaScript. The
 * service opens one task for the length of a drive, and this holds it,
 * draining the queue every few seconds, until the drive is over. One hold
 * however many tasks ask.
 */
const AWAKE_TICK_MS = 5_000
let awake: Promise<void> | null = null

export function keepTrackerAwake(): Promise<void> {
  awake ??= (async () => {
    logTracker("awake")
    try {
      // Drained before it decides, since the drive that woke this is in the
      // queue and not yet in the store.
      for (;;) {
        await processNativeQueue()
        if (!useTrackingStore.getState().driveSince || !sharingOn()) break
        await new Promise((resolve) => setTimeout(resolve, AWAKE_TICK_MS))
      }
    } finally {
      awake = null
      logTracker("awake over")
      await native.releaseAwake()
    }
  })()
  return awake
}

/** Below this a verdict is a guess, and a guess says nothing about leaving the car. */
const MOTION_MIN_CONFIDENCE = 50
/** On foot this surely ends a drive at once, rather than after a still streak. */
const MOTION_SURE_CONFIDENCE = 75

let motionSubscription: Subscription | null = null
let motionStarting = false

/**
 * The classifier, wanted for as long as sharing is on, and costing no
 * location. On Android it is the classifier's transitions, which wake the
 * receiver and are read from the native queue. On an iPhone Core Motion's
 * history is read when a ping asks, and its live updates run only on a
 * drive, the one time the app is awake to hear them. startMotion answers
 * null where the module, the hardware or the permission is missing, and
 * every ping then takes a fix.
 */
async function startMotionWatch(): Promise<void> {
  // The resume path and a grant on the checklist can call this at once, and
  // each await below is a chance for the second to walk past a null
  // subscription and add a native listener whose handle we then lose.
  if (motionSubscription || motionStarting) return
  if (Platform.OS === "ios" && !useTrackingStore.getState().driveSince) return
  motionStarting = true
  try {
    motionSubscription = await startMotion((activity, confidence) => {
      void onMotion(activity, confidence)
    })
  } finally {
    motionStarting = false
  }
}

async function stopMotionWatch(): Promise<void> {
  if (!motionSubscription) return
  await stopMotion(motionSubscription)
  motionSubscription = null
}

/**
 * Called after the checklist grants the permission and whenever a circle's
 * crash alert setting changes, so the classifier starts without a relaunch
 * and the receiver knows whether a vehicle starts a drive.
 */
export async function refreshMotionWatch(): Promise<void> {
  if (!sharingOn()) return
  await startMotionWatch()
  await syncNativeState()
  if (!crashDetectionWanted()) await finishDrive("crash alerts off")
}

/** iOS's live verdicts, heard on a drive: out of the vehicle ends it. */
async function onMotion(activity: MotionActivity, confidence: number): Promise<void> {
  if (activity === "unknown" || confidence < MOTION_MIN_CONFIDENCE) return
  const store = useTrackingStore.getState()
  if (activity !== store.lastVerdict) {
    logTracker("motion", { activity, confidence, source: "sample" })
  }
  store.setLastVerdict(activity)
  if (!store.driveSince) return
  if (activity === "automotive") {
    outOfVehicleSince = null
    return
  }
  if (activity !== "still" && confidence >= MOTION_SURE_CONFIDENCE) {
    await finishDrive("motion")
    return
  }
  // Still is the lights as often as the car park. Core Motion repeats it,
  // and a few minutes of it is a car that has stopped.
  outOfVehicleSince ??= Date.now()
  if (Date.now() - outOfVehicleSince >= DRIVE_OUT_OF_VEHICLE_MS) await finishDrive("motion")
}

/** Whether a circle asked for crash alerts, which is all a drive runs for. */
function crashDetectionWanted(): boolean {
  return useSettingsStore.getState().incidentDetection
}

/**
 * A drive began, by the motion sensor's word: on Android the service runs
 * its GPS and sends the fixes here, and on an iPhone a session does. The
 * detector reads the sensors from now until the drive is over.
 */
async function beginDrive(why: string): Promise<void> {
  const store = useTrackingStore.getState()
  if (!sharingOn() || !crashDetectionWanted()) {
    // The service began one this side does not want: it hears so and ends it.
    if (androidNative()) await syncNativeState()
    return
  }
  const fresh = !store.driveSince
  if (fresh) {
    store.setDriveSince(new Date().toISOString())
    driveStoodSince = null
    logTracker("drive", { why })
  }
  if (Platform.OS === "ios") {
    try {
      if (!watchedNow() && (fresh || !(await locationSessionRunning()))) {
        await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, driveOptions())
      }
      // Under a watch too, since it is what sees the drive end.
      await startMotionWatch()
    } catch (error) {
      logTracker("drive refused", { error: (error as Error).message })
      store.setDriveSince(null)
      return
    }
  }
  // The drive may have ended while the session was coming up.
  if (!useTrackingStore.getState().driveSince) return
  void startDriveSensors((event) => {
    // Harsh braking is a driving quality signal with nowhere to go yet, so
    // only a possible impact is acted on.
    if (event.kind !== "possibleImpact") return
    void raiseIncident(event)
  })
}

async function resumeDrive(): Promise<void> {
  if (!crashDetectionWanted()) {
    await finishDrive("crash alerts off")
    return
  }
  if (androidNative()) {
    await processNativeQueue()
    if (!useTrackingStore.getState().driveSince) return
    const status = await native.serviceStatus().catch(() => "none" as const)
    if (status !== "running") await finishDrive("lost", { native: true })
    else await beginDrive("resumed")
    return
  }
  if (Platform.OS === "ios") {
    const history = await queryMotion(Date.now() - DRIVE_HISTORY_MS, Date.now())
    if (history && inMovingVehicle(history)) await beginDrive("resumed")
    else await finishDrive("stale")
  }
}

/** The drive is over: the motion sensor has the phone out of the vehicle, or its GPS standing. */
async function finishDrive(
  why: string,
  { native: fromNative = false }: { native?: boolean } = {},
): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.driveSince) return
  store.setDriveSince(null)
  driveStoodSince = null
  lastDriveFix = null
  outOfVehicleSince = null
  logTracker("drive over", { why, ...(fromNative ? { native: true } : {}) })
  // A countdown already running survives this, see stopDriveSensors.
  stopDriveSensors()
  if (Platform.OS === "ios") {
    if (!watchedNow()) await stopLocationSession()
    await stopMotionWatch()
  } else if (!fromNative) {
    // The service goes with its own reasons; this side only asks for one.
    await native.setTrackerState(nativeState()).catch(() => undefined)
  }
}

let driveStoodSince: number | null = null
/** The drive's newest fix, which answers a ping that lands during it. */
let lastDriveFix: LocationFixInput | null = null
let outOfVehicleSince: number | null = null

async function onDriveFixes(fixes: LocationFixInput[]): Promise<void> {
  const newest = fixes[fixes.length - 1]!
  lastDriveFix = newest
  if (Platform.OS !== "ios") return
  // Android's service makes this call itself.
  const now = Date.parse(newest.recordedAt)
  const moving = newest.speedMps != null && newest.speedMps >= DRIVE_STANDING_MPS
  if (moving) {
    driveStoodSince = null
    return
  }
  driveStoodSince ??= now
  if (now - driveStoodSince >= DRIVE_STANDING_MS) await finishDrive("standing")
}

/**
 * iOS has no way to start an app for a drive, so a ping that finds Core
 * Motion has had the phone in a moving vehicle in the last few minutes is
 * where one begins. Android's begins from the classifier's own transition.
 */
async function considerDrive(records?: MotionRecord[] | null): Promise<void> {
  if (Platform.OS !== "ios" || !crashDetectionWanted() || useTrackingStore.getState().driveSince) {
    return
  }
  const history = records ?? (await queryMotion(Date.now() - DRIVE_HISTORY_MS, Date.now()))
  if (history && inMovingVehicle(history)) await beginDrive("motion")
}

/** The newest of Core Motion's records, as the motion sensor's last word. */
function noteLatestRecord(records: MotionRecord[]): void {
  const latest = [...records].sort((a, b) => a.t - b.t).pop()
  if (!latest) return
  useTrackingStore
    .getState()
    .setLastVerdict(latest.stationary ? "still" : latest.activity, latest.t)
}

/** The newest fix that came from the OS, which a still phone's repeats stand in for. */
function noteRealFix(fix: LocationFixInput): void {
  const { lastRealFixAt } = useTrackingStore.getState()
  if (lastRealFixAt && Date.parse(lastRealFixAt) >= Date.parse(fix.recordedAt)) return
  useTrackingStore.getState().setLastRealFixAt(fix.recordedAt)
}

/**
 * Whether the motion sensor has had the phone lying still since its last
 * real fix, so a ping can be answered with that fix and no location. On
 * Android the classifier's transition has to say still from before that
 * fix. On an iPhone Core Motion's history has to show nothing else since.
 * Within the hour only, so a departure the sensor missed costs no more.
 */
async function stillSinceLastFix(): Promise<boolean> {
  const { lastFix, lastRealFixAt, driveSince, permission } = useTrackingStore.getState()
  if (!lastFix || !lastRealFixAt || driveSince || permission !== "always") return false
  const realAt = Date.parse(lastRealFixAt)
  const age = Date.now() - realAt
  if (!(age >= 0 && age < STILL_REUSE_MS)) return false
  // The sensor's word holds only while it is listening.
  if ((await motionPermission()) !== "granted") {
    useTrackingStore.getState().setLastVerdict(null)
    return false
  }
  if (Platform.OS === "ios") {
    // From well before the fix, since the record in force when it was
    // taken can have begun hours earlier. The history is on the phone.
    const records = await queryMotion(realAt - MOTION_HISTORY_MS, Date.now())
    if (!records) return false
    noteLatestRecord(records)
    return stillThroughout(records, realAt)
  }
  const { lastVerdict, lastVerdictAt } = useTrackingStore.getState()
  return lastVerdict === "still" && lastVerdictAt != null && lastVerdictAt <= realAt
}

/** The last fix again, dated now and called still, with no location asked for. */
async function repeatLastFix(): Promise<LocationFixInput | null> {
  const { lastFix } = useTrackingStore.getState()
  if (!lastFix) return null
  const battery = await batterySnapshot()
  const fix: LocationFixInput = {
    ...lastFix,
    recordedAt: new Date().toISOString(),
    speedMps: null,
    headingDegrees: null,
    activity: "still",
    source: "nudge",
    batteryLevel: battery.batteryLevel,
    isCharging: battery.isCharging,
  }
  useTrackingStore.getState().enqueue([fix])
  logTracker("still", { since: lastFix.recordedAt })
  await flush()
  return fix
}

/**
 * The fallback for pings that do not arrive: iOS holds back silent pushes
 * when it decides an app has had enough, and FCM can sit on one in deep
 * Doze. The OS runs this every so often of its own accord, a quarter of an
 * hour at the very soonest, and a phone that has gone two intervals without
 * a fix reports from here. One that the pings are reaching has nothing to do.
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // What the native side sent for the pings it answered is the last fix
    // this side knows of, and a cold process has not read it yet.
    await processNativeQueue()
    const { enabled, mode, lastFix, queue } = useTrackingStore.getState()
    const age = lastFix ? Date.now() - Date.parse(lastFix.recordedAt) : Infinity
    const overdue = age > 2 * intervalMs()
    logTracker("sync", { mode, overdue, queued: queue.length })
    await checkStatusInBackground()
    if (enabled && mode !== "off" && overdue && (await currentPermission()) === "always") {
      if (await stillSinceLastFix()) await repeatLastFix()
      else await reportNow("significant", Location.Accuracy.Balanced, { timeoutMs: FIX_TIMEOUT_MS })
    } else {
      await flush()
    }
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

/**
 * Android's "Approximate" and iOS with Precise Location off both leave the
 * permission at Always, with a fix kilometres wide.
 */
function isPrecise(foreground: Location.LocationPermissionResponse): boolean {
  return Platform.OS === "android"
    ? foreground.android?.accuracy !== "coarse"
    : foreground.ios?.accuracy !== "reduced"
}

export async function currentPermission(): Promise<PermissionLevel> {
  const foreground = await Location.getForegroundPermissionsAsync()
  useTrackingStore.getState().setPreciseLocation(isPrecise(foreground))
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    return foreground.canAskAgain ? "unknown" : "denied"
  }
  const background = await Location.getBackgroundPermissionsAsync()
  return background.status === Location.PermissionStatus.GRANTED ? "always" : "foreground"
}

/** The platforms require this order. Foreground first, then the "Always" upgrade. */
export async function requestPermissions(): Promise<PermissionLevel> {
  const foreground = await Location.requestForegroundPermissionsAsync()
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    const level: PermissionLevel = foreground.canAskAgain ? "unknown" : "denied"
    useTrackingStore.getState().setPermission(level)
    return level
  }
  const background = await Location.requestBackgroundPermissionsAsync()
  const level: PermissionLevel =
    background.status === Location.PermissionStatus.GRANTED ? "always" : "foreground"
  useTrackingStore.getState().setPermission(level)
  return level
}

/**
 * The iOS Live session, for the window and no longer. On the interval
 * whether or not the phone moved, since only a session with no distance
 * filter delivers to a phone standing still, and a car at the lights sending
 * the same spot every second is what live means.
 */
function liveOptions(): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.High,
    timeInterval: LIVE_INTERVAL_MS,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
  }
}

/**
 * An iPhone's drive, for crash detection: the GPS on for its speed, which
 * the detector reads in the fifteen seconds before a jolt, and the session
 * is also what keeps the app awake to read the sensors. Nothing it delivers
 * is uploaded.
 */
function driveOptions(): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.High,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: false,
  }
}

async function locationSessionRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false)
}

async function stopLocationSession(): Promise<void> {
  if (await locationSessionRunning()) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => undefined)
    logTracker("session stopped")
  }
}

/**
 * Builds before 1.3.4 left a location request running between asks, and a
 * fence around wherever the phone last parked. Both outlive an update: the
 * OS holds them for the app, and expo restores them at boot. The Android
 * side takes back what its own receivers had asked Play Services for.
 */
async function forgetLegacy(): Promise<void> {
  const ownSession =
    Platform.OS === "ios" && (watchedNow() || useTrackingStore.getState().driveSince != null)
  if (!ownSession) await stopLocationSession()
  if (await Location.hasStartedGeofencingAsync(LEGACY_GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(LEGACY_GEOFENCE_TASK).catch(() => undefined)
    logTracker("legacy fence stopped")
  }
}

export type ForegroundServiceStatus = native.ServiceStatus | "unknown"

/** What the last read of the service said, for the log header. */
let lastServiceStatus: ForegroundServiceStatus = "unknown"

/** Whether the native side has Android's transport: the push handler, the service and the queue. */
function androidNative(): boolean {
  return Platform.OS === "android" && native.nativeTrackerAvailable
}

/**
 * The health report the app sends when it opens, handed in by the app since
 * the report reads the tracker. Called with the app closed when the tracker
 * notices something the family should hear about.
 */
let healthReporter: (() => Promise<void>) | null = null

export function setHealthReporter(report: () => Promise<void>): void {
  healthReporter = report
}

async function tellHealth(): Promise<void> {
  await healthReporter?.().catch(() => undefined)
}

/**
 * Location switched off, or iOS's "change to While Using" taken, with the app
 * closed. Read and told, never acted on. A tracker stopped here would stay
 * off once Location came back on, until somebody opened the app.
 */
async function checkStatusInBackground(): Promise<void> {
  if (AppState.currentState === "active") return
  const store = useTrackingStore.getState()
  const permission = await currentPermission().catch(() => store.permission)
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => true)
  store.setPermission(permission)
  store.setServicesEnabled(servicesEnabled)
  await tellHealth()
}

/**
 * The phone's own line to the server, held while somebody has the app open
 * and, on iOS, for a Live window, whose session keeps the process alive. An
 * ask that comes down it is answered within a second. A phone not open is
 * reached by silent push, which needs nothing held open.
 */
function syncControl(): void {
  const live = Platform.OS === "ios" && watchedNow()
  control.setWanted(sharingOn() && (AppState.currentState === "active" || live))
}

AppState.addEventListener("change", () => syncControl())

/**
 * What the push handler acts on without this side: whether sharing is on,
 * and where to send. Written at every start and stop, and at every boot,
 * so an install upgraded under a phone has it before the next ping.
 */
function nativeState(): native.NativeTrackerState {
  const on = sharingOn()
  return { enabled: on, mode: on ? "on" : "off", crashDetection: on && crashDetectionWanted() }
}

async function syncNativeState(): Promise<void> {
  if (!androidNative()) return
  await native.setTrackerState(nativeState()).catch(() => undefined)
  await syncUploader()
}

// A circle turning crash alerts on or off reaches the receiver at once, and
// a drive under way for the last one to want them ends.
useSettingsStore.subscribe((state, previous) => {
  if (state.incidentDetection === previous.incidentDetection) return
  void syncNativeState()
  if (!state.incidentDetection) void finishDrive("crash alerts off")
})

/**
 * Where the native side sends, and the session's upload key to send with,
 * so a ping or a Live request is answered without this side. Only while
 * sharing is on, and only once the server has handed out a key. A session
 * from before keys has none, and the phone answers from here.
 */
async function syncUploader(): Promise<void> {
  if (!androidNative()) return
  const key = tokenVault.peek()?.uploadKey
  let url: string | null = null
  try {
    url = api.url("/locations/batch")
  } catch {
    url = null
  }
  if (sharingOn() && key && url) await native.setUploader(url, key)
  else await native.clearUploader()
}

// A rotation can bring the first key a session has, after an update.
tokenListeners.add(() => void syncUploader())

/**
 * When this phone last took a window from an ask, and whether this process
 * has put Live in place for it. A reply to an upload sent before the ask is
 * older news than the ask, and a hold on a window already live changes when
 * it ends and nothing else.
 */
let windowTakenAt = 0
let liveInPlace = false

/**
 * Somebody opened Live on this phone's owner. The phone goes live for the
 * window, and the window ends by the clock, by the first fix past it, and
 * when the server says nobody is watching any more, whichever comes first.
 * The page holds its window with an ask a minute, and one for a window
 * already live only moves the end.
 */
export async function enterWatched(
  seconds: number,
  { push = false }: { push?: boolean } = {},
): Promise<void> {
  const store = useTrackingStore.getState()
  if (!sharingOn()) return
  if (seconds <= 0) {
    await endWatch("ended")
    return
  }
  windowTakenAt = Date.now()
  const until = new Date(Date.now() + seconds * 1000).toISOString()
  const already = liveInPlace && watchedNow()
  store.setWatchedUntil(until)
  armWatchTimer()
  syncControl()
  if (!already) logTracker("watched", { seconds, ...(push ? { push } : {}) })
  liveInPlace = true
  if (androidNative()) {
    // The service holds the window and follows the server's answers. One
    // the push handler already started takes this as the same window.
    if (await native.answersNatively()) {
      if (!(await native.watch(seconds)) && !already) await wakeFix()
      return
    }
    // No key, so no Live from this side either: a background app's timers
    // stop, and the stream with them. The one fix it can send, it sends.
    if (!already) await wakeFix()
    return
  }
  if (already && (await locationSessionRunning())) return
  try {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, liveOptions())
    lastServiceStatus = "running"
  } catch (error) {
    logTracker("live refused", { error: (error as Error).message })
    await wakeFix()
  }
}

/**
 * The upload reply says until when somebody has this phone's owner's page
 * open. The window is measured against the server's own clock, since the
 * phone's may be minutes out. A window already held is moved, never
 * started again, and a reply that names no window, or a shorter one, means
 * the viewers who held it have gone. Only a reply to an upload sent after
 * the last ask can say that.
 */
const WATCH_EXTEND_MIN_MS = 5_000

async function adoptWatch(
  until: string | null | undefined,
  serverTime?: string,
  sentAt = Date.now(),
): Promise<void> {
  const store = useTrackingStore.getState()
  const held = store.watchedUntil ? Date.parse(store.watchedUntil) : null
  const holding = held != null && held > Date.now()
  const current = sentAt > windowTakenAt
  if (!until) {
    if (holding && current) await endWatch("released")
    return
  }
  const serverNow = serverTime ? Date.parse(serverTime) : NaN
  const remainingMs = Date.parse(until) - (Number.isFinite(serverNow) ? serverNow : Date.now())
  if (!(remainingMs > 0)) {
    if (holding && current) await endWatch("released")
    return
  }
  if (holding) {
    // Every reply in a window names the same end, which lands a few
    // milliseconds either side of the one held once the round trip is
    // counted. Only a viewer asking again, or leaving, moves it.
    const ends = Date.now() + remainingMs
    const later = ends - held > WATCH_EXTEND_MIN_MS
    const sooner = held - ends > WATCH_EXTEND_MIN_MS && current
    if (later || sooner) {
      logTracker("watch adopted", { remaining: Math.round(remainingMs / 1000), held: true })
      store.setWatchedUntil(new Date(ends).toISOString())
      armWatchTimer()
    }
    return
  }
  logTracker("watch adopted", { remaining: Math.round(remainingMs / 1000), held: false })
  await enterWatched(Math.ceil(remainingMs / 1000))
}

/** True while somebody is watching. */
function watchedNow(): boolean {
  const { watchedUntil } = useTrackingStore.getState()
  return watchedUntil != null && Date.parse(watchedUntil) > Date.now()
}

let watchTimer: ReturnType<typeof setTimeout> | null = null

function armWatchTimer(): void {
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  const { watchedUntil } = useTrackingStore.getState()
  if (!watchedUntil) return
  // A second past the end, so the timer never finds the window still open.
  const delay = Math.max(0, Date.parse(watchedUntil) - Date.now()) + 1_000
  watchTimer = setTimeout(() => {
    watchTimer = null
    void endWatchIfOver()
  }, delay)
}

async function endWatchIfOver(): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.watchedUntil || watchedNow()) return
  await endWatch("over")
}

async function endWatch(
  why: "over" | "ended" | "released",
  { native: fromNative = false }: { native?: boolean } = {},
): Promise<void> {
  const store = useTrackingStore.getState()
  liveInPlace = false
  liveTimeouts = 0
  if (!store.watchedUntil) return
  store.setWatchedUntil(null)
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  logLiveTally()
  logTracker("watch over", {
    ...(why === "over" ? {} : { why }),
    ...(fromNative ? { native: true } : {}),
  })
  syncControl()
  // The service follows the server's answers and its own clock, so only a
  // viewer leaving is passed on. A timer here running ahead of an answer
  // not yet drained must not end a watch the server still holds.
  if (androidNative()) {
    if (why === "ended" && !fromNative) await native.endWatch()
    return
  }
  // A drive under the watch goes back to its own session.
  if (store.driveSince && crashDetectionWanted()) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, driveOptions()).catch(
      () => undefined,
    )
    return
  }
  await stopLocationSession()
  lastServiceStatus = "none"
}

/** Whether the native side answers a ping or a watch on this phone, with its own upload. */
export async function answeredNatively(): Promise<boolean> {
  return androidNative() && (await native.answersNatively())
}

/**
 * A ping from a push. The native service has already answered it where it
 * can, and what it sent is in the queue to learn from. Otherwise the fix
 * is taken from here.
 */
export async function answerWake({ ping = false }: { ping?: boolean } = {}): Promise<void> {
  if (await answeredNatively()) {
    await processNativeQueue()
    return
  }
  await wakeFix({ ping })
}

/**
 * The answer to a ping or a nudge. The server's ping, to a phone the motion
 * sensor has had lying still since its last fix, is answered with that fix
 * and no location. Anything else, and anything somebody asked for, is one
 * Wi-Fi grade fix. On Android the brief service carries it, since a
 * background app without one is held to a few fixes an hour. A phone on
 * Live has its next fix a second away and takes no other, and one on a
 * drive answers with the drive's own.
 */
export async function wakeFix({
  ping = false,
}: { ping?: boolean } = {}): Promise<LocationFixInput | null> {
  if (!sharingOn()) return null
  if (Platform.OS === "ios" && watchedNow() && (await locationSessionRunning())) return null
  // The heartbeat's fix is on its way, and it answers the ask too.
  if (acquisitionInFlight()) return null
  // What the classifier said is in the native queue until it is read.
  if (androidNative()) await processNativeQueue()
  if (ping && (await stillSinceLastFix())) {
    logTracker("wake", { still: true })
    // The push handler brought the brief service up for a session with no
    // key before this side could decide; no fix is coming for it.
    if (androidNative()) await native.stopBrief()
    return repeatLastFix()
  }
  const onDrive = useTrackingStore.getState().driveSince != null
  if (
    onDrive &&
    lastDriveFix &&
    Date.now() - Date.parse(lastDriveFix.recordedAt) < DRIVE_FIX_FRESH_MS
  ) {
    const fix = { ...lastDriveFix, source: "nudge" as const }
    useTrackingStore.getState().enqueue([fix])
    logTracker("wake", { drive: true })
    await flush()
    return fix
  }
  await considerDrive()
  logTracker("wake")
  // An app on screen may take its fix without the service, and the service
  // would only put "Updating your location" over it.
  if (!androidNative() || AppState.currentState === "active") {
    return reportNow("nudge", Location.Accuracy.Balanced)
  }
  // A push starts the service natively before this runs, and starting it
  // again is a no-op. reportNow has its own deadline, so a fix that never
  // settles cannot leave the service up, and the service stops itself
  // after the same deadline regardless.
  await native.startBrief()
  try {
    return await reportNow("nudge", Location.Accuracy.Balanced)
  } finally {
    await native.stopBrief()
  }
}

/**
 * Permission and the OS location switch can both change while the app is in
 * the background, and nothing told us. Without re-reading them on the way back
 * the app keeps claiming to share a location it can no longer read, and once
 * they are put right it keeps sharing nothing with the switch still on.
 */
export async function refreshLocationStatus(): Promise<{
  permission: PermissionLevel
  servicesEnabled: boolean
}> {
  const store = useTrackingStore.getState()
  const permission = await currentPermission()
  store.setPermission(permission)

  let servicesEnabled = true
  try {
    servicesEnabled = await Location.hasServicesEnabledAsync()
  } catch {
    // Treat an unreadable switch as on rather than nagging about a state we
    // could not confirm.
  }
  store.setServicesEnabled(servicesEnabled)

  // A phone allowed only "while using" cannot answer a ping in the
  // background at all, so tracking stays off until Always is granted, as
  // startTracking already decides.
  if (store.enabled && store.mode !== "off" && (permission !== "always" || !servicesEnabled)) {
    await stopTracking()
  } else if (permission === "always" && servicesEnabled && shouldBeTracking()) {
    logTracker("resumed")
    await startTracking()
  }

  return { permission, servicesEnabled }
}

/**
 * Off with the switch on, after a session ended and a new one began, a
 * change of server, or a permission put right in Settings. Without this
 * only a cold start brings the tracker back from any of them.
 */
function shouldBeTracking(): boolean {
  const { enabled, mode, uploadsRefusedAt } = useTrackingStore.getState()
  return (
    enabled && mode === "off" && !uploadsRefusedAt && useAuthStore.getState().status === "signed_in"
  )
}

// A sign-in, not the boot that finds a session already there, which the
// launch path answers itself.
useAuthStore.subscribe((state, previous) => {
  if (state.status !== "signed_in") return
  if (previous.status === "signed_in" || previous.status === "booting") return
  void refreshLocationStatus()
    .then(() => tellHealth())
    .catch(() => undefined)
})

let starting: Promise<boolean> | null = null

/**
 * Foreground permission is enough to start, but only "always" lets the
 * phone answer a ping. One start at a time: the app coming back, a sign-in
 * and the switch can ask in the same moment.
 */
export function startTracking(): Promise<boolean> {
  starting ??= beginTracking().finally(() => {
    starting = null
  })
  return starting
}

async function beginTracking(): Promise<boolean> {
  const permission = await currentPermission()
  const store = useTrackingStore.getState()
  store.setPermission(permission)
  // "While using" cannot answer a ping with the app closed, and the
  // checklist asks for Always until it is granted.
  if (permission !== "always") return false

  const was = store.mode
  store.setMode("on")
  await forgetLegacy()
  await syncNativeState()
  // A window somebody was watching may have run out while the app was away,
  // and one still open is picked back up.
  if (store.watchedUntil && !watchedNow()) store.setWatchedUntil(null)
  else if (watchedNow()) {
    armWatchTimer()
    if (Platform.OS === "ios" && !(await locationSessionRunning())) {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, liveOptions()).catch(
        () => undefined,
      )
    }
  }
  // A drive under way when the process went is picked back up, if it is
  // still going: on Android only the service knows, and on an iPhone Core
  // Motion's newest word has to agree. One with no circle left to run for
  // is let go.
  if (store.driveSince) await resumeDrive()
  await startMotionWatch()
  await registerBackgroundSync()
  store.setBackgroundActive(true)
  syncControl()
  if (was === "off") logTracker("on")
  // What the native side sent while this process was down comes first, so
  // the heartbeat does not take a fix for a ping already answered.
  await processNativeQueue()
  startForegroundHeartbeat()
  return true
}

export async function stopTracking(): Promise<void> {
  logLiveTally()
  logTracker("off")
  stopForegroundHeartbeat()
  clearRetry()
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  liveInPlace = false
  const store = useTrackingStore.getState()
  // Off first, so a ping or a watch still in flight lands on "off" and
  // starts nothing after this.
  store.setMode("off")
  store.setWatchedUntil(null)
  syncControl()
  await finishDrive("off")
  lastDriveFix = null
  await stopMotionWatch()
  await syncNativeState()
  if (androidNative()) {
    await native.stopService()
    await native.clearQueue().catch(() => undefined)
  }
  await stopLocationSession()
  store.setBackgroundActive(false)
  // Sign-out, a server change and a deleted account all land here, and none of
  // them turn the master switch off, so the sync had nothing left to stop it.
  // startTracking registers it again, and that is the only way back from "off".
  await unregisterBackgroundSync()
}

export async function registerBackgroundSync(): Promise<void> {
  if (Platform.OS === "web") return
  try {
    const status = await BackgroundTask.getStatusAsync()
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return
    const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)
    if (!registered) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 15 })
    }
  } catch {
    // The pings come either way. This only covers for them going missing.
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  if (Platform.OS === "web") return
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK)
    }
  } catch {
    // Same as registering. A sync we could not cancel is caught by the mode
    // gate in the task body instead.
  }
}

export async function resumeIfEnabled(): Promise<void> {
  const { enabled } = useTrackingStore.getState()
  const permission = await currentPermission()
  useTrackingStore.getState().setPermission(permission)
  if (enabled && permission === "always") {
    await startTracking()
  }
  void flush()
}

/**
 * Whether the service is up, as the native side reports it. "unknown" is
 * iOS, where there is no service. For the log header.
 */
async function readServiceStatus(): Promise<void> {
  if (!androidNative()) return
  try {
    lastServiceStatus = await native.serviceStatus()
  } catch {
    lastServiceStatus = "unknown"
  }
}

/**
 * What a shared log opens with: the tracker's beliefs at the moment of
 * sharing, which the lines below cannot always be read back to.
 */
export function headerForTrackerLog(): string {
  void readServiceStatus()
  const {
    mode,
    queue,
    lastError,
    permission,
    preciseLocation,
    policy,
    watchedUntil,
    enabled,
    uploadsRefusedAt,
  } = useTrackingStore.getState()
  return [
    `mode ${mode}${enabled ? "" : " (sharing off)"}`,
    `ping every ${policy.minUpdateIntervalSeconds} s`,
    `queue ${queue.length}`,
    `uploads ${uploadsRefusedAt ? `refused since ${uploadsRefusedAt}` : "accepted"}`,
    `lastError ${lastError ?? "none"}`,
    `permission ${permission}`,
    `location ${preciseLocation ? "precise" : "approximate"}`,
    `service ${lastServiceStatus}`,
    `watched ${watchedUntil ?? "no"}`,
    `platform ${Platform.OS}`,
  ].join("\n")
}

setTrackerLogHeader(headerForTrackerLog)

// A process the OS started for a background event runs this module before
// anything else. The log records which kind of launch it was.
{
  const { enabled, mode, queue } = useTrackingStore.getState()
  logTracker("boot", {
    headless: AppState.currentState !== "active",
    mode,
    enabled,
    queued: queue.length,
  })
  // And the channel: the first try runs before the keychain has handed over
  // the tokens, so it is made again once it has.
  syncControl()
  void tokenVault.hydrate().then(syncControl)
  // Whatever the native side did while this process was down is the first
  // thing this one deals with, and every poke after is dealt with the same way.
  native.onNativeQueue(() => void processNativeQueue())
  if (enabled && mode !== "off") {
    void syncNativeState().then(() => processNativeQueue())
  }
}
