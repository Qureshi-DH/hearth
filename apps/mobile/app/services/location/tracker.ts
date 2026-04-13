import { Platform } from "react-native"
import * as BackgroundTask from "expo-background-task"
import * as Battery from "expo-battery"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import type { LocationFixInput, LocationSource } from "@hearth/shared"

import { ApiError, endpoints } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore, type PermissionLevel, type TrackingPolicy } from "@/stores/tracking"

export const BACKGROUND_LOCATION_TASK = "hearth-background-location"
/** Must match BGTaskSchedulerPermittedIdentifiers in app.json. */
export const BACKGROUND_SYNC_TASK = "app.hearth.mobile.sync"

const MAX_BATCH = 200
const STALE_FIX_MS = 30 * 60 * 1000

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
    accuracyMeters: c.accuracy ?? null,
    altitudeMeters: c.altitude ?? null,
    altitudeAccuracyMeters: c.altitudeAccuracy ?? null,
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
      const moved = Math.hypot(fix.lat - last.lat, fix.lon - last.lon) * 111_000
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
          useTrackingStore.getState().setError("Signed out; sharing paused.")
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

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const { lastFix, enabled } = useTrackingStore.getState()
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
    deferredUpdatesInterval: Math.max(60_000, policy.minUpdateIntervalSeconds * 2000),
    deferredUpdatesDistance: policy.distanceFilterMeters * 2,
    pausesUpdatesAutomatically: false,
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

/** Foreground permission is enough to start, but only "always" keeps it running. */
export async function startTracking(): Promise<boolean> {
  const permission = await currentPermission()
  useTrackingStore.getState().setPermission(permission)
  if (permission !== "always" && permission !== "foreground") return false

  const policy = useTrackingStore.getState().policy
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false,
  )
  if (!running) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, updateOptions(policy))
  }
  useTrackingStore.getState().setBackgroundActive(true)
  await registerBackgroundSync()
  void reportNow("foreground")
  return true
}

export async function stopTracking(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false,
  )
  if (running) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
  useTrackingStore.getState().setBackgroundActive(false)
}

let lastPolicyRestart = 0

/** Throttled, so policy churn from the server cannot thrash the OS updates. */
export async function applyPolicy(policy: TrackingPolicy): Promise<void> {
  if (Date.now() - lastPolicyRestart < 60_000) return
  const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
    () => false,
  )
  if (!running) return
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
