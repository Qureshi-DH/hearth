import { Platform } from "react-native"
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
export const BACKGROUND_SYNC_TASK = "app.hearth.mobile.sync"
/** Armed around wherever the phone stopped, so leaving wakes us back up. */
export const STATIONARY_GEOFENCE_TASK = "hearth-stationary-geofence"

const MAX_BATCH = 200
const STALE_FIX_MS = 30 * 60 * 1000

/**
 * The OS classifier is more certain than a distance heuristic, so it can call
 * a stop sooner than STILL_AFTER_MS of watching the phone not move.
 */
const MOTION_STILL_CONFIRM_MS = 90_000
const MOTION_MIN_CONFIDENCE = 50

/**
 * Android will not hand out continuous location without a foreground service,
 * and a location foreground service must show a notification that cannot be
 * hidden. Running one around the clock is what makes the notification
 * permanent and what actually drains the battery, since the GPS never sleeps.
 *
 * So only run it while the phone is moving. Once it has sat still, stop the
 * service and hand the waiting over to the OS geofence, which is cheap because
 * it rides on the location the system is already computing for everything else.
 * The notification then appears for a journey and disappears when you arrive.
 */
const STILL_RADIUS_METERS = 60
const STILL_AFTER_MS = 5 * 60 * 1000
/** Bigger than the still radius so GPS jitter at a standstill cannot trip it. */
const STATIONARY_GEOFENCE_RADIUS_METERS = 150

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
function stationaryRadiusMeters(policy: TrackingPolicy): number {
  return Math.max(STATIONARY_GEOFENCE_RADIUS_METERS, stillRadiusMeters(policy) * 1.5)
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
  const fixes = thin(
    locations.map((location) => toFix(location, source, battery)),
    state.lastFix,
    state.policy,
  )
  if (fixes.length === 0) return
  state.enqueue(fixes)
  const newest = fixes[fixes.length - 1]
  if (newest && source === "background") await evaluateStillness(newest)
  await flush()
}

export async function reportNow(
  source: LocationSource = "manual",
): Promise<LocationFixInput | null> {
  try {
    const location = await Location.getCurrentPositionAsync({
      accuracy: source === "sos" ? Location.Accuracy.Highest : Location.Accuracy.High,
    })
    const battery = await batterySnapshot()
    const fix = toFix(location, source, battery)
    useTrackingStore.getState().enqueue([fix])
    await flush()
    return fix
  } catch (error) {
    useTrackingStore.getState().setError((error as Error).message)
    return null
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
  // classifier left crash detection off for the whole journey, while the
  // settings screen still said it was on.
  await startMotionWatch()
  await reportNow("significant")
})

/** Waking the location stack is the one thing "stationary" exists to avoid. */
const DRIFT_CHECK_MS = 60 * 60 * 1000
let lastDriftCheck = 0

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const { enabled, mode, policy, stillAnchor } = useTrackingStore.getState()

    // Android forgets geofences when the app process is killed, and expo's
    // geofencing does not restart a terminated app the way iOS does. Rather
    // than trust the fence to be the only thing that can wake us, this periodic
    // pass re-arms it and independently checks whether the phone has left. A
    // fence that quietly fails would otherwise mean going dark on a journey.
    if (enabled && mode === "stationary" && stillAnchor) {
      const rearmed = !(await geofenceRunning())
      if (rearmed) await enterStationary(stillAnchor.lat, stillAnchor.lon)
      if (rearmed || Date.now() - lastDriftCheck > DRIFT_CHECK_MS) {
        lastDriftCheck = Date.now()
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
    const { lastFix } = useTrackingStore.getState()
    const stale = !lastFix || Date.now() - Date.parse(lastFix.recordedAt) > STALE_FIX_MS
    if (enabled && stale && (await currentPermission()) === "always") {
      await reportNow("significant")
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
    foregroundService: {
      notificationTitle: "Hearth is sharing your location",
      notificationBody: "Tap to open. Pause sharing any time from the app.",
      notificationColor: "#FF7A45",
      killServiceOnDestroy: false,
    },
  }
}

let motionSubscription: { remove: () => void } | null = null
let motionStarting = false
let motionStillSince: number | null = null

/**
 * Play Services and Core Motion already classify movement for the system, so
 * asking them costs far less than waking the GPS to work it out from position.
 *
 * The OS classifier is the only thing that tells us a journey has started, so
 * crash detection depends on it as much as the battery work does. Gating it on
 * the battery toggle alone meant turning on incident alerts for a circle did
 * nothing at all until an unrelated switch was also found.
 */
function motionWanted(): boolean {
  const settings = useSettingsStore.getState()
  return settings.nativeMotion || settings.incidentDetection
}

async function startMotionWatch(): Promise<void> {
  // The resume path and the device toggle can call this at once, and each await
  // below is a chance for the second to walk past a null subscription and add a
  // native listener whose handle we then lose.
  if (motionSubscription || motionStarting) return
  if (!motionWanted()) return
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
 * Called when the device toggle changes. Whether the phone works out that it
 * has stopped from the OS classifier or from GPS is invisible to the server,
 * the same fixes arrive either way, so this is purely a battery choice and it
 * takes effect without restarting tracking.
 */
export async function refreshMotionWatch(): Promise<void> {
  if (motionWanted()) await startMotionWatch()
  else await stopMotionWatch()
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
  if (!(await locationUpdatesRunning())) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, updateOptions(store.policy))
  }
  store.setStillAnchor(null)
  store.setMode("moving")
  store.setBackgroundActive(true)
}

/** Updates off, geofence armed. This is where the notification goes away. */
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
  if (await locationUpdatesRunning()) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {})
  }
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
  return true
}

export async function stopTracking(): Promise<void> {
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

export async function resumeIfEnabled(): Promise<void> {
  const { enabled } = useTrackingStore.getState()
  const permission = await currentPermission()
  useTrackingStore.getState().setPermission(permission)
  if (enabled && permission === "always") {
    await startTracking()
  }
  void flush()
}
