import { AppState, Platform } from "react-native"
import * as BackgroundTask from "expo-background-task"
import * as Battery from "expo-battery"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {
  DEFAULTS,
  haversineMeters,
  type ActivityType,
  type LocationFixInput,
  type LocationSource,
} from "@hearth/shared"

import { translate } from "@/i18n/translate"
import { ApiError, endpoints } from "@/services/api"
import { presentIncidentAlarm } from "@/services/incidentAlarm"
import { useAuthStore } from "@/stores/auth"
import {
  startMotion,
  stopMotion,
  type MotionActivity,
  type MotionSource,
} from "@/services/location/motion"
import { startDriveSensors, stopDriveSensors } from "@/services/location/driveSensors"
import { useIncidentStore } from "@/stores/incident"
import { useSettingsStore } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { control, setControlHandler } from "@/services/location/control"
import { logTracker, setTrackerLogHeader } from "@/services/location/log"
import * as native from "@/services/location/nativeTracker"
import { crossesPlace, knownPlaces, usePlacesStore } from "@/stores/places"
import { useTrackingStore, type PermissionLevel, type TrackingPolicy } from "@/stores/tracking"

export const BACKGROUND_LOCATION_TASK = "hearth-background-location"
/** Must match BGTaskSchedulerPermittedIdentifiers in app.json. */
export const BACKGROUND_SYNC_TASK = "com.binary.rewind.hearth.sync"
/** Armed around wherever the phone stopped, so leaving wakes us back up. */
export const STATIONARY_GEOFENCE_TASK = "hearth-stationary-geofence"
/** The same fence on Android, where the native side arms it and names it. */
export const STATIONARY_FENCE_ID = "stationary"
/** The React Native headless task Android runs to drain the native queue; registered in index.tsx. */
export const HEADLESS_TASK = "HearthTracker"

const MAX_BATCH = 200
const STALE_FIX_MS = 15 * 60 * 1000
/**
 * How often a parked phone says it is still there. The server calls a phone
 * offline after an hour of silence, so this leaves it four chances.
 */
export const RESTING_HEARTBEAT_MS = 15 * 60 * 1000

/**
 * The GPS runs in exactly one state: a drive. Everywhere else a Wi-Fi grade
 * fix is enough, and it is the only way a phone gets through a day. Speed and
 * heading only come from GPS at all, so without this tier the map showed a
 * driver a hundred metres off the road and their speed as noise.
 */
export const DRIVING_INTERVAL_MS = 10_000
/** Speed that reads as a vehicle whatever the classifier says, for phones without motion. */
export const DRIVING_SPEED_MPS = 6
/** Under this for long enough the drive is over even if the classifier is quiet. */
const DRIVING_STOP_SPEED_MPS = 1.5
const DRIVING_STOP_AFTER_MS = 3 * 60 * 1000

/**
 * The OS classifier is more certain than a distance heuristic, so it can call
 * a stop sooner than STILL_AFTER_MS of watching the phone not move.
 */
const MOTION_STILL_CONFIRM_MS = 90_000
const MOTION_MIN_CONFIDENCE = 50
/** Below this a sampled verdict is a guess, and a guess of "in a car" on a parked phone is confirmed first. */
const MOTION_SURE_CONFIDENCE = 75

/**
 * A stop is called from a small circle the phone has not left for a few
 * minutes. What drains the battery is the GPS behind a drive, not the
 * request itself, so the parked request stays registered at Wi-Fi grade and
 * an OS geofence, which rides on the location the system computes anyway,
 * is one of the things that bring the full tier back.
 */
const STILL_RADIUS_METERS = 60
/**
 * A fix looser than this says nothing about whether the phone moved: a cell
 * tower's idea of where you are can be a kilometre off. The server's
 * geofences draw the same line.
 */
const STILL_MAX_ACCURACY_METERS = DEFAULTS.geofenceMaxAccuracyMeters
const STILL_AFTER_MS = 5 * 60 * 1000
/** At or under this a fix came from GPS; above it, from Wi-Fi or a cell. */
const GPS_CLASS_ACCURACY_METERS = 30

/**
 * The live tier, for as long as somebody is watching: a fix a second, every
 * one uploaded, which is what a family looking at a moving dot expects of
 * "live". The window is ten minutes, so the cost is bounded by the watching.
 */
const LIVE_INTERVAL_MS = 1_000
/** A fix older than this is not "now" to somebody who has just opened the app. */
const FOREGROUND_MAX_AGE_MS = 10_000
/**
 * Android's getCurrentPositionAsync has no timeout of its own, and a request
 * a background app makes can hang for the life of the process. Every one-shot
 * fix waits this long and no longer.
 */
const WAKE_FIX_TIMEOUT_MS = 30_000
/** iOS gives an app refresh task about thirty seconds, so its fixes get half. */
const SYNC_FIX_TIMEOUT_MS = 15_000
/** The OS's last fix may stand in for one that never came while it is this fresh. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60 * 1000
/**
 * A fresh request answered with a fix older than this was answered from the
 * OS's cache, and is asked again. The server never moves presence back in
 * time, so an app opened after hours away would otherwise leave the row
 * saying "two hours ago, at home".
 */
const FRESH_FIX_MAX_AGE_MS = 60 * 1000
/** Bigger than the still radius so GPS jitter at a standstill cannot trip it. */
const STATIONARY_GEOFENCE_RADIUS_METERS = 150
/**
 * iOS does not reliably report an exit from a region much under this, so a
 * tighter fence there can simply never fire and the phone rests into the
 * first minutes of a drive. Android's fences are fine at the floor above.
 */
const IOS_GEOFENCE_MIN_METERS = 200

/**
 * A phone is on a journey, and a still verdict at the lights is not a stop,
 * while it has gone this far in the last ten minutes or done walking pace
 * within the last three. The classifier alone then cannot park it; the
 * position has to agree, see onMotion.
 */
const JOURNEY_WINDOW_MS = 10 * 60 * 1000
const JOURNEY_DISTANCE_METERS = 400
const JOURNEY_SPEED_WINDOW_MS = 3 * 60 * 1000
const JOURNEY_SPEED_MPS = 3

/** A failed upload tries again on this ladder, then waits for the next delivery. */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]
/** How long a service found dead stays on the health report. */
const SERVICE_DEATH_MEMORY_MS = 24 * 60 * 60 * 1000

/**
 * The OS withholds any fix closer to the last one it delivered than the
 * distance filter, so a still radius at or below that filter only ever sees
 * fixes it has to read as movement and a stop never settles from the location
 * path at all. A circle may set the filter far above the floor here, so the
 * radius follows it up.
 */
export function stillRadiusMeters(policy: TrackingPolicy): number {
  return Math.max(STILL_RADIUS_METERS, policy.distanceFilterMeters * 1.5)
}

/** Keeps the fence clear of the still radius when a wide filter widens that. */
export function stationaryRadiusMeters(policy: TrackingPolicy): number {
  const floor = Platform.OS === "ios" ? IOS_GEOFENCE_MIN_METERS : STATIONARY_GEOFENCE_RADIUS_METERS
  return Math.max(floor, stillRadiusMeters(policy) * 1.5)
}

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
  activity: ActivityType = currentActivity(),
): LocationFixInput {
  const c = location.coords
  // iOS reports a negative accuracy to mean "this component is invalid",
  // which is routine for altitude on a Wi-Fi or cell derived fix. The server
  // would reject the whole batch over it.
  const accuracy = c.accuracy != null && c.accuracy >= 0 ? c.accuracy : null
  return {
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
    // What the phone is doing, as the tracker knows it, so the family sees a
    // car for a drive and the server knows a still phone is meant to be
    // quiet. Speed alone read a parked phone as "still" and a Wi-Fi jump as
    // walking.
    activity,
    source,
  }
}

/**
 * Android hands over 0 for a speed it never measured, where iOS says -1, and
 * a Wi-Fi or cell fix never measures one. Read as a real zero, every network
 * fix on Android was a car that had stopped: the derived speed never ran,
 * the speed rule never started a drive, and a run of them under a flyover
 * ended one. A zero on a GPS fix is a real stop and stays.
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

/** The tracker's own verdict on what the phone is doing right now. */
export function currentActivity(): ActivityType {
  const { mode, driving, lastVerdict } = useTrackingStore.getState()
  if (mode === "stationary") return "still"
  if (driving) return "driving"
  if (lastVerdict === "walking" || lastVerdict === "running" || lastVerdict === "cycling") {
    return lastVerdict
  }
  return "unknown"
}

/**
 * The OS already applies a distance filter, but iOS emits bursts of
 * near-identical samples on wake. Thinning here saves battery and bandwidth
 * without losing the shape of a journey.
 */
export function thin(
  fixes: LocationFixInput[],
  previous: LocationFixInput | null,
  policy: TrackingPolicy,
  gateMeters = 0,
) {
  const kept: LocationFixInput[] = []
  let last = previous
  for (const fix of fixes) {
    if (last) {
      const dt = Date.parse(fix.recordedAt) - Date.parse(last.recordedAt)
      const moved = haversineMeters(
        { lat: last.lat, lon: last.lon },
        { lat: fix.lat, lon: fix.lon },
      )
      const halfInterval = (policy.minUpdateIntervalSeconds * 1000) / 2
      if (
        dt < halfInterval &&
        moved < policy.distanceFilterMeters / 2 &&
        fix.source !== "manual" &&
        fix.source !== "sos"
      ) {
        continue
      }
      // The circle's distance filter, applied here rather than by the OS on
      // Android, so the fixes a still phone keeps delivering can be judged
      // for the stop without being uploaded. One still gets through every
      // STILL_AFTER_MS, which is a phone that has stopped and not yet been
      // called stopped.
      if (
        gateMeters > 0 &&
        fix.source === "background" &&
        moved < gateMeters &&
        dt < STILL_AFTER_MS
      ) {
        continue
      }
    }
    kept.push(fix)
    last = fix
  }
  return kept
}

let flushing: Promise<void> | null = null
let flushAgain = false

/**
 * Network failures leave the queue intact for the next attempt. A 4xx that is
 * not an auth problem means the batch itself is bad, so it gets dropped. One
 * poison fix must not wedge the pipeline forever.
 *
 * Single flight, and a call that lands while one is running asks for one more
 * pass after it, so a fix enqueued as the loop was ending is not left waiting
 * for the next delivery.
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
  })
  return flushing
}

async function doFlush(): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled) return
  if (!useAuthStore.getState().serverUrl) return
  if (useTrackingStore.getState().queue.length === 0) return
  if (!(await tokenVault.hydrate())) return

  while (useTrackingStore.getState().queue.length > 0) {
    const batch = useTrackingStore.getState().queue.slice(0, MAX_BATCH)
    try {
      const result = await endpoints.locations.upload(batch)
      useTrackingStore.getState().dequeue(batch)
      useTrackingStore.getState().recordUpload(result.accepted)
      clearRetry()
      logTracker("flush", {
        sent: batch.length,
        accepted: result.accepted,
        queued: useTrackingStore.getState().queue.length,
      })
      void adoptWatch(result.watchedUntil, result.serverTime)
      if (
        result.policy.minUpdateIntervalSeconds !== store.policy.minUpdateIntervalSeconds ||
        result.policy.distanceFilterMeters !== store.policy.distanceFilterMeters
      ) {
        useTrackingStore.getState().setPolicy(result.policy)
        void applyPolicy()
      }
    } catch (error) {
      const queued = useTrackingStore.getState().queue.length
      if (error instanceof ApiError) {
        if (error.isNetwork || error.status >= 500 || error.status === 429) {
          useTrackingStore.getState().setError(error.message)
          logTracker("flush failed", { status: error.isNetwork ? "network" : error.status, queued })
          scheduleRetry()
          return
        }
        if (error.status === 401) {
          useTrackingStore.getState().setError("Signed out. Sharing paused.")
          logTracker("flush failed", { status: 401, queued })
          return
        }
        // Validation or permission failure, so this batch will never succeed.
        useTrackingStore.getState().dequeue(batch)
        useTrackingStore.getState().setError(error.message)
        logTracker("flush failed", { status: error.status, dropped: batch.length, queued })
        continue
      }
      useTrackingStore.getState().setError((error as Error).message)
      logTracker("flush failed", { status: "error", error: (error as Error).message, queued })
      scheduleRetry()
      return
    }
  }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0

/**
 * On a parked phone the next delivery is a quarter of an hour off at best, so
 * a failed upload retries on a short ladder that covers a network away for a
 * moment. It is bounded, so a phone with no coverage does not spend its
 * battery hammering, and an upload that gets through starts it over.
 */
function scheduleRetry(): void {
  if (retryTimer) return
  const delay = RETRY_DELAYS_MS[retryAttempt]
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
 * The last ten minutes of what the OS delivered, kept or not, for the
 * journey test in onMotion. In memory only: the process now stays up on
 * both platforms, and after a kill the position evidence stands on its own.
 */
interface RecentFix {
  at: number
  lat: number
  lon: number
  accuracyMeters: number | null
  speedMps: number | null
}
let recentFixes: RecentFix[] = []

function rememberFixes(fixes: LocationFixInput[]): void {
  const cutoff = Date.now() - JOURNEY_WINDOW_MS
  for (const fix of fixes) {
    recentFixes.push({
      at: Date.parse(fix.recordedAt),
      lat: fix.lat,
      lon: fix.lon,
      accuracyMeters: fix.accuracyMeters ?? null,
      speedMps: fix.speedMps ?? null,
    })
  }
  recentFixes = recentFixes.filter((fix) => fix.at >= cutoff)
}

/** Whether the fixes of the last few minutes describe a phone going somewhere. */
function inJourney(): boolean {
  const now = Date.now()
  const recent = recentFixes.filter((fix) => now - fix.at <= JOURNEY_WINDOW_MS)
  const newest = recent[recent.length - 1]
  if (!newest) return false
  const travelled = recent.some((fix) => clearOf(newest, fix, JOURNEY_DISTANCE_METERS))
  const fast = recent.some(
    (fix) =>
      now - fix.at <= JOURNEY_SPEED_WINDOW_MS &&
      fix.speedMps != null &&
      fix.speedMps >= JOURNEY_SPEED_MPS,
  )
  return travelled || fast
}

export async function ingest(locations: Location.LocationObject[], source: LocationSource) {
  if (locations.length === 0) return
  const battery = await batterySnapshot()
  const state = useTrackingStore.getState()
  const all = locations.map((location) => toFix(location, source, battery))
  const newest = all[all.length - 1]!
  if (source === "background" || source === "significant") rememberFixes(all)
  const live = watchedNow()
  // The tier's distance filter, applied to what is uploaded rather than by
  // the OS on Android, so the fixes keep coming while the phone is still
  // and the stop can be judged from them. Live means every fix, at the live
  // tier's own pace rather than the circle's, since the thinning below is
  // measured against the interval it is handed.
  const gate =
    state.mode !== "moving" || live
      ? 0
      : state.driving
        ? state.driving.distance
        : state.policy.distanceFilterMeters
  const pace = live
    ? { ...state.policy, minUpdateIntervalSeconds: LIVE_INTERVAL_MS / 1000 }
    : state.policy
  let fixes = thin(all, state.lastFix, pace, gate)
  if (source === "background" && state.mode === "stationary") {
    fixes = await restingFixes(fixes.length > 0 ? fixes : [newest], live)
  }
  // Arriving somewhere the family named is the moment they want to hear
  // about, so the fix that crosses the circle goes at once, whatever the gate.
  const crossed = !fixes.includes(newest) && crossesPlace(state.lastFix, newest, knownPlaces())
  if (crossed) fixes = [...fixes, newest]
  if (fixes.length > 0) state.enqueue(fixes)
  if (crossed) {
    logTracker("place crossed", { acc: Math.round(newest.accuracyMeters ?? -1) })
    void flush()
  }
  if (source === "background") {
    logTracker("fixes", {
      got: all.length,
      kept: fixes.length,
      mode: state.mode,
      acc: Math.round(newest.accuracyMeters ?? -1),
      speed: newest.speedMps == null ? null : Number(newest.speedMps.toFixed(1)),
    })
  }
  if (source === "background") {
    // From the fix itself, not from what was kept: a still phone's fixes are
    // exactly the ones the gate drops and exactly the ones that say it is
    // still. The drive is judged first, so the fix that ends one is also
    // the fix that starts the stop.
    if (useTrackingStore.getState().mode === "moving") {
      await trackDriveBySpeed(withDerivedSpeed(newest, state.lastFix))
    }
    await evaluateStillness(newest)
    // A fix arriving is the clock's "not still yet"; the stop is judged from
    // how long they stop coming.
    armBackgroundClock()
    // The live tier delivers every few seconds, so the first fix past the
    // window is what steps it back down, whether or not the timer got there.
    await endWatchIfOver()
  }
  // Whether or not this delivery kept a fix: the queue may hold an upload
  // that failed, and on a parked phone the next kept fix is a quarter hour off.
  await flush()
}

/**
 * The resting watch is cheap but not quiet: iOS in particular hands over a
 * new estimate whenever the Wi-Fi picture shifts. One fix per heartbeat is
 * all the server needs while the phone stays put, unless somebody is
 * watching, when every fix is news. A fix outside the circle means the phone
 * left and the fence never said so, which Android's fences do after the
 * process is killed, so that one goes through and brings the full tier back.
 */
async function restingFixes(fixes: LocationFixInput[], live: boolean): Promise<LocationFixInput[]> {
  const { stillAnchor, lastFix, policy } = useTrackingStore.getState()
  const radius = stationaryRadiusMeters(policy)
  const left = fixes.find((fix) => stillAnchor && clearOf(stillAnchor, fix, radius))
  if (left) {
    await enterMoving()
    return fixes.slice(fixes.indexOf(left))
  }
  if (live) return fixes
  const newest = fixes[fixes.length - 1]
  if (!newest) return []
  const age = lastFix ? Date.parse(newest.recordedAt) - Date.parse(lastFix.recordedAt) : Infinity
  return age >= RESTING_HEARTBEAT_MS ? [newest] : []
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
 * will do where the caller says so: a wake wants to know the phone is alive
 * more than it wants a new estimate, while a fence check wants the truth
 * about right now and a stale fix inside the circle would re-park a phone
 * that has just left.
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
  /** Whether a fix clear of a parked phone's anchor ends the stop. Callers judging the same thing themselves pass false. */
  judge?: boolean
  /** Stamped on the fix instead of the tracker's current verdict. */
  activity?: ActivityType
  timeoutMs?: number
  /** Whether the OS's last fix may stand in when the fresh one is late. */
  lastKnown?: boolean
}

function sharingOn(): boolean {
  const { enabled, mode } = useTrackingStore.getState()
  return enabled && mode !== "off"
}

export async function reportNow(
  source: LocationSource = "manual",
  accuracy: Location.Accuracy = source === "sos"
    ? Location.Accuracy.Highest
    : Location.Accuracy.High,
  { judge = true, activity, timeoutMs = WAKE_FIX_TIMEOUT_MS, lastKnown = true }: ReportOptions = {},
): Promise<LocationFixInput | null> {
  // A check-in and an SOS are the person asking. Everything else is the
  // phone deciding, and a nudge still reaches it over the UI socket with
  // sharing off: a fix queued then would upload the day sharing comes back.
  const asked = source === "manual" || source === "sos"
  if (!asked && !sharingOn()) return null
  const owner = useAuthStore.getState().user?.id
  const started = Date.now()
  logTracker("report", { source, accuracy })
  acquisitionStarted(timeoutMs)
  try {
    const { location, cached } = await acquireFix(accuracy, timeoutMs, lastKnown)
    // A fix can take half a minute. Sharing may have gone off meanwhile, or
    // the account may have signed out and somebody else signed in.
    if (useAuthStore.getState().user?.id !== owner || (!asked && !sharingOn())) {
      logTracker("report dropped", { source })
      return null
    }
    const battery = await batterySnapshot()
    const fix = toFix(location, source, battery, activity)
    useTrackingStore.getState().enqueue([fix])
    logTracker("report done", {
      source,
      acc: Math.round(fix.accuracyMeters ?? -1),
      ms: Date.now() - started,
      age: Math.max(0, Math.round((Date.now() - location.timestamp) / 1000)),
      ...(cached ? { cached } : {}),
    })
    // A wake, a nudge or the app opening can be the first word from a phone
    // that drove off while its fence was forgotten. The fix says so. Callers
    // deciding the same thing with the same fix pass judge: false.
    const { mode, stillAnchor, policy } = useTrackingStore.getState()
    if (
      judge &&
      mode === "stationary" &&
      stillAnchor &&
      clearOf(stillAnchor, fix, stationaryRadiusMeters(policy))
    ) {
      await enterMoving()
    }
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
 * Nothing above refreshes the user's own row while they sit looking at the
 * map. The OS holds back every fix closer than the distance filter, a parked
 * phone asks for one a quarter hour, and the sync task never runs while the
 * app is open. So while it is open, and only then, ask for a fix at the
 * circle's interval whenever the last one is older than that.
 *
 * The mode is read and never written. A parked phone stays parked, fence and
 * anchor untouched, because one Balanced fix is far cheaper than bringing the
 * full tier back for a phone that has not moved.
 */
let heartbeat: ReturnType<typeof setTimeout> | null = null

export function startForegroundHeartbeat(): void {
  // Coming back after a while away is the moment the row reads stalest, and
  // a fix from twenty seconds ago does not count as now to somebody who has
  // just looked.
  void heartbeatTick(FOREGROUND_MAX_AGE_MS)
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
  const { policy } = useTrackingStore.getState()
  heartbeat = setTimeout(() => {
    scheduleHeartbeat()
    void heartbeatTick()
  }, policy.minUpdateIntervalSeconds * 1000)
}

const HEARTBEAT_FIX_TIMEOUT_MS = 30_000

async function heartbeatTick(maxAgeMs?: number): Promise<void> {
  const store = useTrackingStore.getState()
  if (AppState.currentState !== "active") return
  if (!store.enabled || store.mode === "off") return
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
  const age = store.lastFix ? Date.now() - Date.parse(store.lastFix.recordedAt) : Infinity
  if (age < (maxAgeMs ?? store.policy.minUpdateIntervalSeconds * 1000)) return

  acquisitionStarted(HEARTBEAT_FIX_TIMEOUT_MS)
  try {
    const { location } = await acquireFix(
      Location.Accuracy.Balanced,
      HEARTBEAT_FIX_TIMEOUT_MS,
      false,
    )
    const battery = await batterySnapshot()
    useTrackingStore.getState().enqueue([toFix(location, "heartbeat", battery)])
    await flush()
  } catch (error) {
    // Not reportNow, because that pins the failure on the You screen, and a
    // fix that times out indoors would repaint it red every interval.
    logTracker("report failed", { source: "heartbeat", error: (error as Error).message })
  } finally {
    acquisitionEnded()
  }
}

/**
 * iOS has nothing like WorkManager for a background app to lean on, and its
 * motion classifier speaks only when the activity changes, so "still for
 * ninety seconds" often never got its second reading. What iOS does have is
 * a process it keeps alive for as long as location updates run, and React
 * Native keeps a timer going in it. So this is, on iOS, the clock the sync
 * task is on Android. Moving, it asks for a fix once no update has come for
 * STILL_AFTER_MS, which is a phone that has not crossed the distance filter,
 * and judges the stop from it. Parked, it is the quarter hour heartbeat,
 * since the cell-only session delivers nothing while the estimate holds. It
 * stands down while the app is open, where the heartbeat does the asking.
 */
let backgroundClock: ReturnType<typeof setTimeout> | null = null

export function startBackgroundClock(): void {
  armBackgroundClock()
}

export function stopBackgroundClock(): void {
  if (backgroundClock) clearTimeout(backgroundClock)
  backgroundClock = null
}

function armBackgroundClock(): void {
  stopBackgroundClock()
  if (Platform.OS !== "ios") return
  const { enabled, mode } = useTrackingStore.getState()
  if (!enabled || mode === "off") return
  if (AppState.currentState === "active") return
  if (mode === "moving") {
    backgroundClock = setTimeout(() => {
      backgroundClock = null
      void backgroundClockTick()
    }, STILL_AFTER_MS)
    return
  }
  backgroundClock = setTimeout(() => {
    backgroundClock = null
    void restingHeartbeat()
  }, RESTING_HEARTBEAT_MS)
}

async function backgroundClockTick(): Promise<void> {
  const { enabled, mode } = useTrackingStore.getState()
  if (!enabled || mode === "off" || AppState.currentState === "active") return
  try {
    const { location: here } = await acquireFix(
      Location.Accuracy.Balanced,
      WAKE_FIX_TIMEOUT_MS,
      true,
    )
    // Five minutes without a fix in the driving tier is a car that has not
    // moved its distance filter in five minutes: it has parked, and the drive
    // is over before the fix is judged, or the stop could never be called.
    const last = useTrackingStore.getState().lastFix
    const point = {
      lat: here.coords.latitude,
      lon: here.coords.longitude,
      accuracyMeters: here.coords.accuracy,
    }
    const store = useTrackingStore.getState()
    const stillHere = last != null && !clearOf(last, point, stillRadiusMeters(store.policy))
    if (store.driving && stillHere) {
      await leaveDriving()
    }
    // Five minutes without a delivery is a phone that has not crossed the
    // filter since the last fix, so the stop is dated from that fix and the
    // fix below settles it rather than starting a second five minute wait.
    if (stillHere && last && store.mode === "moving") {
      store.setStillAnchor({ lat: last.lat, lon: last.lon, since: last.recordedAt })
    }
    // Through ingest so a moving phone is judged for the stop and a parked
    // one has its fix thinned and checked against the fence like any other.
    await ingest([here], "background")
  } catch (error) {
    logTracker("report failed", { source: "clock", error: (error as Error).message })
  }
  armBackgroundClock()
}

/**
 * The parked iPhone's quarter hour word. The cell-only session keeps the
 * process alive but delivers nothing while its estimate holds, so this reads
 * the fix the OS already has and sends it stamped still, dated now: the
 * phone has not left the fence, and "here, now" is what that means. A last
 * fix clear of the fence is a departure the session and the fence both
 * missed, and goes through ingest to end the stop.
 */
async function restingHeartbeat(): Promise<void> {
  const { enabled, mode, stillAnchor, policy } = useTrackingStore.getState()
  if (!enabled || mode !== "stationary" || AppState.currentState === "active") return
  try {
    const last = await Location.getLastKnownPositionAsync().catch(() => null)
    const here = last
      ? {
          lat: last.coords.latitude,
          lon: last.coords.longitude,
          accuracyMeters: last.coords.accuracy,
        }
      : null
    if (last && here && stillAnchor && clearOf(stillAnchor, here, stationaryRadiusMeters(policy))) {
      await ingest([last], "background")
      return
    }
    if (!last && !stillAnchor) return
    const battery = await batterySnapshot()
    const fix: LocationFixInput = last
      ? { ...toFix(last, "heartbeat", battery, "still"), recordedAt: new Date().toISOString() }
      : syntheticFix(stillAnchor!.lat, stillAnchor!.lon, "heartbeat", battery)
    useTrackingStore.getState().enqueue([fix])
    logTracker("heartbeat", { mode, acc: Math.round(fix.accuracyMeters ?? -1) })
    await flush()
  } finally {
    armBackgroundClock()
  }
}

function syntheticFix(
  lat: number,
  lon: number,
  source: LocationSource,
  battery: BatterySnapshot,
): LocationFixInput {
  return {
    recordedAt: new Date().toISOString(),
    lat,
    lon,
    accuracyMeters: null,
    altitudeMeters: null,
    altitudeAccuracyMeters: null,
    speedMps: null,
    headingDegrees: null,
    batteryLevel: battery.batteryLevel,
    isCharging: battery.isCharging,
    activity: "still",
    source,
  }
}

// The channel does not import the tracker, so the tracker hands it what to
// call. At module scope for the same reason as the tasks below.
setControlHandler({
  watch: (seconds) => enterWatched(seconds),
  wake: async () => {
    await wakeFix()
  },
})

// defineTask has to run at module scope. The OS can hand us a background event
// before any React code has mounted.
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    useTrackingStore.getState().setError(error.message)
    logTracker("delivery failed", { error: error.message })
    return
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? []
  await ingest(locations, "background")
  // Each delivery is a fresh chance to bring back a service Android refused,
  // which several OEMs allow on a location PendingIntent and stock Android
  // does not; asking costs nothing when the service is up.
  await reassertService()
})

/**
 * Leaving the circle we drew around the stopping point means a journey
 * started, so bring the full tier back and start reporting properly again.
 */
TaskManager.defineTask(STATIONARY_GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    useTrackingStore.getState().setError(error.message)
    return
  }
  const event = data as { eventType?: Location.GeofencingEventType } | undefined
  if (event?.eventType !== Location.GeofencingEventType.Exit) return
  await onFenceExit()
})

async function onFenceExit(): Promise<void> {
  const { enabled, mode, stillAnchor, policy } = useTrackingStore.getState()
  if (!enabled) return
  logTracker("fence exit", { mode })
  // A fence left armed on a phone already moving, because Android refused
  // the service at the moment it left, fires on the way out. That exit is
  // the moment Android allows the start, and nothing more: the anchor by
  // now is a moving stretch, not a parking spot, and must not be parked at.
  if (mode !== "stationary") {
    if (mode === "moving") await reassertService({ exempt: true })
    return
  }
  // The exit is the moment Android allows the service to start, so the
  // service comes first, and the fix that checks the exit second. Android's
  // fences fire on the fixes it has, and indoors those can be a cell
  // tower's, so a sharp fix that is clearly still inside the circle is a
  // false exit and the phone parks again at once; anything else, a real
  // departure, a fix on the boundary, a loose fix or no fix in time, is
  // taken as the departure, since one missed is the worse error and five
  // still minutes park the phone again anyway.
  await enterMoving()
  const fix = await reportNow("significant", Location.Accuracy.Balanced, {
    judge: false,
    lastKnown: false,
  })
  const clearlyInside =
    fix != null &&
    stillAnchor != null &&
    (fix.accuracyMeters ?? Infinity) <= STILL_MAX_ACCURACY_METERS &&
    haversineMeters(stillAnchor, fix) + (fix.accuracyMeters ?? 0) <= stationaryRadiusMeters(policy)
  if (clearlyInside && stillAnchor) {
    logTracker("fence exit was false", { accuracy: fix?.accuracyMeters })
    // The fix just uploaded is from this spot; the anchor says still for it.
    await enterStationary(stillAnchor.lat, stillAnchor.lon, "synthesize")
  }
}

/**
 * What the native side saw while this side was down, or has just seen: the
 * fixes its service buffered and the events its receivers took. Fixes
 * first, since they are the evidence a departure is judged from, then the
 * events, each through the same handler as the live delivery. One pass at
 * a time, and a poke landing mid pass asks for one more.
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
  if (fixes.length > 0) {
    fixes.sort((a, b) => a.timestamp - b.timestamp)
    await ingest(fixes, "background")
  }
  const events = await native.drainEvents().catch(() => [])
  for (const event of events) {
    try {
      await onNativeEvent(event)
    } catch (error) {
      logTracker("native event failed", { type: event.type, error: (error as Error).message })
    }
  }
  // A service the native side could not start, or one an OEM took down,
  // is brought back here at the next moment Android allows it.
  await reassertService()
}

async function onNativeEvent(event: native.NativeEvent): Promise<void> {
  switch (event.type) {
    case "transition":
      await onMotion(event.activity, 100, "transition")
      return
    case "fence":
      if (event.id === STATIONARY_FENCE_ID && event.transition === "exit") await onFenceExit()
      return
    case "service":
      logTracker("native service", { status: event.status, reason: event.reason })
      return
    case "boot":
      logTracker("native boot")
      return
  }
}

/**
 * Android starts this in a process it woke for the native queue, with no
 * screen and no React tree. Everything it needs is in module scope, and
 * the queue is the whole job.
 */
export async function runHeadlessTask(data: { reason?: string } = {}): Promise<void> {
  logTracker("headless", { reason: data.reason ?? "unknown" })
  await processNativeQueue()
}

/** Waking the location stack is the one thing "stationary" exists to avoid. */
const DRIFT_CHECK_MS = 60 * 60 * 1000

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const { enabled, mode, policy, stillAnchor, lastDriftCheckAt, lastFix, queue } =
      useTrackingStore.getState()
    logTracker("sync", {
      mode,
      stale: !lastFix || Date.now() - Date.parse(lastFix.recordedAt) > STALE_FIX_MS,
      queued: queue.length,
    })
    // WorkManager running is not one of Android's allowed moments, but some
    // OEMs let the start through, and asking costs nothing when it is up.
    await reassertService()
    await refreshPlacesIfStale()

    // Android forgets geofences when the app process is killed, and expo's
    // geofencing does not restart a terminated app the way iOS does. Rather
    // than trust the fence to be the only thing that can wake us, this periodic
    // pass re-arms it and independently checks whether the phone has left. A
    // fence that quietly fails would otherwise mean going dark on a journey.
    if (enabled && mode === "stationary" && stillAnchor) {
      const rearmed = !(await geofenceRunning())
      if (rearmed) await enterStationary(stillAnchor.lat, stillAnchor.lon)
      const checkedAt = lastDriftCheckAt ? Date.parse(lastDriftCheckAt) : NaN
      const due = !Number.isFinite(checkedAt) || Date.now() - checkedAt > DRIFT_CHECK_MS
      if (rearmed || due) {
        useTrackingStore.getState().markDriftChecked()
        try {
          const { location: here } = await acquireFix(
            Location.Accuracy.Balanced,
            SYNC_FIX_TIMEOUT_MS,
            true,
          )
          // Waking the location stack already spent the battery this mode
          // exists to save, so the fix is worth reporting whether or not it
          // turns out to be far enough to call the stop over.
          await ingest([here], "significant")
          const left = clearOf(
            stillAnchor,
            {
              lat: here.coords.latitude,
              lon: here.coords.longitude,
              accuracyMeters: here.coords.accuracy,
            },
            stationaryRadiusMeters(policy),
          )
          if (left) await enterMoving()
        } catch (error) {
          logTracker("report failed", { source: "drift", error: (error as Error).message })
        }
      }
    }

    // The OS stops delivering while the phone sits inside the distance filter,
    // so a journey that ends in the background produces no fix to judge and
    // nothing else would ever call the stop. Without this pass the GPS tier
    // stays on for good.
    if (enabled && mode === "moving") {
      try {
        const { location: here } = await acquireFix(
          Location.Accuracy.Balanced,
          SYNC_FIX_TIMEOUT_MS,
          true,
        )
        // Through ingest, so the fix carries its accuracy into the judgement
        // and is gated, uploaded and read for speed like any other.
        await ingest([here], "background")
      } catch (error) {
        logTracker("report failed", { source: "sync", error: (error as Error).message })
      }
    }

    // Read back rather than reused from above, because the drift check may
    // have just reported a fix and a second wake of the GPS in the same pass is
    // the cost stationary mode exists to avoid.
    //
    // Signing out leaves `enabled` true, because it is the user's switch rather
    // than the session's, so the mode check is what keeps a signed-out phone
    // from queueing fixes no session can upload.
    const { mode: currentMode, lastFix: currentFix } = useTrackingStore.getState()
    const stale = !currentFix || Date.now() - Date.parse(currentFix.recordedAt) > STALE_FIX_MS
    if (enabled && currentMode !== "off" && stale && (await currentPermission()) === "always") {
      // Balanced, like the drift check: this repeats on a timer for as long as
      // the phone stays put, and it is the wake the rest of this task is built
      // to avoid paying for.
      await reportNow("significant", Location.Accuracy.Balanced, {
        timeoutMs: SYNC_FIX_TIMEOUT_MS,
      })
    } else {
      await flush()
    }
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

export async function currentPermission(): Promise<PermissionLevel> {
  const foreground = await Location.getForegroundPermissionsAsync()
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
 * A fixed filter is wrong at both ends of a drive: at walking pace it would
 * miss the first turn, on a motorway it would report every second. The filter
 * follows the speed so fixes land about one interval apart, and it moves in
 * steps so the request is not rebuilt for every wobble of the speedometer.
 */
export function drivingDistanceMeters(speedMps: number | null): number {
  const perInterval = ((speedMps ?? 0) * DRIVING_INTERVAL_MS) / 1000
  const stepped = Math.round(perInterval / 50) * 50
  return Math.min(300, Math.max(30, stepped))
}

/**
 * Android hands out continuous location only to a foreground service, and
 * without one the phone is an ordinary background app: a few fixes an hour,
 * none in Doze, no network until a maintenance window, a process reclaimed
 * within minutes on most OEM builds, and a service start refused later
 * except at a handful of moments. So the moving tiers carry the service and
 * a parked phone runs without it, so no notification stays. The key marks
 * the tiers that want it: on Android they run under the native tracking
 * service in modules/hearth-motion, which owns the request and posts its
 * own "Updating your location"; iOS ignores the key. A wake on a parked
 * phone runs that service brief, for the length of one fix, the way a
 * messaging app checks for messages.
 */
const SERVICE_NOTIFICATION = {
  notificationTitle: "Hearth",
  notificationBody: "Updating your location",
  killServiceOnDestroy: false,
}

function drivingOptions(distanceMeters: number): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.High,
    timeInterval: DRIVING_INTERVAL_MS,
    // Android: on the interval whether or not the car moved, so a car that
    // has parked keeps saying so at speed zero and the drive can end on
    // that. ingest gates the uploads at the elastic distance. iOS keeps the
    // OS filter and the background clock ends a drive that has gone quiet.
    distanceInterval: Platform.OS === "android" ? 0 : distanceMeters,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: false,
    foregroundService: SERVICE_NOTIFICATION,
  }
}

export function isDriving(): boolean {
  return useTrackingStore.getState().driving !== null
}

export async function enterDriving(speedMps: number | null): Promise<void> {
  const store = useTrackingStore.getState()
  if (store.mode !== "moving") return
  const distance = drivingDistanceMeters(speedMps)
  const current = store.driving
  if (current?.distance === distance) return
  store.setDriving({ distance, slowSince: current?.slowSince ?? null })
  logTracker("driving", { distance })
  await applyRegistration()
}

export async function leaveDriving(): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.driving) return
  const stoppedAt = store.driving.slowSince
  store.setDriving(null)
  logTracker("drive over")
  if (store.mode !== "moving") return
  // The car stopped when it began to crawl, and the stop is dated from
  // then, so the still clock is not started over once the drive is called.
  const last = store.lastFix
  if (last) {
    store.setStillAnchor({
      lat: last.lat,
      lon: last.lon,
      since: new Date(stoppedAt ?? Date.now()).toISOString(),
    })
  }
  await applyRegistration()
}

/**
 * Speed is the second opinion on driving: it starts the tier on a phone with
 * no motion permission, keeps the filter elastic through a drive, and ends
 * the tier after a few minutes of crawling, which the classifier can miss
 * when a phone sits face down in a footwell after arriving.
 *
 * A fix without a measured speed is given the speed the phone must have had
 * to get here from the last fix, when both are sharp enough for that to mean
 * anything.
 */
function withDerivedSpeed(
  fix: LocationFixInput,
  previous: LocationFixInput | null,
): LocationFixInput {
  if (fix.speedMps != null) return fix
  if (!previous) return fix
  const dt = (Date.parse(fix.recordedAt) - Date.parse(previous.recordedAt)) / 1000
  if (dt <= 0) return fix
  const sharp =
    (fix.accuracyMeters ?? Infinity) <= STILL_MAX_ACCURACY_METERS &&
    (previous.accuracyMeters ?? Infinity) <= STILL_MAX_ACCURACY_METERS
  if (!sharp) return fix
  return { ...fix, speedMps: haversineMeters(previous, fix) / dt }
}

async function trackDriveBySpeed(fix: LocationFixInput): Promise<void> {
  const speed = fix.speedMps
  if (speed == null) return
  const store = useTrackingStore.getState()
  const driving = store.driving
  if (!driving) {
    if (speed >= DRIVING_SPEED_MPS) await enterDriving(speed)
    return
  }
  const at = Date.parse(fix.recordedAt)
  if (speed < DRIVING_STOP_SPEED_MPS) {
    const slowSince = driving.slowSince ?? at
    if (driving.slowSince == null) store.setDriving({ ...driving, slowSince })
    if (at - slowSince >= DRIVING_STOP_AFTER_MS) await leaveDriving()
    return
  }
  if (driving.slowSince != null) store.setDriving({ ...driving, slowSince: null })
  await enterDriving(speed)
}

function updateOptions(policy: TrackingPolicy): Location.LocationTaskOptions {
  return {
    // iOS 16.4 and later suspend a low accuracy session that has a distance
    // filter once significant-change monitoring is also on, and expo-location
    // always adds that. GPS with the circle's filter is what stays alive.
    accuracy: Platform.OS === "ios" ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: policy.minUpdateIntervalSeconds * 1000,
    // Android delivers on the interval whether or not the phone moved, and
    // ingest applies the circle's distance filter to what it uploads, so a
    // still phone keeps delivering the fixes its stop is judged from. iOS
    // keeps the OS filter, and the background clock asks for that fix.
    distanceInterval: Platform.OS === "android" ? 0 : policy.distanceFilterMeters,
    // No deferred delivery: expo holds deferred fixes in the process, and the
    // ones held are the last of every journey, which a parked phone would
    // only deliver on its next delivery.
    // Automatic pausing suspends the app with the GPS, and a suspended app
    // never calls the stop or arms the fence. The clock calls the stop.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
    foregroundService: SERVICE_NOTIFICATION,
  }
}

/**
 * Parked is not silent, but it is quiet. On Android the request stays at
 * Wi-Fi grade with one fix wanted a quarter hour, under the same service as
 * every other tier. On iOS it is a cell-only session with the fence radius
 * as its distance filter: it costs almost nothing, it keeps the process
 * alive so the quarter hour heartbeat and the classifier keep running, and
 * a departure is seen by the session's own filter rather than at the
 * fence's leisure. Without a session iOS suspends the app within seconds,
 * and the fence alone is reported minutes late, or never with Background App
 * Refresh off.
 */
function restingOptions(): Location.LocationTaskOptions {
  if (Platform.OS === "ios") {
    return {
      accuracy: Location.Accuracy.Lowest,
      // No distance filter on purpose: a low accuracy session with one is
      // the shape iOS 16.4 and later suspend once significant-change
      // monitoring is on, and expo-location always adds that. Cell fixes
      // change rarely, and restingFixes uploads one a quarter hour anyway.
      distanceInterval: 0,
      // A paused manager suspends the app with it, and nothing would wake it
      // short of the fence.
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.Other,
      showsBackgroundLocationIndicator: false,
    }
  }
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: RESTING_HEARTBEAT_MS,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
  }
}

/**
 * The one place the OS request is derived from what the tracker believes,
 * so no re-registration can disagree with the tier it is in: a wake landing
 * mid drive re-asserts the driving request, not the walking one.
 */
function currentOptions(): Location.LocationTaskOptions | null {
  const { enabled, mode, policy, driving } = useTrackingStore.getState()
  // Off is derived like every other tier, so a transition that was queued
  // behind the stop lands on nothing rather than re-registering the service.
  if (!enabled || mode === "off") return null
  if (mode === "stationary") {
    // A parked Android phone answers a watch with one fix, not a live
    // request, because a live request carries the service and its
    // notification for the whole window. A parked iPhone has no such cost
    // and goes live.
    if (Platform.OS === "android") return restingOptions()
    return watchedNow() ? liveOptions(Location.Accuracy.High) : restingOptions()
  }
  // Somebody is looking. Full accuracy every few seconds for the window.
  if (watchedNow()) return liveOptions(Location.Accuracy.High)
  if (driving) return drivingOptions(driving.distance)
  return updateOptions(policy)
}

/**
 * Somebody has this phone's owner's page open. Every few seconds, uploaded
 * as it comes, for the watch window and no longer: the one time the family
 * wants to see a car move along a road is when they are looking at it.
 */
function liveOptions(accuracy: Location.Accuracy): Location.LocationTaskOptions {
  return {
    accuracy,
    timeInterval: LIVE_INTERVAL_MS,
    // On the interval, whether or not the phone moved, so the first fix past
    // the window is always delivered and steps the tier down, and a car at
    // the lights sends the same spot every few seconds, which is what live
    // means. iOS has no interval, and only a session with no distance filter
    // delivers to a phone standing still. ingest thins the stream to what is
    // worth uploading.
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: false,
    foregroundService: SERVICE_NOTIFICATION,
  }
}

export type ForegroundServiceStatus = native.ServiceStatus | "unknown"

/** What the last read of the service said, for the log header. */
let lastServiceStatus: ForegroundServiceStatus = "unknown"

/** Whether the native side has Android's transport: the receivers, the service and the queue. */
function androidNative(): boolean {
  return Platform.OS === "android" && native.nativeTrackerAvailable
}

/**
 * Whether the service behind the request is up, as the native side reports
 * it. "unknown" is iOS, where there is no service to be up. "brief" is the
 * service up for one fix, under a wake or a walk being confirmed.
 */
export async function foregroundServiceStatus(): Promise<ForegroundServiceStatus> {
  if (!androidNative()) return "unknown"
  try {
    lastServiceStatus = await native.serviceStatus()
  } catch {
    lastServiceStatus = "unknown"
  }
  return lastServiceStatus
}

/**
 * A service found down while a tier wants it went down without the app
 * asking: an OEM battery manager, most often. Remembered for a day so the
 * health report can tell the family why, since the next re-assert brings
 * it straight back and the moment would otherwise leave no trace.
 */
function noteServiceDied(): void {
  useTrackingStore.getState().setServiceStoppedAt(new Date().toISOString())
  logTracker("service died")
}

export function serviceDiedUnexpectedly(): boolean {
  const at = useTrackingStore.getState().serviceStoppedAt
  return at != null && Date.now() - Date.parse(at) < SERVICE_DEATH_MEMORY_MS
}

/**
 * The control channel is open while the phone's process is alive with a
 * location session: on iOS in every tier, since the parked session keeps
 * the app alive, and on Android while the phone is on the move, since the
 * service is up then anyway. A parked Android phone holds nothing open: an
 * ask reaches it by high priority push, and the push handler starts the
 * wake service natively, which is how a messaging app checks for messages.
 */
function syncControl(): void {
  const { enabled, mode } = useTrackingStore.getState()
  const alive = enabled && mode !== "off" && (Platform.OS === "ios" || mode === "moving")
  control.setWanted(alive)
}

/** A day is long enough: places change rarely, and the map refreshes them whenever it is opened. */
const PLACES_REFRESH_MS = 24 * 60 * 60 * 1000

/**
 * The tracker fetches the places itself when the phone has not opened the
 * map in a day, so a family member's phone that is never opened still knows
 * where home is and uploads the fix that arrives there.
 */
async function refreshPlacesIfStale(): Promise<void> {
  const { refreshedAt } = usePlacesStore.getState()
  if (refreshedAt && Date.now() - Date.parse(refreshedAt) < PLACES_REFRESH_MS) return
  if (!useAuthStore.getState().serverUrl) return
  try {
    const circles = await endpoints.circles.list()
    for (const circle of circles) {
      usePlacesStore.getState().setPlaces(circle.id, await endpoints.places.list(circle.id))
    }
    usePlacesStore.getState().setRefreshedAt(new Date().toISOString())
  } catch {
    // Offline, or signed out. Next time.
  }
}

/**
 * Registrations are serialised and each derives its options as it runs, so
 * two callers a tick apart cannot leave the OS holding the earlier one's
 * request over the later one's state.
 */
let registration: Promise<unknown> = Promise.resolve()

function applyRegistration(): Promise<ForegroundServiceStatus> {
  const next = registration.then(async () => {
    const options = currentOptions()
    if (androidNative()) return applyAndroid(options)
    if (!options) {
      if (await locationUpdatesRunning()) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
      }
      return "none" as const
    }
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, options)
    return "unknown" as const
  })
  registration = next.catch(() => undefined)
  return next
}

/**
 * The tier's request, in the native service's terms. The tracker keeps
 * deriving expo-shaped options for every tier, since iOS runs on them, and
 * the moving tiers on Android are the same options handed to the service.
 */
function toServiceRequest(options: Location.LocationTaskOptions): native.ServiceRequest {
  const accuracy = options.accuracy ?? Location.Accuracy.Balanced
  const priority: native.ServiceRequest["priority"] =
    accuracy >= Location.Accuracy.High
      ? "high"
      : accuracy <= Location.Accuracy.Lowest
        ? "low"
        : "balanced"
  return {
    priority,
    intervalMs: options.timeInterval ?? RESTING_HEARTBEAT_MS,
    distanceMeters: options.distanceInterval ?? 0,
  }
}

/**
 * On Android the moving tiers run under the native service, which owns the
 * location request and buffers what it sees, and the parked tier runs on
 * expo's Wi-Fi grade request with no service at all. Native is told which
 * it is in, and what to run when it starts the service on its own at a
 * departure, so nothing here has to be alive for a journey to begin.
 */
async function applyAndroid(
  options: Location.LocationTaskOptions | null,
): Promise<ForegroundServiceStatus> {
  // Native is told the tier before anything is stopped or started: a
  // transition landing in between would otherwise read the old tier and
  // bring back a service the stop had just taken down.
  await syncNativeState()
  if (!options) {
    if (await locationUpdatesRunning()) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
    }
    await native.stopService()
    lastServiceStatus = "none"
    return "none"
  }
  if (options.foregroundService) {
    if (await locationUpdatesRunning()) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
    }
    const request = toServiceRequest(options)
    const status = await native.startService(request)
    lastServiceStatus = status
    logTracker("service", { status, priority: request.priority, interval: request.intervalMs })
    // No death is read here: a start refused is a start refused, and a
    // service that was up and went away is what reassertService finds.
    return status
  }
  await native.stopService()
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, options)
  lastServiceStatus = "none"
  return "none"
}

/**
 * What the native receivers act on without this side: sharing on, the tier,
 * and the request to run at a departure. Written at every registration and
 * at every boot, so an install upgraded under a parked phone has it before
 * the phone next moves.
 */
async function syncNativeState(): Promise<void> {
  if (!androidNative()) return
  const { enabled, mode, policy } = useTrackingStore.getState()
  const on = enabled && mode !== "off"
  await native
    .setTrackerState({
      enabled: on,
      mode: on ? mode : "off",
      movingRequest: toServiceRequest(updateOptions(policy)),
    })
    .catch(() => undefined)
}

/**
 * Android 12 lets a background app start its location service only at a few
 * moments: a geofence exit, an activity transition, a high priority push, or
 * at any time once the app is exempt from battery optimisation. A stop can
 * end on none of them, and then the start is refused; a service can also be
 * killed under the app by an OEM battery manager. This is the answer at the
 * next allowed moment, and at every delivery, wake, watch, transition, sync
 * and app open in between. It re-asserts the request the tracker already
 * believes in, and only when the service is wanted and missing.
 */
const REASSERT_REFUSED_BACKOFF_MS = 10 * 60 * 1000

export async function reassertService({
  exempt = false,
}: { exempt?: boolean } = {}): Promise<void> {
  if (Platform.OS !== "android") return
  const { enabled, mode } = useTrackingStore.getState()
  // A parked phone wants no location service; a wake runs the wake service.
  if (!enabled || mode !== "moving") return
  const before = await foregroundServiceStatus()
  if (before !== "refused" && before !== "none" && before !== "brief") return
  // Brief is the wake's service, up for one fix under a phone that wants
  // the full one: it is upgraded in place, and nothing died.
  if (before === "none") noteServiceDied()
  // Re-registering the request hands back the fix the OS already had, which
  // is another delivery, and a delivery is not a moment Android allows the
  // start. Trying on every one would spin until something else let it
  // through. The moments it does allow are tried at once.
  const refusedAt = useTrackingStore.getState().serviceRefusedAt
  if (
    before === "refused" &&
    !exempt &&
    refusedAt != null &&
    Date.now() - Date.parse(refusedAt) < REASSERT_REFUSED_BACKOFF_MS
  ) {
    return
  }
  const after = await applyRegistration().catch(() => "refused" as const)
  useTrackingStore
    .getState()
    .setServiceRefusedAt(after === "refused" ? new Date().toISOString() : null)
  logTracker("reassert", { before, after, exempt })
  // The fence the refusal left armed has done its job once the service is up.
  if (after !== "refused" && after !== "none" && useTrackingStore.getState().mode === "moving") {
    await dropFence()
  }
}

/**
 * Somebody opened this phone's owner's page. The phone goes live for the
 * window whatever it was doing, and answers with one fix straight away:
 * iOS ignores the interval and delivers on distance, so a phone at rest
 * would otherwise say nothing for the whole window. The window ends by the
 * clock and by the first fix past it, whichever comes first.
 */
export async function enterWatched(seconds: number): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled || store.mode === "off") return
  logTracker("watched", { seconds, mode: store.mode })
  store.setWatchedUntil(new Date(Date.now() + seconds * 1000).toISOString())
  armWatchTimer()
  // The window is held either way, so a departure inside it goes straight
  // to live. A parked Android phone answers with one fix under the brief
  // service, and the server asks again while the page stays open.
  if (Platform.OS === "android" && store.mode === "stationary") {
    await wakeFix()
    return
  }
  await applyRegistration()
  await reportNow(
    "nudge",
    store.mode === "stationary" ? Location.Accuracy.Balanced : Location.Accuracy.High,
    { judge: store.mode === "stationary" },
  )
}

/**
 * The upload reply says until when somebody has this phone's owner's page
 * open. A moving phone uploads every few seconds, so this reaches it whether
 * or not the silent push did. The window is measured against the server's
 * own clock, since the phone's may be minutes out. A window already held is
 * only moved out, never re-registered: the tier steps down on its own when
 * the window lapses.
 */
async function adoptWatch(until: string | null | undefined, serverTime?: string): Promise<void> {
  if (!until) return
  const serverNow = serverTime ? Date.parse(serverTime) : NaN
  const remainingMs = Date.parse(until) - (Number.isFinite(serverNow) ? serverNow : Date.now())
  if (!(remainingMs > 0)) return
  const store = useTrackingStore.getState()
  const held = store.watchedUntil ? Date.parse(store.watchedUntil) : null
  logTracker("watch adopted", { remaining: Math.round(remainingMs / 1000), held: held != null })
  if (held != null && held > Date.now()) {
    const ends = Date.now() + remainingMs
    if (ends > held) {
      store.setWatchedUntil(new Date(ends).toISOString())
      armWatchTimer()
    }
    return
  }
  await enterWatched(Math.ceil(remainingMs / 1000))
}

/** True while somebody is watching, and the moment it stops being so the tier steps back down. */
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
  store.setWatchedUntil(null)
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  logTracker("watch over", { mode: store.mode })
  if (store.mode !== "off") await applyRegistration()
}

/**
 * The answer to a wake or a nudge: one fix, uploaded. The push that carried
 * it is one of the moments Android lets the service start, so a refused one
 * is re-asserted first, while the moment lasts.
 */
export async function wakeFix(): Promise<LocationFixInput | null> {
  const { enabled, mode } = useTrackingStore.getState()
  if (!enabled || mode === "off") return null
  const brief = Platform.OS === "android" && mode === "stationary"
  logTracker("wake", { mode, brief })
  if (!brief) {
    await reassertService({ exempt: true })
    return reportNow("nudge", Location.Accuracy.Balanced)
  }
  // The brief service carries this one fix and goes with it; the resting
  // request is left as it is. A push starts the service natively before
  // this runs, and starting it again is a no-op. reportNow has its own
  // deadline, so a fix that never settles cannot leave the service up, and
  // the service stops itself after the same deadline regardless.
  await native.startBrief()
  try {
    return await reportNow("nudge", Location.Accuracy.Balanced)
  } finally {
    await native.stopBrief()
  }
}

let motionSubscription: { remove: () => void } | null = null
let motionStarting = false

/**
 * Play Services and Core Motion already classify movement for the system, so
 * asking them costs far less than waking the GPS to work it out from position.
 * The classifier is wanted for as long as tracking runs: it settles a stop in
 * seconds where the position watch needs minutes, and it is the only thing
 * that tells crash detection a drive has started. startMotion answers null
 * where the module, the hardware or the permission is missing, and the tracker
 * then works stops out from position instead.
 */
async function startMotionWatch(): Promise<void> {
  // The resume path and a grant on the checklist can call this at once, and
  // each await below is a chance for the second to walk past a null
  // subscription and add a native listener whose handle we then lose.
  if (motionSubscription || motionStarting) return
  motionStarting = true
  try {
    motionSubscription = await startMotion((activity, confidence, source) => {
      void onMotion(activity, confidence, source)
    })
  } finally {
    motionStarting = false
  }
}

/**
 * Called after the checklist grants the permission and whenever a circle's
 * incident-alert setting changes. The classifier stays on either way, because
 * the location side needs it, so all that incident alerts going off releases
 * is the drive sensors. A phone that is not tracking has nothing for the
 * classifier to feed, and startTracking brings it up when that changes.
 */
export async function refreshMotionWatch(): Promise<void> {
  const { enabled, mode } = useTrackingStore.getState()
  if (!enabled || mode === "off") return
  await startMotionWatch()
  if (!useSettingsStore.getState().incidentDetection) stopDriveSensors()
}

async function stopMotionWatch(): Promise<void> {
  await stopMotion(motionSubscription)
  motionSubscription = null
  useTrackingStore.getState().setMotionStillSince(null)
  // With the classifier gone nothing will report a change, so this is the last
  // moment anything asks the sensors to stop. Leaving them running samples at
  // 50Hz for a journey nobody is watching.
  stopDriveSensors()
}

async function onMotion(
  activity: MotionActivity,
  confidence: number,
  source: MotionSource = "sample",
): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled || store.mode === "off" || confidence < MOTION_MIN_CONFIDENCE) return
  if (activity !== "unknown" && activity !== store.lastVerdict) {
    logTracker("motion", { activity, confidence, source, mode: store.mode })
    store.setLastVerdict(activity)
  }

  // Impact sensing is only worth its battery inside a vehicle, and only there
  // can its signals be read honestly: a spike while walking is a dropped
  // phone. A single "still" at the lights is not the end of the drive.
  if (activity === "automotive" && useSettingsStore.getState().incidentDetection) {
    void startDriveSensors((event) => {
      // Harsh braking is a driving quality signal with nowhere to go yet, so
      // only a possible impact is acted on.
      if (event.kind !== "possibleImpact") return
      useIncidentStore.getState().raise(event)
      // The modal only helps someone already looking at the screen.
      void presentIncidentAlarm(translate("incident:alarmTitle"), translate("incident:alarmBody"))
    })
  } else if (activity !== "unknown" && activity !== "still") {
    stopDriveSensors()
  }

  if (activity === "unknown") return

  // A transition is the exempt moment Android names for a service start.
  if (source === "transition") await reassertService({ exempt: true })

  if (activity === "automotive") {
    store.setMotionStillSince(null)
    if (store.mode === "stationary") {
      // A vehicle ends a stop, and the fence would cost the first minute of
      // the drive. A sampled verdict in the doubtful band is confirmed like
      // a walk: a car pulling away is clear of the anchor within a minute.
      const trusted = source === "transition" || confidence >= MOTION_SURE_CONFIDENCE
      if (!trusted && !(await confirmedLeft(store.policy))) return
      await enterMoving()
    }
    await enterDriving(store.lastFix?.speedMps ?? null)
    return
  }

  if (activity === "still") {
    if (store.mode !== "moving") return
    const since = store.motionStillSince ?? Date.now()
    if (store.motionStillSince == null) store.setMotionStillSince(since)
    // A car at the lights reads still too, so a drive waits the crawl's
    // three minutes before a still streak parks it, and then parks in one
    // step, GPS off and fence armed.
    const window = store.driving ? DRIVING_STOP_AFTER_MS : MOTION_STILL_CONFIRM_MS
    if (Date.now() - since < window) return
    // A phone on a journey is not parked by the classifier alone: a queue
    // of traffic reads still for minutes, and on Android the drive guard
    // above is often missing. The position has to agree, which is the same
    // evidence the location path parks on.
    if (inJourney() && !heldStill()) return
    const fix = store.lastFix
    if (fix) await enterStationary(fix.lat, fix.lon)
    return
  }

  // Walking, running, cycling. Any of them ends a drive, and a still streak.
  store.setMotionStillSince(null)
  if (store.driving) await leaveDriving()
  if (store.mode !== "stationary") return

  // On foot is a different matter from a vehicle. A phone handled in bed
  // reads as walking at fifty or sixty percent, so the verdict has to be
  // confirmed by a fix clear of where the phone parked, and until then the
  // fence is the judge.
  if (await confirmedLeft(store.policy)) await enterMoving()
}

/** No fix clear of the anchor for as long as the location path needs to park. */
function heldStill(): boolean {
  const { stillAnchor } = useTrackingStore.getState()
  return stillAnchor != null && Date.now() - Date.parse(stillAnchor.since) >= STILL_AFTER_MS
}

/**
 * One Balanced fix, at most every two minutes, judged by the same rule as
 * every other departure: clear of the parking spot by more than its own
 * error and the fence's radius, not the tighter still radius, which a
 * Wi-Fi estimate wandering about a house clears on its own.
 */
async function confirmedLeft(policy: TrackingPolicy): Promise<boolean> {
  if (Date.now() - lastMotionCheck < MOTION_CHECK_INTERVAL_MS) return false
  lastMotionCheck = Date.now()
  // On Android the fix is taken under the brief service, which the native
  // side has often brought up already for the transition that led here; a
  // background app without it is held to a few fixes an hour.
  if (androidNative()) await native.startBrief()
  const fix = await reportNow("significant", Location.Accuracy.Balanced, {
    judge: false,
    lastKnown: false,
  })
  const anchor = useTrackingStore.getState().stillAnchor
  const left = fix != null && anchor != null && clearOf(anchor, fix, stationaryRadiusMeters(policy))
  // A walk that came to nothing takes the brief service down with it; a
  // departure upgrades it to the full one on its way.
  if (!left && androidNative()) await native.stopBrief()
  return left
}

/** A fix costs something, and a fidgeting phone says "walking" every sample. */
const MOTION_CHECK_INTERVAL_MS = 2 * 60 * 1000
let lastMotionCheck = 0

async function locationUpdatesRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false)
}

async function geofenceRunning(): Promise<boolean> {
  if (androidNative()) return native.fenceArmed().catch(() => false)
  return Location.hasStartedGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => false)
}

/** The fence has done its job once the service is up and the phone is moving. */
async function dropFence(): Promise<void> {
  if (androidNative()) await native.disarmFence().catch(() => {})
  // On Android too: an install upgraded from a build whose fence was expo's
  // still has that one registered, and it would answer the next exit twice.
  if (await Location.hasStartedGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => {})
  }
}

/**
 * The fence around the parking spot. On Android the native side arms it
 * with Play Services and answers its exit itself, service first; on iOS it
 * is expo's region, and the task below answers it.
 */
async function armFence(lat: number, lon: number, radius: number): Promise<void> {
  if (androidNative()) {
    if (!(await native.armFence(lat, lon, radius))) throw new Error("Fence refused")
    return
  }
  await Location.startGeofencingAsync(STATIONARY_GEOFENCE_TASK, [
    { latitude: lat, longitude: lon, radius, notifyOnEnter: false, notifyOnExit: true },
  ])
}

/** Continuous updates on, in the walking tier until a drive is judged. */
export async function enterMoving(): Promise<void> {
  const store = useTrackingStore.getState()
  const previous = store.mode
  // A still streak counted before the departure is not evidence about the
  // journey that follows.
  store.setMotionStillSince(null)
  // Registering again on a running task swaps its options, which is how the
  // resting watch is stepped back up to the full one. A drive is decided
  // afresh from the fixes that follow, unless the phone is already moving,
  // in which case this is a re-assert and the drive it is on stands.
  if (previous !== "moving") store.setDriving(null)
  store.setMode("moving")
  let service: ForegroundServiceStatus
  try {
    service = await applyRegistration()
  } catch (error) {
    // Permission gone, most likely. Nothing has changed at the OS, so
    // nothing changes here either, and refreshLocationStatus will call it.
    store.setMode(previous)
    throw error
  }
  // A stop can land while the registration was in flight, and its fence
  // and anchor are then the newer truth.
  if (useTrackingStore.getState().mode !== "moving") return
  logTracker("moving", { from: previous, service })
  syncControl()
  // The request is registered either way. What the fence does next depends
  // on whether Android let the service start: with it up, the fence has done
  // its job; refused, the fence stays, because its exit is a moment Android
  // does allow the start and the phone is on throttled fixes until then.
  if (service !== "refused") await dropFence()
  // The anchor is kept. It now means "still here since", and a departure
  // that turns out to be false, a fix that wandered, settles again on the
  // first fix back inside the still radius rather than five minutes later.
  // A real one has every fix clear of it and re-anchors as it goes.
  store.setBackgroundActive(true)
  armBackgroundClock()
  // A journey can begin in a fresh process, from a wake or a resting fix, and
  // needs the classifier from its first minute.
  await startMotionWatch()
}

/**
 * How the fix that says "arrived" is had. "acquire" asks the OS, with the
 * moving registration still up; a location already in hand is uploaded as
 * it is; "synthesize" sends the anchor itself, for a re-park whose fix was
 * just uploaded; "none" is a launch or re-arm while already parked.
 */
export type ParkFix = "acquire" | "synthesize" | "none" | Location.LocationObject

let parking: Promise<void> | null = null

/**
 * Geofence armed, request stepped down to the resting one. The stop is
 * called once at a time: a delivery landing while the arrival fix is on its
 * way judges the same stop and joins this one rather than starting another.
 */
export function enterStationary(
  lat: number,
  lon: number,
  parkFix: ParkFix = "acquire",
): Promise<void> {
  if (parking) return parking
  parking = settle(lat, lon, parkFix).finally(() => {
    parking = null
  })
  return parking
}

async function settle(lat: number, lon: number, parkFix: ParkFix): Promise<void> {
  const store = useTrackingStore.getState()
  const previous = store.mode
  // The word "still" leaves first, while the moving registration still holds
  // the process and, on Android, the service: the last fix of a journey is
  // taken while the phone is still called moving, so without this the server
  // never heard the stop and applied its hour rule to a phone at home.
  if (previous !== "stationary" && parkFix !== "none") {
    await sendParkFix(lat, lon, parkFix)
    // Sharing went off, or a departure landed, while the fix was on its way.
    if (useTrackingStore.getState().mode !== previous) {
      logTracker("park abandoned", { mode: useTrackingStore.getState().mode })
      return
    }
  }
  try {
    await armFence(lat, lon, stationaryRadiusMeters(store.policy))
  } catch {
    // With nothing armed to wake us there would be no way back, so it is safer
    // to keep the full tier than to go silent. The anchor is re-dated so the
    // phone sits still for the whole window again before the next attempt:
    // a permission short of Always throws here every time, and retrying on
    // the next fix would spend a fix and an upload per delivery.
    store.setStillAnchor({ lat, lon, since: new Date().toISOString() })
    await enterMoving()
    return
  }
  store.setDriving(null)
  store.setMotionStillSince(null)
  store.setMode("stationary")
  try {
    await applyRegistration()
  } catch (error) {
    store.setMode(previous)
    throw error
  }
  // A departure can land while the registration was in flight, and the
  // anchor written below would then describe a stop that is over.
  if (useTrackingStore.getState().mode !== "stationary") return
  logTracker("stationary", {
    from: previous,
    lat: Number(lat.toFixed(5)),
    lon: Number(lon.toFixed(5)),
  })
  syncControl()
  // A parked phone wants no service, so a death remembered from the drive
  // is no longer what stands between it and reporting.
  store.setServiceStoppedAt(null)
  // Sampling the accelerometer that hard is only worth its battery inside a
  // moving vehicle. A verdict already scheduled survives this, see
  // stopDriveSensors.
  stopDriveSensors()
  // The sweep's re-arm and the relaunch path both read stillAnchor as the spot
  // the phone is parked at, and neither runs while it is null. Writing it here
  // is what keeps it the same point as the fence however the stop was called.
  store.setStillAnchor({ lat, lon, since: new Date().toISOString() })
  store.setBackgroundActive(true)
  armBackgroundClock()
}

/**
 * The arrival fix, stamped still whatever the tracker's verdict, uploaded
 * before the request steps down. When the OS does not answer in time the
 * anchor itself is sent, dated now: where the phone stopped is known, and
 * the server hearing "still" is what turns its hour rule into its twelve
 * hour one.
 */
async function sendParkFix(lat: number, lon: number, how: Exclude<ParkFix, "none">): Promise<void> {
  const started = Date.now()
  let fix: LocationFixInput | null = null
  if (typeof how === "object") {
    fix = toFix(how, "significant", await batterySnapshot(), "still")
    useTrackingStore.getState().enqueue([fix])
  } else if (how === "acquire") {
    fix = await reportNow("significant", Location.Accuracy.Balanced, {
      judge: false,
      activity: "still",
      lastKnown: false,
    })
  }
  const synthesized = fix == null
  if (!fix) {
    fix = syntheticFix(lat, lon, "significant", await batterySnapshot())
    useTrackingStore.getState().enqueue([fix])
  }
  await flush()
  logTracker("park fix", {
    synthesized,
    acc: Math.round(fix.accuracyMeters ?? -1),
    ms: Date.now() - started,
    uploaded: !useTrackingStore.getState().queue.some((queued) => queued === fix),
  })
}

/**
 * A phone that has not left a small circle for a few minutes has arrived
 * somewhere. Anchoring on the first fix of the stretch rather than the previous
 * one means slow drift cannot keep resetting the clock.
 */
export type StillnessDecision = "settle" | "reanchor" | "wait"

export function stillnessDecision(
  anchor: { lat: number; lon: number; since: string } | null,
  fix: Pick<LocationFixInput, "lat" | "lon" | "recordedAt"> & { accuracyMeters?: number | null },
  radiusMeters: number = STILL_RADIUS_METERS,
): StillnessDecision {
  // A fix is clear of the anchor only beyond its own error, so a loose one
  // that merely wanders does not reset the clock, while one clear even at
  // its own looseness is movement. Otherwise every wandering Wi-Fi estimate
  // indoors resets the clock, and a home with only cell fixes never parks.
  if (!anchor) return "reanchor"
  if (clearOf(anchor, fix, radiusMeters)) return "reanchor"
  return Date.parse(fix.recordedAt) - Date.parse(anchor.since) >= STILL_AFTER_MS ? "settle" : "wait"
}

/**
 * Whether a fix puts the phone outside a circle by more than the fix's own
 * error. A fix a street away with a two street error circle proves nothing.
 */
function clearOf(
  centre: { lat: number; lon: number },
  fix: { lat: number; lon: number; accuracyMeters?: number | null },
  radiusMeters: number,
): boolean {
  return haversineMeters(centre, fix) - (fix.accuracyMeters ?? 0) > radiusMeters
}

async function evaluateStillness(
  fix: Pick<LocationFixInput, "lat" | "lon" | "recordedAt"> & { accuracyMeters?: number | null },
): Promise<void> {
  const store = useTrackingStore.getState()
  if (store.mode !== "moving") return

  // The anchor is kept through a drive too, so the classifier's still rule
  // can read how long the car has really sat here, but a drive is never
  // parked from here: a car held at lights or in a queue is not parked. The
  // drive ends first, on the classifier or on minutes of crawling, and only
  // then can a stop be called from where the fixes stopped coming.
  const anchor = store.stillAnchor
  switch (stillnessDecision(anchor, fix, stillRadiusMeters(store.policy))) {
    case "reanchor":
      store.setStillAnchor({ lat: fix.lat, lon: fix.lon, since: fix.recordedAt })
      return
    case "settle":
      if (store.driving) return
      if (anchor) await enterStationary(anchor.lat, anchor.lon)
      return
    case "wait":
      return
  }
}

/**
 * Permission and the OS location switch can both change while the app is in
 * the background, and nothing told us. Without re-reading them on the way back
 * the app keeps claiming to share a location it can no longer read.
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

  // Keeping a dead foreground service alive would show a notification claiming
  // to share a position we cannot get, and a phone allowed only "while
  // using" cannot arm a fence or run in the background at all: it reports
  // from the foreground heartbeat until Always is granted, as startTracking
  // already decides.
  if (store.enabled && store.mode !== "off" && (permission !== "always" || !servicesEnabled)) {
    await stopTracking()
  }

  return { permission, servicesEnabled }
}

/**
 * The fix the OS already has, so asking costs nothing. It is the only thing
 * that can tell us the anchor went stale while the process was dead, taking
 * the geofence with it.
 */
async function hasLeft(anchor: { lat: number; lon: number }): Promise<boolean> {
  const last = await Location.getLastKnownPositionAsync().catch(() => null)
  if (!last) return false
  return clearOf(
    anchor,
    {
      lat: last.coords.latitude,
      lon: last.coords.longitude,
      accuracyMeters: last.coords.accuracy,
    },
    stationaryRadiusMeters(useTrackingStore.getState().policy),
  )
}

/** Foreground permission is enough to start, but only "always" keeps it running. */
export async function startTracking(): Promise<boolean> {
  const permission = await currentPermission()
  useTrackingStore.getState().setPermission(permission)
  // "While using" has no parked shape on Android: the resting request and
  // the fence both need the background permission. Such a phone reports from
  // the foreground heartbeat only, which is what the checklist says until
  // Always is granted.
  if (permission !== "always") return false

  // mode and stillAnchor outlive the process, so a launch while parked picks the
  // stop back up. enterMoving here would restart the foreground service and set
  // the stillness clock back to zero for a phone that has not moved.
  const { mode, stillAnchor } = useTrackingStore.getState()
  const anchor = mode === "stationary" ? stillAnchor : null
  const parkedAt = anchor && !(await hasLeft(anchor)) ? anchor : null
  if (parkedAt) {
    await enterStationary(parkedAt.lat, parkedAt.lon, "none")
  } else if (mode === "off") {
    // Sharing just switched on, most often at home. Starting on the move
    // would run the GPS tier for five minutes to learn the phone is still;
    // parking at the first fix costs a fence, and a phone that is in fact
    // moving crosses it within a minute or two, or the classifier says so.
    // The fix is the arrival fix too, so it is not asked for twice.
    const first = await acquireFix(Location.Accuracy.Balanced, WAKE_FIX_TIMEOUT_MS, true).catch(
      () => null,
    )
    if (first) {
      await enterStationary(
        first.location.coords.latitude,
        first.location.coords.longitude,
        first.location,
      )
    } else {
      await enterMoving()
    }
  } else {
    await enterMoving()
  }
  // Coming back to the foreground finds the app in whatever tier it was in,
  // and a window somebody was watching may have run out while it was away.
  const store = useTrackingStore.getState()
  if (store.watchedUntil && !watchedNow()) store.setWatchedUntil(null)
  else if (store.watchedUntil) armWatchTimer()

  await startMotionWatch()
  await registerBackgroundSync()
  syncControl()
  void refreshPlacesIfStale()
  // Somebody opening the app is looking at their own dot, and a parked phone
  // has a fix from a quarter hour ago at best. One Balanced fix is cheap.
  const lastFix = useTrackingStore.getState().lastFix
  const age = lastFix ? Date.now() - Date.parse(lastFix.recordedAt) : Infinity
  if (age > FOREGROUND_MAX_AGE_MS) void reportNow("foreground", Location.Accuracy.Balanced)
  // After the launch fix, so the heartbeat's first tick sees it in flight
  // rather than asking for a second.
  startForegroundHeartbeat()
  return true
}

export async function stopTracking(): Promise<void> {
  logTracker("off")
  stopForegroundHeartbeat()
  stopBackgroundClock()
  clearRetry()
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  recentFixes = []
  const store = useTrackingStore.getState()
  store.setDriving(null)
  store.setMotionStillSince(null)
  // Off first, then the stop goes through the same chain as every other
  // registration, so a transition or a wake still in flight lands on "off"
  // and registers nothing rather than bringing the service back after this.
  store.setMode("off")
  store.setWatchedUntil(null)
  syncControl()
  await applyRegistration().catch(() => undefined)
  await dropFence()
  await stopMotionWatch()
  stopDriveSensors()
  store.setStillAnchor(null)
  store.setBackgroundActive(false)
  // Sign-out, a server change and a deleted account all land here, and none of
  // them turn the master switch off, so the wake had nothing left to stop it.
  // startTracking registers it again, and that is the only way back from "off".
  await unregisterBackgroundSync()
}

let lastPolicyRestart = 0

/** Throttled, so policy churn from the server cannot thrash the OS updates. */
export async function applyPolicy(): Promise<void> {
  if (Date.now() - lastPolicyRestart < 60_000) return
  if (useTrackingStore.getState().mode !== "moving") return
  if (!(await locationUpdatesRunning())) return
  lastPolicyRestart = Date.now()
  await applyRegistration()
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
    // Background tasks are a nice-to-have. Location updates still flow without them.
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  if (Platform.OS === "web") return
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK)
    }
  } catch {
    // Same as registering. A wake we could not cancel is caught by the mode
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
 * What a shared log opens with: the tracker's beliefs at the moment of
 * sharing, which the lines below cannot always be read back to.
 */
export function headerForTrackerLog(): string {
  const { mode, stillAnchor, queue, lastError, permission, driving, watchedUntil, enabled } =
    useTrackingStore.getState()
  return [
    `mode ${mode}${driving ? ` (driving, gate ${driving.distance} m)` : ""}${enabled ? "" : " (sharing off)"}`,
    `anchor ${
      stillAnchor
        ? `${stillAnchor.lat.toFixed(5)},${stillAnchor.lon.toFixed(5)} since ${stillAnchor.since}`
        : "none"
    }`,
    `queue ${queue.length}`,
    `lastError ${lastError ?? "none"}`,
    `permission ${permission}`,
    `service ${lastServiceStatus}`,
    `watched ${watchedUntil ?? "no"}`,
    `platform ${Platform.OS}`,
  ].join("\n")
}

setTrackerLogHeader(headerForTrackerLog)

// A process the OS started for a background event runs this module before
// anything else. The log records which kind of launch it was, and the
// classifier starts with it so a headless boot is not judged on position alone.
{
  const { enabled, mode, queue } = useTrackingStore.getState()
  logTracker("boot", {
    headless: AppState.currentState !== "active",
    mode,
    enabled,
    queued: queue.length,
  })
  if (enabled && mode !== "off") void startMotionWatch()
  // And the channel: a process the OS restarted for a delivery has to be
  // reachable again before anyone opens a page on it.
  syncControl()
  // Whatever the native side saw while this process was down is the first
  // thing this one deals with, and every poke after is dealt with the same way.
  native.onNativeQueue(() => void processNativeQueue())
  if (enabled && mode !== "off") {
    void syncNativeState().then(() => processNativeQueue())
  }
}
