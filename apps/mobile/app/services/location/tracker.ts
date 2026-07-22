import { AppState, Platform } from "react-native"
import * as BackgroundTask from "expo-background-task"
import * as Battery from "expo-battery"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import { haversineMeters, type LocationFixInput, type LocationSource } from "@hearth/shared"

import { translate } from "@/i18n/translate"
import { ApiError, endpoints } from "@/services/api"
import { presentIncidentAlarm } from "@/services/incidentAlarm"
import { useAuthStore } from "@/stores/auth"
import { startMotion, stopMotion, type MotionActivity } from "@/services/location/motion"
import { startDriveSensors, stopDriveSensors } from "@/services/location/driveSensors"
import { useIncidentStore } from "@/stores/incident"
import { useSettingsStore } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore, type PermissionLevel, type TrackingPolicy } from "@/stores/tracking"

export const BACKGROUND_LOCATION_TASK = "hearth-background-location"
/** Must match BGTaskSchedulerPermittedIdentifiers in app.json. */
export const BACKGROUND_SYNC_TASK = "com.binary.rewind.hearth.sync"
/** Armed around wherever the phone stopped, so leaving wakes us back up. */
export const STATIONARY_GEOFENCE_TASK = "hearth-stationary-geofence"

const MAX_BATCH = 200
const STALE_FIX_MS = 30 * 60 * 1000
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

/**
 * Android will not hand out continuous location without a foreground service,
 * and a location foreground service must show a notification. What drains the
 * battery is not the service but the GPS behind it, which never sleeps while
 * the phone is treated as moving.
 *
 * So the GPS runs only while the phone is moving. Once it has sat still, the
 * service steps down to the resting watch, see restingOptions, and an OS
 * geofence, which is cheap because it rides on the location the system is
 * already computing for everything else, is what brings the GPS back.
 */
const STILL_RADIUS_METERS = 60
const STILL_AFTER_MS = 5 * 60 * 1000
/** Bigger than the still radius so GPS jitter at a standstill cannot trip it. */
const STATIONARY_GEOFENCE_RADIUS_METERS = 150
/**
 * iOS does not reliably report an exit from a region much under this, so a
 * tighter fence there can simply never fire and the phone rests into the
 * first minutes of a drive. Android's fences are fine at the floor above.
 */
const IOS_GEOFENCE_MIN_METERS = 200

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

async function batterySnapshot(): Promise<{
  batteryLevel: number | null
  isCharging: boolean | null
}> {
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
  battery: { batteryLevel: number | null; isCharging: boolean | null },
): LocationFixInput {
  const c = location.coords
  return {
    recordedAt: new Date(location.timestamp).toISOString(),
    lat: c.latitude,
    lon: c.longitude,
    // iOS reports a negative accuracy to mean "this component is invalid",
    // which is routine for altitude on a Wi-Fi or cell derived fix. Sending it
    // on is how a whole batch used to be rejected and then thrown away.
    accuracyMeters: c.accuracy != null && c.accuracy >= 0 ? c.accuracy : null,
    altitudeMeters: c.altitude ?? null,
    altitudeAccuracyMeters:
      c.altitudeAccuracy != null && c.altitudeAccuracy >= 0 ? c.altitudeAccuracy : null,
    speedMps: c.speed != null && c.speed >= 0 ? c.speed : null,
    headingDegrees: c.heading != null && c.heading >= 0 ? c.heading : null,
    batteryLevel: battery.batteryLevel,
    isCharging: battery.isCharging,
    source,
  }
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
    }
    kept.push(fix)
    last = fix
  }
  return kept
}

let flushing: Promise<void> | null = null

/**
 * Network failures leave the queue intact for the next attempt. A 4xx that is
 * not an auth problem means the batch itself is bad, so it gets dropped. One
 * poison fix must not wedge the pipeline forever.
 */
export function flush(): Promise<void> {
  if (!flushing) {
    flushing = doFlush().finally(() => {
      flushing = null
    })
  }
  return flushing
}

async function doFlush(): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled) return
  if (!useAuthStore.getState().serverUrl) return
  if (!(await tokenVault.hydrate())) return

  while (useTrackingStore.getState().queue.length > 0) {
    const batch = useTrackingStore.getState().queue.slice(0, MAX_BATCH)
    try {
      const result = await endpoints.locations.upload(batch)
      useTrackingStore.getState().dequeue(batch)
      useTrackingStore.getState().recordUpload(result.accepted)
      if (
        result.policy.minUpdateIntervalSeconds !== store.policy.minUpdateIntervalSeconds ||
        result.policy.distanceFilterMeters !== store.policy.distanceFilterMeters
      ) {
        useTrackingStore.getState().setPolicy(result.policy)
        void applyPolicy(result.policy)
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.isNetwork || error.status >= 500 || error.status === 429) {
          useTrackingStore.getState().setError(error.message)
          return
        }
        if (error.status === 401) {
          useTrackingStore.getState().setError("Signed out. Sharing paused.")
          return
        }
        // Validation or permission failure, so this batch will never succeed.
        useTrackingStore.getState().dequeue(batch)
        useTrackingStore.getState().setError(error.message)
        continue
      }
      useTrackingStore.getState().setError((error as Error).message)
      return
    }
  }
}

export async function ingest(locations: Location.LocationObject[], source: LocationSource) {
  if (locations.length === 0) return
  const battery = await batterySnapshot()
  const state = useTrackingStore.getState()
  let fixes = thin(
    locations.map((location) => toFix(location, source, battery)),
    state.lastFix,
    state.policy,
  )
  if (source === "background" && state.mode === "stationary") {
    fixes = await restingFixes(fixes)
  }
  if (fixes.length === 0) return
  state.enqueue(fixes)
  const newest = fixes[fixes.length - 1]
  if (newest && source === "background") {
    await evaluateStillness(newest)
    if (useTrackingStore.getState().mode === "moving") await trackDriveBySpeed(newest)
  }
  await flush()
}

/**
 * The resting watch is cheap but not quiet: iOS in particular hands over a
 * new estimate whenever the Wi-Fi picture shifts. One fix per heartbeat is
 * all the server needs while the phone stays put. A fix outside the circle
 * means the phone left and the fence never said so, which Android's fences
 * do after the process is killed, so that one goes through and brings the
 * full service back.
 */
async function restingFixes(fixes: LocationFixInput[]): Promise<LocationFixInput[]> {
  const { stillAnchor, lastFix, policy } = useTrackingStore.getState()
  const radius = stationaryRadiusMeters(policy)
  const left = fixes.find((fix) => stillAnchor && haversineMeters(stillAnchor, fix) > radius)
  if (left) {
    await enterMoving()
    return fixes.slice(fixes.indexOf(left))
  }
  const newest = fixes[fixes.length - 1]
  if (!newest) return []
  const age = lastFix ? Date.parse(newest.recordedAt) - Date.parse(lastFix.recordedAt) : Infinity
  return age >= RESTING_HEARTBEAT_MS ? [newest] : []
}

/** Fixes still being acquired, which the heartbeat counts as fresh. */
let acquiring = 0

export async function reportNow(
  source: LocationSource = "manual",
  accuracy: Location.Accuracy = source === "sos"
    ? Location.Accuracy.Highest
    : Location.Accuracy.High,
): Promise<LocationFixInput | null> {
  acquiring += 1
  try {
    const location = await Location.getCurrentPositionAsync({ accuracy })
    const battery = await batterySnapshot()
    const fix = toFix(location, source, battery)
    useTrackingStore.getState().enqueue([fix])
    await flush()
    return fix
  } catch (error) {
    useTrackingStore.getState().setError((error as Error).message)
    return null
  } finally {
    acquiring -= 1
  }
}

/**
 * Nothing above refreshes the user's own row while they sit looking at the
 * map. The OS holds back every fix closer than the distance filter, a parked
 * phone has stopped asking for updates altogether, and the sync task never
 * runs while the app is open. So while it is open, and only then, ask for a
 * fix at the circle's interval whenever the last one is older than that.
 *
 * The mode is read and never written. A parked phone stays parked, fence and
 * anchor untouched, because one Balanced fix is far cheaper than bringing the
 * foreground service back for a phone that has not moved.
 */
let heartbeat: ReturnType<typeof setTimeout> | null = null

export function startForegroundHeartbeat(): void {
  // Coming back after a while away is the moment the row reads stalest.
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
  const { policy } = useTrackingStore.getState()
  heartbeat = setTimeout(() => {
    scheduleHeartbeat()
    void heartbeatTick()
  }, policy.minUpdateIntervalSeconds * 1000)
}

/**
 * Android's getCurrentPositionAsync has no timeout of its own. Left hanging, the
 * fix would hold the in-flight count up and every later tick would read it as
 * fresh, for the rest of the process.
 */
const HEARTBEAT_FIX_TIMEOUT_MS = 30_000

async function heartbeatTick(): Promise<void> {
  const store = useTrackingStore.getState()
  if (AppState.currentState !== "active") return
  if (!store.enabled || store.mode === "off") return
  if (store.permission === "denied" || !store.servicesEnabled) return
  if (acquiring > 0) return
  const age = store.lastFix ? Date.now() - Date.parse(store.lastFix.recordedAt) : Infinity
  if (age < store.policy.minUpdateIntervalSeconds * 1000) return

  acquiring += 1
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const location = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Heartbeat fix timed out")),
          HEARTBEAT_FIX_TIMEOUT_MS,
        )
      }),
    ])
    const battery = await batterySnapshot()
    useTrackingStore.getState().enqueue([toFix(location, "heartbeat", battery)])
    await flush()
  } catch {
    // Not reportNow, because that pins the failure on the You screen, and a
    // fix that times out indoors would repaint it red every interval.
  } finally {
    clearTimeout(deadline)
    acquiring -= 1
  }
}

// defineTask has to run at module scope. The OS can hand us a background event
// before any React code has mounted.
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    useTrackingStore.getState().setError(error.message)
    return
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? []
  await ingest(locations, "background")
})

/**
 * The only thing listening while the phone is parked. Leaving the circle we
 * drew around the stopping point means a journey started, so bring the service
 * back and start reporting properly again.
 */
TaskManager.defineTask(STATIONARY_GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    useTrackingStore.getState().setError(error.message)
    return
  }
  const event = data as { eventType?: Location.GeofencingEventType } | undefined
  if (event?.eventType !== Location.GeofencingEventType.Exit) return
  if (!useTrackingStore.getState().enabled) return
  await enterMoving()
  // The process may have been killed while parked, so this task can be the
  // first thing to run in a fresh one. Bringing location back without the
  // classifier left the stop to the slow GPS heuristic and crash detection off
  // for the whole journey.
  await startMotionWatch()
  await reportNow("significant")
})

/** Waking the location stack is the one thing "stationary" exists to avoid. */
const DRIFT_CHECK_MS = 60 * 60 * 1000

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const { enabled, mode, policy, stillAnchor, lastDriftCheckAt } = useTrackingStore.getState()

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
          const here = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          })
          const drift = haversineMeters(
            { lat: stillAnchor.lat, lon: stillAnchor.lon },
            { lat: here.coords.latitude, lon: here.coords.longitude },
          )
          // Waking the location stack already spent the battery this mode
          // exists to save, so the fix is worth reporting whether or not it
          // turns out to be far enough to call the stop over.
          await ingest([here], "significant")
          if (drift > stationaryRadiusMeters(policy)) {
            await enterMoving()
          }
        } catch {
          // No fix available this wake. The fence is still armed.
        }
      }
    }

    // The OS stops delivering while the phone sits inside the distance filter,
    // so a journey that ends in the background produces no fix to judge and
    // nothing else would ever call the stop. Without this pass the service, and
    // its notification, stay on for good.
    if (enabled && mode === "moving") {
      try {
        const here = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        })
        await evaluateStillness({
          lat: here.coords.latitude,
          lon: here.coords.longitude,
          recordedAt: new Date(here.timestamp).toISOString(),
        })
      } catch {
        // No fix available this wake, so it stays moving until the next one.
      }
    }

    // Read back rather than reused from above, because the drift check may
    // have just reported a fix and a second wake of the GPS in the same pass is
    // the cost stationary mode exists to avoid.
    //
    // Signing out leaves `enabled` true, because it is the user's switch rather
    // than the session's, so without the mode check a signed-out phone holding
    // "Always" woke the receiver every half hour for good and queued fixes no
    // session could ever upload.
    const { mode: currentMode, lastFix } = useTrackingStore.getState()
    const stale = !lastFix || Date.now() - Date.parse(lastFix.recordedAt) > STALE_FIX_MS
    if (enabled && currentMode !== "off" && stale && (await currentPermission()) === "always") {
      // Balanced, like the drift check: this repeats on a timer for as long as
      // the phone stays put, and it is the wake the rest of this task is built
      // to avoid paying for.
      await reportNow("significant", Location.Accuracy.Balanced)
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
 * The only notification the service ever shows, and only while the phone is
 * on the move, since that is the only time Android needs a foreground
 * service for live updates. Plain, no colour, on a channel the app created
 * at minimum importance, and on Android 13 and later the user can swipe it
 * away. A parked phone runs no service and shows nothing.
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
    distanceInterval: distanceMeters,
    // Live means live. Deferral is for the walking tier.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: SERVICE_NOTIFICATION,
  }
}

/** The drive as the tracker sees it. Not persisted: a relaunch starts walking and lets the classifier say otherwise. */
let driving: { distance: number; slowSince: number | null } | null = null

export function isDriving(): boolean {
  return driving !== null
}

export async function enterDriving(speedMps: number | null): Promise<void> {
  const store = useTrackingStore.getState()
  if (store.mode !== "moving") return
  const distance = drivingDistanceMeters(speedMps)
  if (driving?.distance === distance) return
  driving = { distance, slowSince: driving?.slowSince ?? null }
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, drivingOptions(distance))
}

export async function leaveDriving(): Promise<void> {
  if (!driving) return
  driving = null
  const store = useTrackingStore.getState()
  if (store.mode !== "moving") return
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, updateOptions(store.policy))
}

/**
 * Speed is the second opinion on driving: it starts the tier on a phone with
 * no motion permission, keeps the filter elastic through a drive, and ends
 * the tier after a few minutes of crawling, which the classifier can miss
 * when a phone sits face down in a footwell after arriving.
 */
async function trackDriveBySpeed(fix: LocationFixInput): Promise<void> {
  const speed = fix.speedMps
  if (speed == null) return
  if (!driving) {
    if (speed >= DRIVING_SPEED_MPS) await enterDriving(speed)
    return
  }
  const at = Date.parse(fix.recordedAt)
  if (speed < DRIVING_STOP_SPEED_MPS) {
    driving.slowSince ??= at
    if (at - driving.slowSince >= DRIVING_STOP_AFTER_MS) await leaveDriving()
    return
  }
  driving.slowSince = null
  await enterDriving(speed)
}

function updateOptions(policy: TrackingPolicy): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: policy.minUpdateIntervalSeconds * 1000,
    distanceInterval: policy.distanceFilterMeters,
    // Let the OS batch deliveries while the phone is still. The server dedupes.
    // No distance alongside it: Android requires both conditions, so a distance
    // holds back the fixes from the end of a journey, which are the ones that
    // say the phone has parked.
    deferredUpdatesInterval: Math.max(60_000, policy.minUpdateIntervalSeconds * 2000),
    // iOS does this natively: it parks the GPS when you stop and wakes on
    // motion. Turning it off was throwing away the same saving we now build by
    // hand on Android.
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: SERVICE_NOTIFICATION,
  }
}

/**
 * Parked is not silent, but it is quiet. The request stays registered at
 * Wi-Fi grade with no GPS, so iOS keeps the app alive and reports as its
 * estimate shifts, which restingFixes thins to one fix a quarter hour. On
 * Android the request stays too but without the foreground service, which
 * is what takes the notification away: registering without that option
 * stops a running service. A background app then gets a few fixes an hour
 * from the OS, the periodic sync re-arms the fence, and the server's silent
 * wake asks for a fix after half an hour of nothing. The service comes back
 * the moment the phone moves.
 */
function restingOptions(): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: RESTING_HEARTBEAT_MS,
    distanceInterval: 0,
    // A paused manager suspends the app with it, and nothing would wake it
    // short of the fence.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
  }
}

let motionSubscription: { remove: () => void } | null = null
let motionStarting = false
let motionStillSince: number | null = null

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
    motionSubscription = await startMotion((activity, confidence) => {
      void onMotion(activity, confidence)
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
  motionStillSince = null
  // With the classifier gone nothing will report a change, so this is the last
  // moment anything asks the sensors to stop. Leaving them running samples at
  // 50Hz for a journey nobody is watching.
  stopDriveSensors()
}

async function onMotion(activity: MotionActivity, confidence: number): Promise<void> {
  const store = useTrackingStore.getState()
  if (!store.enabled || confidence < MOTION_MIN_CONFIDENCE) return

  // Impact sensing is only worth its battery inside a vehicle, and only there
  // can its signals be read honestly: a spike while walking is a dropped phone.
  if (activity === "automotive" && useSettingsStore.getState().incidentDetection) {
    void startDriveSensors((event) => {
      // Harsh braking is a driving quality signal with nowhere to go yet, so
      // only a possible impact is acted on.
      if (event.kind !== "possibleImpact") return
      useIncidentStore.getState().raise(event)
      // The modal only helps someone already looking at the screen.
      void presentIncidentAlarm(translate("incident:alarmTitle"), translate("incident:alarmBody"))
    })
  } else if (activity !== "unknown") {
    stopDriveSensors()
  }

  if (activity === "automotive") {
    if (store.mode === "stationary") await enterMoving()
    await enterDriving(store.lastFix?.speedMps ?? null)
  } else if (activity !== "unknown" && driving) {
    await leaveDriving()
  }

  if (activity === "still") {
    if (store.mode !== "moving") return
    motionStillSince ??= Date.now()
    if (Date.now() - motionStillSince < MOTION_STILL_CONFIRM_MS) return
    const fix = store.lastFix
    if (fix) await enterStationary(fix.lat, fix.lon)
    return
  }

  if (activity === "unknown") return

  // Movement of any kind ends a stop, and the OS knew before a geofence or the
  // periodic wake would have.
  motionStillSince = null
  if (store.mode === "stationary") {
    await enterMoving()
    await reportNow("significant")
  }
}

async function locationUpdatesRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false)
}

async function geofenceRunning(): Promise<boolean> {
  return Location.hasStartedGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => false)
}

/** Continuous updates on. This is the state that shows the Android notification. */
export async function enterMoving(): Promise<void> {
  const store = useTrackingStore.getState()
  if (await geofenceRunning()) {
    await Location.stopGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => {})
  }
  // Registering again on a running task swaps its options, which is how the
  // resting watch is stepped back up to the full one. A drive is decided
  // afresh from the fixes that follow.
  driving = null
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, updateOptions(store.policy))
  store.setStillAnchor(null)
  store.setMode("moving")
  store.setBackgroundActive(true)
}

/** Geofence armed, service stepped down to the resting watch. */
export async function enterStationary(lat: number, lon: number): Promise<void> {
  const store = useTrackingStore.getState()
  try {
    await Location.startGeofencingAsync(STATIONARY_GEOFENCE_TASK, [
      {
        latitude: lat,
        longitude: lon,
        radius: stationaryRadiusMeters(store.policy),
        notifyOnEnter: false,
        notifyOnExit: true,
      },
    ])
  } catch {
    // With nothing armed to wake us there would be no way back, so it is safer
    // to keep burning the service than to go silent.
    await enterMoving()
    return
  }
  driving = null
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, restingOptions())
  // Sampling the accelerometer that hard is only worth its battery inside a
  // moving vehicle. A verdict already scheduled survives this, see
  // stopDriveSensors.
  stopDriveSensors()
  // The sweep's re-arm and the relaunch path both read stillAnchor as the spot
  // the phone is parked at, and neither runs while it is null. Writing it here
  // is what keeps it the same point as the fence however the stop was called.
  store.setStillAnchor({ lat, lon, since: new Date().toISOString() })
  store.setMode("stationary")
  store.setBackgroundActive(true)
}

/**
 * A phone that has not left a small circle for a few minutes has arrived
 * somewhere. Anchoring on the first fix of the stretch rather than the previous
 * one means slow drift cannot keep resetting the clock.
 */
export type StillnessDecision = "settle" | "reanchor" | "wait"

export function stillnessDecision(
  anchor: { lat: number; lon: number; since: string } | null,
  fix: Pick<LocationFixInput, "lat" | "lon" | "recordedAt">,
  radiusMeters: number = STILL_RADIUS_METERS,
): StillnessDecision {
  if (!anchor) return "reanchor"
  const moved = haversineMeters(
    { lat: anchor.lat, lon: anchor.lon },
    { lat: fix.lat, lon: fix.lon },
  )
  if (moved > radiusMeters) return "reanchor"
  return Date.parse(fix.recordedAt) - Date.parse(anchor.since) >= STILL_AFTER_MS ? "settle" : "wait"
}

async function evaluateStillness(
  fix: Pick<LocationFixInput, "lat" | "lon" | "recordedAt">,
): Promise<void> {
  const store = useTrackingStore.getState()
  if (store.mode !== "moving") return

  const anchor = store.stillAnchor
  switch (stillnessDecision(anchor, fix, stillRadiusMeters(store.policy))) {
    case "reanchor":
      store.setStillAnchor({ lat: fix.lat, lon: fix.lon, since: fix.recordedAt })
      return
    case "settle":
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
  // to share a position we cannot get.
  if (store.enabled && store.mode !== "off" && (permission === "denied" || !servicesEnabled)) {
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
  const away = haversineMeters(
    { lat: anchor.lat, lon: anchor.lon },
    { lat: last.coords.latitude, lon: last.coords.longitude },
  )
  return away > stationaryRadiusMeters(useTrackingStore.getState().policy)
}

/** Foreground permission is enough to start, but only "always" keeps it running. */
export async function startTracking(): Promise<boolean> {
  const permission = await currentPermission()
  useTrackingStore.getState().setPermission(permission)
  if (permission !== "always" && permission !== "foreground") return false

  // mode and stillAnchor outlive the process, so a launch while parked picks the
  // stop back up. enterMoving here would restart the foreground service and set
  // the stillness clock back to zero for a phone that has not moved.
  const { mode, stillAnchor } = useTrackingStore.getState()
  const anchor = mode === "stationary" ? stillAnchor : null
  const parkedAt = anchor && !(await hasLeft(anchor)) ? anchor : null
  if (parkedAt) await enterStationary(parkedAt.lat, parkedAt.lon)
  else await enterMoving()

  await startMotionWatch()
  await registerBackgroundSync()
  if (!parkedAt) void reportNow("foreground")
  // After the launch fix, so the heartbeat's first tick sees it in flight
  // rather than asking for a second.
  startForegroundHeartbeat()
  return true
}

export async function stopTracking(): Promise<void> {
  stopForegroundHeartbeat()
  driving = null
  if (await locationUpdatesRunning()) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {})
  }
  if (await geofenceRunning()) {
    await Location.stopGeofencingAsync(STATIONARY_GEOFENCE_TASK).catch(() => {})
  }
  await stopMotionWatch()
  stopDriveSensors()
  const store = useTrackingStore.getState()
  store.setMode("off")
  store.setStillAnchor(null)
  store.setBackgroundActive(false)
  // Sign-out, a server change and a deleted account all land here, and none of
  // them turn the master switch off, so the wake had nothing left to stop it.
  // startTracking registers it again, and that is the only way back from "off".
  await unregisterBackgroundSync()
}

let lastPolicyRestart = 0

/** Throttled, so policy churn from the server cannot thrash the OS updates. */
export async function applyPolicy(policy: TrackingPolicy): Promise<void> {
  if (Date.now() - lastPolicyRestart < 60_000) return
  if (useTrackingStore.getState().mode !== "moving") return
  if (!(await locationUpdatesRunning())) return
  lastPolicyRestart = Date.now()
  await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, updateOptions(policy))
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
