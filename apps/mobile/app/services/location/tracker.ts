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

import { ApiError, api, endpoints } from "@/services/api"
import { tokenListeners } from "@/services/api/tokenListeners"
import { checkIncident, raiseIncident } from "@/services/incidentAlarm"
import { useAuthStore } from "@/stores/auth"
import {
  startMotion,
  stopMotion,
  type MotionActivity,
  type MotionSource,
} from "@/services/location/motion"
import { startDriveSensors, stopDriveSensors } from "@/services/location/driveSensors"
import { useSettingsStore } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { control, setControlHandler } from "@/services/location/control"
import { logTracker, setTrackerLogHeader } from "@/services/location/log"
import * as native from "@/services/location/nativeTracker"
import { crossesPlace, knownPlaces, usePlacesStore } from "@/stores/places"
import {
  useTrackingStore,
  type PermissionLevel,
  type RestingFix,
  type TrackingPolicy,
} from "@/stores/tracking"

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
 * How often a parked phone says it is still there. Shared, because the
 * server's stale line for a parked phone has to sit well past it.
 */
export const RESTING_HEARTBEAT_MS = DEFAULTS.restingHeartbeatSeconds * 1000

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
/**
 * Vaguer than this a fix is a network estimate, and one clear of the fence
 * by its own error is still not a departure. A 200 m Wi-Fi guess 400 m off
 * would un-park a phone lying in bed. It is a reason to look again.
 */
const DEPARTURE_MAX_ACCURACY_METERS = DEFAULTS.coarseFixAccuracyMeters
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
/**
 * While live the next delivery is a second away, so waiting for it is no
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
 * What the tracker called the phone's activity, and from when. Android's
 * native queue hands fixes over in batches, sometimes after the verdict has
 * moved on, and a drive's last minutes stamped with the "walking" that ended
 * it went up as a walk at 80 km/h. A fix is labelled with the verdict in
 * force when it was recorded. An hour covers any batch the queue holds back,
 * and the store keeps it across the restart that drains one.
 */
const ACTIVITY_MEMORY_MS = 60 * 60 * 1000

function noteActivity(now: number = Date.now()): void {
  const store = useTrackingStore.getState()
  const activity = currentActivity()
  // A clock set back leaves verdicts dated in the future, which would stand
  // in front of everything recorded before them.
  const history = store.activityHistory.filter((entry) => entry.from <= now)
  const latest = history[history.length - 1]?.activity
  if (history.length === store.activityHistory.length && latest === activity) return
  if (latest !== activity) history.push({ from: now, activity })
  while (history.length > 1 && now - history[1]!.from > ACTIVITY_MEMORY_MS) history.shift()
  store.setActivityHistory(history)
}

/** The tracker's verdict as it stood at `at`, as far back as it remembers. */
function activityAt(at: number): ActivityType {
  noteActivity()
  const history = useTrackingStore.getState().activityHistory
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.from <= at) return history[i]!.activity
  }
  return history[0]?.activity ?? currentActivity()
}

useTrackingStore.subscribe((state, previous) => {
  if (
    state.mode !== previous.mode ||
    state.driving !== previous.driving ||
    state.lastVerdict !== previous.lastVerdict
  ) {
    noteActivity()
    // A fix the native side sends is labelled with this verdict.
    void syncNativeState()
  }
})

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
      // The first fix off road speed goes up whatever the gates say. The
      // server calls a stop sudden only from the fix that shows the car
      // standing straight after road speed, and an ordinary stop sends its
      // slowing down here instead.
      const offRoadSpeed =
        (last.speedMps ?? 0) >= DEFAULTS.incidentMinSpeedMps &&
        fix.speedMps != null &&
        fix.speedMps < DEFAULTS.incidentMinSpeedMps
      if (
        !offRoadSpeed &&
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
        !offRoadSpeed &&
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

async function refuseUploads(message: string): Promise<void> {
  useTrackingStore.getState().setUploadsRefusedAt(new Date().toISOString())
  logTracker("refused", { status: 403 })
  await stopTracking().catch(() => undefined)
  useTrackingStore.getState().setError(message)
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

export async function ingest(
  locations: Location.LocationObject[],
  source: LocationSource,
  { sent = false }: { sent?: boolean } = {},
) {
  if (locations.length === 0) return
  const battery = await batterySnapshot()
  const state = useTrackingStore.getState()
  const all = locations.map((location) =>
    toFix(location, source, battery, activityAt(location.timestamp)),
  )
  const newest = all[all.length - 1]!
  if (source === "background" || source === "significant") rememberFixes(all)
  const live = watchedNow()
  if (sent) {
    // The native side sent these already, answering a wake or a watch. They
    // still say where the phone is and how it moves, and nothing goes again.
    if (state.mode === "stationary") for (const fix of all) rememberRestingFix(fix)
    state.noteSent(all)
    if (live) tallyLive({ fixes: all.length, kept: all.length }, newest.accuracyMeters)
    else logTracker("fixes", { got: all.length, sent: true, mode: state.mode })
  } else {
    await keepFixes(all, newest, source, live)
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
    // The live tier delivers on its interval whether or not the phone moves,
    // so the first fix past the window is what steps it back down, whether or
    // not the timer got there.
    await endWatchIfOver()
  }
  // Whether or not this delivery kept a fix: the queue may hold an upload
  // that failed, and on a parked phone the next kept fix is a quarter hour off.
  // A retry already waiting is left to its timer, so a firewall that locked
  // the address out is not met with a request for every fix.
  if (!retryTimer) await flush()
}

/** What of a delivery goes up, and when. */
async function keepFixes(
  all: LocationFixInput[],
  newest: LocationFixInput,
  source: LocationSource,
  live: boolean,
): Promise<void> {
  const state = useTrackingStore.getState()
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
  if (source === "background" && live) {
    tallyLive({ fixes: all.length, kept: fixes.length }, newest.accuracyMeters)
  } else if (source === "background") {
    logTracker("fixes", {
      got: all.length,
      kept: fixes.length,
      mode: state.mode,
      acc: Math.round(newest.accuracyMeters ?? -1),
      speed: newest.speedMps == null ? null : Number(newest.speedMps.toFixed(1)),
    })
  }
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
  const left = fixes.find((fix) => stillAnchor && leftAnchor(stillAnchor, fix, radius))
  if (left) {
    await enterMoving()
    return fixes.slice(fixes.indexOf(left))
  }
  const hinted = fixes.some((fix) => stillAnchor && clearOf(stillAnchor, fix, radius))
  if (hinted && (await confirmedLeft(policy))) {
    // The sharper fix that settled it has gone up already.
    await enterMoving()
    return []
  }
  for (const fix of fixes) rememberRestingFix(fix)
  if (live) return fixes
  const newest = fixes[fixes.length - 1]
  if (!newest) return []
  const age = lastFix ? Date.parse(newest.recordedAt) - Date.parse(lastFix.recordedAt) : Infinity
  if (age < RESTING_HEARTBEAT_MS) return []
  if (!stillAnchor || placesPhone(newest)) return [newest]
  const battery = {
    batteryLevel: newest.batteryLevel ?? null,
    isCharging: newest.isCharging ?? null,
  }
  return [stillHere(newest.recordedAt, newest.source ?? "background", battery)]
}

/** Sharp enough to say where a phone is, rather than only that it is about. */
function placesPhone(fix: { accuracyMeters?: number | null }): boolean {
  const accuracy = fix.accuracyMeters
  return accuracy != null && accuracy >= 0 && accuracy <= DEPARTURE_MAX_ACCURACY_METERS
}

/**
 * A fix that places a parked phone without taking it out of its stop circle
 * is where it now is. The anchor stays put for the fence, and the quarter
 * hour report goes from here.
 */
function rememberRestingFix(fix: {
  lat: number
  lon: number
  accuracyMeters?: number | null
}): void {
  const { mode, stillAnchor, policy } = useTrackingStore.getState()
  if (mode !== "stationary" || !stillAnchor || !placesPhone(fix)) return
  if (clearOf(stillAnchor, fix, stationaryRadiusMeters(policy))) return
  useTrackingStore.getState().setRestingFix({
    lat: fix.lat,
    lon: fix.lon,
    accuracyMeters: fix.accuracyMeters ?? null,
  })
}

/**
 * A parked phone's report when its newest fix is too vague to place it, a
 * cell-only session's estimate a kilometre wide, sent from the last fix that
 * did. Never from the anchor while there is one, since the anchor is where
 * the phone stopped, and the walk from there to the door can cross the line
 * of a place and back on every report.
 */
function stillHere(
  recordedAt: string,
  source: LocationSource,
  battery: BatterySnapshot,
): LocationFixInput {
  const { restingFix, stillAnchor } = useTrackingStore.getState()
  const here: RestingFix = restingFix ?? {
    lat: stillAnchor!.lat,
    lon: stillAnchor!.lon,
    accuracyMeters: stillAnchor!.accuracyMeters ?? null,
  }
  return {
    ...syntheticFix(here.lat, here.lon, source, battery),
    recordedAt,
    accuracyMeters: here.accuracyMeters,
  }
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
      leftAnchor(stillAnchor, fix, stationaryRadiusMeters(policy))
    ) {
      await enterMoving()
    } else {
      rememberRestingFix(fix)
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
    await checkStatusInBackground()
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
 * the fix the OS already has. One that does not clear the fence means the
 * phone has not left, and the word is "still here", from the anchor, dated
 * now. A last fix clear of the fence is a departure the session and the
 * fence both missed, and goes through ingest to end the stop.
 */
async function restingHeartbeat(): Promise<void> {
  const { enabled, mode, stillAnchor, policy } = useTrackingStore.getState()
  if (!enabled || mode !== "stationary" || AppState.currentState === "active") return
  try {
    await checkStatusInBackground()
    const last = await Location.getLastKnownPositionAsync().catch(() => null)
    const here = last
      ? {
          lat: last.coords.latitude,
          lon: last.coords.longitude,
          accuracyMeters: last.coords.accuracy,
        }
      : null
    const radius = stationaryRadiusMeters(policy)
    if (last && here && stillAnchor && leftAnchor(stillAnchor, here, radius)) {
      await ingest([last], "background")
      return
    }
    if (
      here &&
      stillAnchor &&
      clearOf(stillAnchor, here, radius) &&
      (await confirmedLeft(policy))
    ) {
      await enterMoving()
      return
    }
    if (!last && !stillAnchor) return
    if (here) rememberRestingFix(here)
    const battery = await batterySnapshot()
    const now = new Date().toISOString()
    const fix: LocationFixInput =
      last && here && (!stillAnchor || placesPhone(here))
        ? { ...toFix(last, "heartbeat", battery, "still"), recordedAt: now }
        : stillHere(now, "heartbeat", battery)
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
    // Most often the permission taken away, which the family should hear.
    await checkStatusInBackground()
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
  // The service goes down a moment after it is told to, and what it saw
  // in between belongs to a session that has ended or to sharing that is
  // off. Kept, it would upload with the next account to track here.
  if (fixes.length > 0 && !sharingOn()) {
    logTracker("native dropped", { fixes: fixes.length })
  } else if (fixes.length > 0) {
    fixes.sort((a, b) => a.timestamp - b.timestamp)
    // In order, in runs, so the stream reads as one journey whichever side sent each fix.
    let run: (Location.LocationObject & { sent?: boolean })[] = []
    for (const fix of fixes) {
      if (run.length > 0 && Boolean(run[0]!.sent) !== Boolean(fix.sent)) {
        await ingest(run, "background", { sent: Boolean(run[0]!.sent) })
        run = []
      }
      run.push(fix)
    }
    await ingest(run, "background", { sent: Boolean(run[0]!.sent) })
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
    case "fence_lost":
      // Location switched off, most often. The receiver has forgotten the
      // fence, and the next sync adds it back and looks for a departure.
      logTracker("fence lost", { code: event.code })
      await checkStatusInBackground()
      return
    case "service":
      logTracker("native service", {
        status: event.status,
        reason: event.reason,
        ...(event.error ? { error: event.error } : {}),
      })
      return
    case "boot":
      logTracker("native boot")
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
  const store = useTrackingStore.getState()
  store.recordUpload(event.accepted ?? 0)
  if (watchedNow()) tallyLive({ sent: event.sent, accepted: event.accepted ?? 0 })
  else logTracker("flush", { sent: event.sent, accepted: event.accepted ?? 0, native: true })
  await adoptWatch(event.watchedUntil, event.serverTime, event.sentAt)
  const policy = event.policy
  if (
    policy &&
    (policy.minUpdateIntervalSeconds !== store.policy.minUpdateIntervalSeconds ||
      policy.distanceFilterMeters !== store.policy.distanceFilterMeters)
  ) {
    store.setPolicy(policy)
    void applyPolicy()
  }
}

/**
 * The service went live on a push, before this side heard. The window is
 * taken as the service holds it, and nothing is registered, since the
 * service is already doing it.
 */
function adoptNativeWatch(until: number, openedAt: number): void {
  if (until <= Date.now()) return
  const store = useTrackingStore.getState()
  const held = store.watchedUntil ? Date.parse(store.watchedUntil) : 0
  windowTakenAt = Math.max(windowTakenAt, openedAt)
  liveInPlace = true
  if (until <= held) return
  logTracker("watched", {
    seconds: Math.round((until - Date.now()) / 1000),
    mode: store.mode,
    native: true,
  })
  store.setWatchedUntil(new Date(until).toISOString())
  armWatchTimer()
}

/**
 * Android starts this in a process it woke for the native queue, with no
 * screen and no React tree. Everything it needs is in module scope, and
 * the queue is the whole job, unless the tracking service opened it to
 * hold this side awake.
 */
export async function runHeadlessTask(data: { reason?: string } = {}): Promise<void> {
  if (data.reason === "awake") return keepTrackerAwake()
  logTracker("headless", { reason: data.reason ?? "unknown" })
  await processNativeQueue()
}

/**
 * React Native runs no JavaScript timer while the app is in the background
 * and no headless task is open, and fetch hands every response over on one.
 * A moving phone with its screen off sent nothing until a push or the sync
 * task happened to open a task, and Live showed a fix or two and then
 * stood still. The tracking service opens one task for as long as it runs,
 * and this holds it, draining the queue every few seconds, until the phone
 * parks with nobody watching. One hold however many tasks ask.
 */
const AWAKE_TICK_MS = 5_000
let awake: Promise<void> | null = null

export function keepTrackerAwake(): Promise<void> {
  awake ??= (async () => {
    logTracker("awake")
    try {
      // Drained before it decides, since what woke the service, a departure
      // or a watch, is in the queue and not yet in the store.
      for (;;) {
        await processNativeQueue()
        if (!wantsAwake()) break
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

function wantsAwake(): boolean {
  const { enabled, mode } = useTrackingStore.getState()
  return enabled && mode !== "off" && (mode === "moving" || watchedNow())
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
    await checkStatusInBackground()
    // WorkManager running is not one of Android's allowed moments, but some
    // OEMs let the start through, and asking costs nothing when it is up.
    await reassertService()
    await refreshPlacesIfStale()

    // Rather than trust the fence to be the only thing that can wake us, this
    // periodic pass re-arms it and independently checks whether the phone has
    // left. A fence that quietly fails would otherwise mean going dark on a
    // journey. Play Services drops every fence when Location is switched off,
    // and the app's own record of one says nothing about that, so on Android
    // the fence is added again on every pass, which the same id makes free.
    if (enabled && mode === "stationary" && stillAnchor) {
      const precise = await readPreciseLocation()
      const armed = await geofenceRunning()
      const rearmed = precise && !armed
      if (precise && androidNative()) {
        await armFence(stillAnchor.lat, stillAnchor.lon, stationaryRadiusMeters(policy)).catch(
          (error: Error) => logTracker("fence refused", { error: error.message }),
        )
      } else if (rearmed) {
        await enterStationary(stillAnchor.lat, stillAnchor.lon)
      }
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
          const left = leftAnchor(
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
    // The flush only starts an incident's alert. iOS suspends the app the
    // moment this returns, so the task waits for it here rather than in the
    // flush, which the alert's own fix goes through.
    await checkIncident()
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

/**
 * Android's "Approximate" and iOS with Precise Location off both leave the
 * permission at Always, with a fix kilometres wide, and neither OS arms a
 * geofence for it.
 */
function isPrecise(foreground: Location.LocationPermissionResponse): boolean {
  return Platform.OS === "android"
    ? foreground.android?.accuracy !== "coarse"
    : foreground.ios?.accuracy !== "reduced"
}

async function readPreciseLocation(): Promise<boolean> {
  try {
    const precise = isPrecise(await Location.getForegroundPermissionsAsync())
    useTrackingStore.getState().setPreciseLocation(precise)
    return precise
  } catch {
    return useTrackingStore.getState().preciseLocation
  }
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
 * A fixed filter is wrong at both ends of a drive: at walking pace it would
 * miss the first turn, on a motorway it would report every second. The filter
 * follows the speed so fixes land about one interval apart, and it moves in
 * steps so the request is not rebuilt for every wobble of the speedometer.
 * The step is always the one below, with a tenth to spare. A gate even a
 * metre wider than one interval's travel drops every other fix, and the
 * trail cuts the corners.
 */
export function drivingDistanceMeters(speedMps: number | null): number {
  const perInterval = ((speedMps ?? 0) * DRIVING_INTERVAL_MS) / 1000
  const stepped = Math.floor((perInterval * 0.9) / 50) * 50
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
 * Wi-Fi grade with one fix wanted a quarter hour, and no service runs under
 * it. A wake brings the brief service up for one fix, and a watch keeps it
 * up at the live request until the window ends. On iOS it
 * is a cell-only session with no distance filter: it costs almost nothing,
 * it keeps the process alive so the quarter hour heartbeat and the
 * classifier keep running, and a departure shows in the session's own
 * deliveries rather than at the fence's leisure. Without a session iOS
 * suspends the app within seconds, and the fence alone is reported minutes
 * late, or never with Background App Refresh off.
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
function currentOptions(watched = watchedNow()): Location.LocationTaskOptions | null {
  const { enabled, mode, policy, driving } = useTrackingStore.getState()
  // Off is derived like every other tier, so a transition that was queued
  // behind the stop lands on nothing rather than re-registering the service.
  if (!enabled || mode === "off") return null
  if (mode === "stationary") {
    // A phone lying still is as live as a moving one while somebody looks.
    // One fix and then silence reads as a broken connection on Live.
    return watched ? liveOptions(Location.Accuracy.High) : restingOptions()
  }
  // Somebody is looking. Full accuracy at the live interval for the window.
  if (watched) return liveOptions(Location.Accuracy.High)
  if (driving) return drivingOptions(driving.distance)
  return updateOptions(policy)
}

/**
 * Somebody has this phone's owner's Live page open. A fix at the live
 * interval, uploaded as it comes, for the watch window and no longer: the one
 * time the family wants to see a car move along a road is when they are
 * looking at it.
 */
function liveOptions(accuracy: Location.Accuracy): Location.LocationTaskOptions {
  return {
    accuracy,
    timeInterval: LIVE_INTERVAL_MS,
    // On the interval, whether or not the phone moved, so the first fix past
    // the window is always delivered and steps the tier down, and a car at
    // the lights sends the same spot on every tick, which is what live
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
 * A service found down while a tier wants it went down without the app
 * asking: an OEM battery manager, most often. Remembered for a day so the
 * health report can tell the family why, since the next re-assert brings
 * it straight back and the moment would otherwise leave no trace.
 */
function noteServiceDied(): void {
  useTrackingStore.getState().setServiceStoppedAt(new Date().toISOString())
  logTracker("service died")
  void tellHealth()
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
    // Off is sign-out, a server change or sharing off, and ends a watch too.
    await native.stopService(true)
    lastServiceStatus = "none"
    return "none"
  }
  if (watchedNow() && (await native.answersNatively())) {
    const status = await applyNativeWatch()
    if (status !== "refused") return status
  }
  if (options.foregroundService) {
    // A parked phone being watched keeps its resting request under the live
    // service. A service Android refuses, or kills inside the window, or one
    // a reboot takes, then leaves it reporting as it did before the watch.
    const parked = useTrackingStore.getState().mode === "stationary"
    if (parked && !(await locationUpdatesRunning())) {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, restingOptions())
    }
    const request = toServiceRequest(options)
    const status = await native.startService(request)
    lastServiceStatus = status
    logTracker("service", { status, priority: request.priority, interval: request.intervalMs })
    if (!parked && status === "refused") {
      // Refused, a moving phone is a background app with no request at all.
      // Expo's, on the tier's options with no service of its own, is
      // throttled to a few fixes an hour, and each is a chance to judge the
      // journey until the service can start.
      const { foregroundService: _refused, ...throttled } = options
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, throttled)
    } else if (!parked && (await locationUpdatesRunning())) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
    }
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
 * Somebody is watching and the service answers it itself, with a fix a
 * second, each sent as it comes, following the server's answers. The tier
 * underneath goes to the service too, so it steps back to it when the watch
 * ends, and a parked phone keeps its resting request running under the
 * watch, as it always has. A start Android refuses falls through to the
 * old way.
 */
async function applyNativeWatch(): Promise<ForegroundServiceStatus> {
  const { watchedUntil, mode } = useTrackingStore.getState()
  const seconds = Math.max(1, Math.ceil((Date.parse(watchedUntil!) - Date.now()) / 1000))
  if (mode === "stationary" && !(await locationUpdatesRunning())) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, restingOptions())
  }
  if (!(await native.watch(seconds))) return "refused"
  const tier = currentOptions(false)
  if (tier?.foregroundService) {
    await native.startService(toServiceRequest(tier))
    if (await locationUpdatesRunning())
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
  } else {
    await native.stopService()
  }
  lastServiceStatus = "running"
  logTracker("service", { status: "running", live: true, native: true })
  return "running"
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
      activity: currentActivity(),
    })
    .catch(() => undefined)
  await syncUploader()
}

/**
 * Where the native side sends, and the session's upload key to send with,
 * so a wake or a Live request is answered without this side. Only while
 * sharing is on, and only once the server has handed out a key. An older
 * server has none, and the phone answers from here as it always did.
 */
async function syncUploader(): Promise<void> {
  if (!androidNative()) return
  const { enabled, mode } = useTrackingStore.getState()
  const key = tokenVault.peek()?.uploadKey
  let url: string | null = null
  try {
    url = api.url("/locations/batch")
  } catch {
    url = null
  }
  if (enabled && mode !== "off" && key && url) await native.setUploader(url, key)
  else await native.clearUploader()
}

// A rotation can bring the first key a session has, after an update.
tokenListeners.add(() => void syncUploader())

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
  // A parked phone wants no location service unless somebody is watching
  // it, and a wake runs the wake service.
  if (!enabled || (mode !== "moving" && !(mode === "stationary" && watchedNow()))) return
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
 * When this phone last took a window from an ask, and whether this process
 * has put the live tier in place for it. A reply to an upload sent before
 * the ask is older news than the ask, and a hold on a window already live
 * changes when it ends and nothing else.
 */
let windowTakenAt = 0
let liveInPlace = false

/**
 * Somebody opened this phone's owner's page. The phone goes live for the
 * window whatever it was doing, and answers with one fix straight away:
 * iOS ignores the interval and delivers on distance, so a phone at rest
 * would otherwise say nothing for the whole window. The window ends by the
 * clock, by the first fix past it, and when the server says nobody is
 * watching any more, whichever comes first.
 *
 * The page holds its window with an ask a minute. One for a window already
 * live only moves the end, since a fresh one-shot fix every minute is a
 * Wi-Fi grade dot dropped into a stream of GPS ones. It still puts back a
 * live service Android stopped, at once when the ask came by push, which is
 * one of the moments Android allows the start.
 */
export async function enterWatched(
  seconds: number,
  { push = false }: { push?: boolean } = {},
): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled || store.mode === "off") return
  if (seconds <= 0) {
    await endWatch("ended")
    return
  }
  windowTakenAt = Date.now()
  const until = new Date(Date.now() + seconds * 1000).toISOString()
  if (liveInPlace && watchedNow()) {
    store.setWatchedUntil(until)
    armWatchTimer()
    if (await answeredNatively()) await native.watch(seconds)
    await reassertService({ exempt: push })
    return
  }
  logTracker("watched", { seconds, mode: store.mode })
  store.setWatchedUntil(until)
  armWatchTimer()
  liveInPlace = true
  // A parked Android phone goes live under the brief service the watch
  // push brought up, upgraded in place. Where Android refused it anyway,
  // the window is still held, so the upload reply cannot ask again and
  // spin, and the answer is one fix.
  const status = await applyRegistration()
  if (Platform.OS === "android" && store.mode === "stationary" && status === "refused") {
    await wakeFix()
    return
  }
  // The service sends its first live fix itself, a second or two from now.
  if (await answeredNatively()) return
  await reportNow(
    "nudge",
    store.mode === "stationary" ? Location.Accuracy.Balanced : Location.Accuracy.High,
    { judge: store.mode === "stationary" },
  )
}

/**
 * The upload reply says until when somebody has this phone's owner's page
 * open. A moving phone uploads with each fix, so this reaches it whether or
 * not the silent push did. The window is measured against the server's
 * own clock, since the phone's may be minutes out. A window already held is
 * moved, never re-registered, and a reply that names no window, or a
 * shorter one, means the viewers who held it have gone. Only a reply to an
 * upload sent after the last ask can say that.
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
    mode: store.mode,
    ...(why === "over" ? {} : { why }),
    ...(fromNative ? { native: true } : {}),
  })
  // The service follows the server's answers and its own clock, so only a
  // viewer leaving is passed on. A timer here running ahead of an answer
  // not yet drained must not end a watch the server still holds.
  if (why === "ended" && !fromNative && androidNative()) await native.endWatch()
  if (store.mode !== "off") await applyRegistration()
}

/** Whether the native side answers a wake or a watch on this phone, with its own upload. */
export async function answeredNatively(): Promise<boolean> {
  return androidNative() && (await native.answersNatively())
}

/**
 * A wake from a push. The native service has already answered it where it
 * can, and what it sent is in the queue to learn from. Otherwise the fix
 * is taken from here.
 */
export async function answerWake(): Promise<void> {
  if (await answeredNatively()) {
    await processNativeQueue()
    return
  }
  await wakeFix()
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
  const repeated = activity === store.lastVerdict
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
      void raiseIncident(event)
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
      // So is a sure one that only repeats the verdict the phone parked on,
      // since Core Motion keeps calling a car idling in a car park automotive.
      const trusted = source === "transition" || (confidence >= MOTION_SURE_CONFIDENCE && !repeated)
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
  else lookAgainLater()
}

/**
 * The confirming fix comes half a minute to a minute out of the door, when a
 * walker is still inside the fence and its error, and without another look
 * only the fence would notice. One more a few minutes on has them clear. It
 * is a timer, so it lands where the process is still about, which is always
 * on a parked iPhone and on Android only while Android keeps the process.
 */
const WALK_SECOND_LOOK_MS = 3 * 60 * 1000
let secondLook: ReturnType<typeof setTimeout> | null = null

function lookAgainLater(): void {
  if (secondLook) return
  secondLook = setTimeout(() => {
    secondLook = null
    void (async () => {
      const { enabled, mode, policy } = useTrackingStore.getState()
      if (!enabled || mode !== "stationary") return
      logTracker("walk checked again")
      if (await confirmedLeft(policy)) await enterMoving()
    })()
  }, WALK_SECOND_LOOK_MS)
}

function cancelSecondLook(): void {
  if (secondLook) clearTimeout(secondLook)
  secondLook = null
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
  const left =
    fix != null && anchor != null && leftAnchor(anchor, fix, stationaryRadiusMeters(policy))
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
  cancelSecondLook()
  // A still streak counted before the departure is not evidence about the
  // journey that follows, and nor is where the phone sat.
  store.setMotionStillSince(null)
  store.setRestingFix(null)
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
  let arrival: number | null | undefined = store.stillAnchor?.accuracyMeters
  let resting: RestingFix | null = store.restingFix
  if (previous !== "stationary" && parkFix !== "none") {
    const park = await sendParkFix(lat, lon, parkFix)
    arrival = park.accuracyMeters
    resting = { lat: park.lat, lon: park.lon, accuracyMeters: park.accuracyMeters ?? null }
    // Sharing went off, or a departure landed, while the fix was on its way.
    if (useTrackingStore.getState().mode !== previous) {
      logTracker("park abandoned", { mode: useTrackingStore.getState().mode })
      return
    }
  }
  const precise = await readPreciseLocation()
  if (!precise) {
    // No fence to arm, and holding out for one keeps the service up all day.
    // The resting request and the classifier still see a departure.
    await dropFence()
  } else {
    try {
      await armFence(lat, lon, stationaryRadiusMeters(store.policy))
    } catch {
      // With nothing armed to wake us there would be no way back, so it is safer
      // to keep the full tier than to go silent. The anchor is re-dated so the
      // phone sits still for the whole window again before the next attempt.
      // A permission short of Always throws here every time, and retrying on
      // the next fix would spend a fix and an upload per delivery.
      store.setStillAnchor({ lat, lon, since: new Date().toISOString() })
      await enterMoving()
      return
    }
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
  // No coordinates. The log is shared into issues and chats, and where a
  // phone parks is usually somebody's home.
  logTracker("stationary", { from: previous, ...(precise ? {} : { fence: false }) })
  syncControl()
  // A parked phone reports on its resting request, so a death remembered
  // from the drive is no longer what stands between it and reporting.
  store.setServiceStoppedAt(null)
  // Sampling the accelerometer that hard is only worth its battery inside a
  // moving vehicle. A verdict already scheduled survives this, see
  // stopDriveSensors.
  stopDriveSensors()
  // The sweep's re-arm and the relaunch path both read stillAnchor as the spot
  // the phone is parked at, and neither runs while it is null. Writing it here
  // is what keeps it the same point as the fence however the stop was called.
  store.setStillAnchor({
    lat,
    lon,
    since: new Date().toISOString(),
    accuracyMeters: arrival ?? null,
  })
  store.setRestingFix(resting ?? { lat, lon, accuracyMeters: arrival ?? null })
  store.setBackgroundActive(true)
  armBackgroundClock()
}

/**
 * The word "still" has to leave even when the OS gave no fix. The phone's own
 * newest position stands in while it is fresh, with its accuracy, because the
 * anchor is where the stop began and a report since may have the phone
 * somewhere else: one park fix put a phone back 174 m from where it was
 * sitting, dated now and read by the server as exact.
 */
const PARK_FIX_FRESH_MS = 2 * 60 * 1000

function madeUpParkFix(lat: number, lon: number, battery: BatterySnapshot): LocationFixInput {
  const { lastFix } = useTrackingStore.getState()
  const fresh =
    lastFix != null &&
    lastFix.accuracyMeters != null &&
    Date.now() - Date.parse(lastFix.recordedAt) <= PARK_FIX_FRESH_MS
  if (!fresh) return syntheticFix(lat, lon, "significant", battery)
  return {
    ...syntheticFix(lastFix.lat, lastFix.lon, "significant", battery),
    accuracyMeters: lastFix.accuracyMeters,
  }
}

/**
 * The arrival fix, stamped still whatever the tracker's verdict, uploaded
 * before the request steps down. When the OS does not answer in time the
 * anchor itself is sent, dated now: where the phone stopped is known, and
 * the server hearing "still" is what turns its hour rule into its twelve
 * hour one.
 */
async function sendParkFix(
  lat: number,
  lon: number,
  how: Exclude<ParkFix, "none">,
): Promise<LocationFixInput> {
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
    fix = madeUpParkFix(lat, lon, await batterySnapshot())
    useTrackingStore.getState().enqueue([fix])
  }
  await flush()
  logTracker("park fix", {
    synthesized,
    acc: Math.round(fix.accuracyMeters ?? -1),
    ms: Date.now() - started,
    uploaded: !useTrackingStore.getState().queue.some((queued) => queued === fix),
  })
  return fix
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

/**
 * Whether a fix proves a parked phone left its anchor, by being clear of it
 * and sharp enough to mean it. A phone allowed only approximate location
 * never gets a sharper fix, so for it clearing the circle by its error is
 * enough.
 */
function leftAnchor(
  anchor: { lat: number; lon: number },
  fix: { lat: number; lon: number; accuracyMeters?: number | null },
  radiusMeters: number,
): boolean {
  if (!clearOf(anchor, fix, radiusMeters)) return false
  if (!useTrackingStore.getState().preciseLocation) return true
  const accuracy = fix.accuracyMeters
  return accuracy != null && accuracy >= 0 && accuracy <= DEPARTURE_MAX_ACCURACY_METERS
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

  // Keeping a dead foreground service alive would show a notification claiming
  // to share a position we cannot get, and a phone allowed only "while
  // using" cannot arm a fence or run in the background at all: it reports
  // from the foreground heartbeat until Always is granted, as startTracking
  // already decides.
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

/**
 * The fix the OS already has, so asking costs nothing. It is the only thing
 * that can tell us the anchor went stale while the process was dead, taking
 * the geofence with it.
 */
async function hasLeft(anchor: { lat: number; lon: number }): Promise<boolean> {
  const last = await Location.getLastKnownPositionAsync().catch(() => null)
  if (!last) return false
  return leftAnchor(
    anchor,
    {
      lat: last.coords.latitude,
      lon: last.coords.longitude,
      accuracyMeters: last.coords.accuracy,
    },
    stationaryRadiusMeters(useTrackingStore.getState().policy),
  )
}

let starting: Promise<boolean> | null = null

/**
 * Foreground permission is enough to start, but only "always" keeps it
 * running. One start at a time. The app coming back, a sign-in and the
 * switch can ask in the same moment, and two starts that both found the
 * tracker off would both park it.
 */
export function startTracking(): Promise<boolean> {
  starting ??= beginTracking().finally(() => {
    starting = null
  })
  return starting
}

async function beginTracking(): Promise<boolean> {
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
  logLiveTally()
  logTracker("off")
  cancelSecondLook()
  stopForegroundHeartbeat()
  stopBackgroundClock()
  clearRetry()
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = null
  liveInPlace = false
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
  if (androidNative()) await native.clearQueue().catch(() => undefined)
  await dropFence()
  await stopMotionWatch()
  stopDriveSensors()
  store.setStillAnchor(null)
  store.setRestingFix(null)
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
 * sharing, which the lines below cannot always be read back to. The anchor
 * goes in by its age alone, for the same reason the log holds no positions.
 */
export function headerForTrackerLog(): string {
  const {
    mode,
    stillAnchor,
    queue,
    lastError,
    permission,
    preciseLocation,
    driving,
    watchedUntil,
    enabled,
    uploadsRefusedAt,
  } = useTrackingStore.getState()
  return [
    `mode ${mode}${driving ? ` (driving, gate ${driving.distance} m)` : ""}${enabled ? "" : " (sharing off)"}`,
    `anchor ${stillAnchor ? `since ${stillAnchor.since}` : "none"}`,
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
  // reachable again before anyone opens a page on it. The first try runs
  // before the keychain has handed over the tokens, so it is made again
  // once it has, rather than at the next rotation a quarter hour away.
  syncControl()
  void tokenVault.hydrate().then(syncControl)
  // Whatever the native side saw while this process was down is the first
  // thing this one deals with, and every poke after is dealt with the same way.
  native.onNativeQueue(() => void processNativeQueue())
  if (enabled && mode !== "off") {
    void syncNativeState().then(() => processNativeQueue())
  }
}
