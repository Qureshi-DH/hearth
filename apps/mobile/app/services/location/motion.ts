import type {
  BackgroundRefreshStatus,
  MotionActivity,
  MotionChangeEvent,
  MotionPermission,
  MotionRecord,
  MotionSource,
  SensorBatchEvent,
  SensorSample,
} from "../../../modules/hearth-motion"

type MotionModule = typeof import("../../../modules/hearth-motion").default
/** What a listener hands back, typed from the module: the app does not depend on expo-modules-core. */
export type Subscription = ReturnType<MotionModule["addListener"]>

/**
 * The native module only exists in a build that included it, so an older
 * install must degrade to the GPS only path rather than crash on import.
 */
let native: MotionModule | null = null
try {
  native = (require("../../../modules/hearth-motion") as { default: MotionModule }).default
} catch {
  native = null
}

export const motionModuleAvailable = native !== null

/**
 * The checklist's Background App Refresh row. It lives in the motion module
 * because that is the app's one native module, and "unknown" is the honest
 * answer from a build without it or from Android, where the switch does not
 * exist.
 */
export async function backgroundRefreshStatus(): Promise<BackgroundRefreshStatus> {
  if (!native) return "unknown"
  try {
    return await native.getBackgroundRefreshStatusAsync()
  } catch {
    return "unknown"
  }
}

export async function motionUsable(): Promise<boolean> {
  if (!native) return false
  try {
    return await native.isAvailableAsync()
  } catch {
    return false
  }
}

/**
 * The tracker's gate as well as the checklist's. "unavailable" covers a
 * simulator, an old device, or a build without the module, and every one of
 * those runs GPS-only with no row to show for it.
 */
export async function motionPermission(): Promise<MotionPermission | "unavailable"> {
  if (!native) return "unavailable"
  if (!(await motionUsable())) return "unavailable"
  try {
    return await native.getPermissionAsync()
  } catch {
    return "unavailable"
  }
}

/**
 * The only thing that raises the OS dialog, and it belongs to the checklist's
 * Allow button, where the reason is on screen first. Nothing the tracker runs
 * may call it: a geofence exit can wake a process with no Activity, Android
 * answers a request made from there as denied without showing anything, and
 * the module then reports denied for good.
 */
export async function ensureMotionPermission(): Promise<boolean> {
  if (!native) return false
  try {
    const current = await native.getPermissionAsync()
    if (current === "granted") return true
    if (current === "denied") return false
    return (await native.requestPermissionAsync()) === "granted"
  } catch {
    return false
  }
}

/**
 * Check only, never a prompt. A start that finds the permission still
 * undetermined stays GPS-only and is tried again once the checklist has asked.
 */
export async function startMotion(
  onChange: (activity: MotionActivity, confidence: number, source: MotionSource) => void,
): Promise<Subscription | null> {
  if (!native) return null
  if ((await motionPermission()) !== "granted") return null
  const subscription = native.addListener("onMotionChange", (event: MotionChangeEvent) =>
    onChange(event.activity, event.confidence, event.source ?? "sample"),
  )
  try {
    await native.startUpdatesAsync()
  } catch {
    subscription.remove()
    return null
  }
  return subscription
}

export async function stopMotion(subscription: Subscription | null): Promise<void> {
  subscription?.remove()
  if (!native) return
  try {
    await native.stopUpdatesAsync()
  } catch {
    // Nothing to stop is the state we wanted.
  }
}

/**
 * iOS only: what Core Motion recorded between two moments, which it keeps
 * for a week whether or not the app was running. Null on Android, without
 * the permission, or where the history cannot be read.
 */
export async function queryMotion(fromMs: number, toMs: number): Promise<MotionRecord[] | null> {
  if (!native) return null
  try {
    return await native.queryActivityAsync(fromMs, toMs)
  } catch {
    return null
  }
}

/** Core Motion's "medium" and above, as the module maps it. A "low" verdict is a guess. */
const MOTION_SURE = 60

const sure = (record: MotionRecord) =>
  record.confidence >= MOTION_SURE && record.activity !== "unknown"

/** Going somewhere: on foot, on a bike, or in a vehicle that is not standing. */
const moving = (record: MotionRecord) =>
  record.activity === "walking" ||
  record.activity === "running" ||
  record.activity === "cycling" ||
  (record.activity === "automotive" && !record.stationary)

/**
 * Whether Core Motion's history has the phone lying still from `fromMs` on.
 * The sure record in force at `fromMs` has to be a still one, and nothing
 * sure after it may be going anywhere. A phone in a hand on a bed logs
 * doubtful and unknown records as it is turned over, and those are not a
 * departure. Nothing sure on record is no answer.
 */
export function stillThroughout(records: MotionRecord[], fromMs: number): boolean {
  const confident = records.filter(sure).sort((a, b) => a.t - b.t)
  const inForce = confident.filter((record) => record.t <= fromMs).pop()
  if (!inForce || moving(inForce)) return false
  return !confident.some((record) => record.t > fromMs && moving(record))
}

/** A vehicle under way now: the newest sure record is automotive and not standing. */
export function inMovingVehicle(records: MotionRecord[]): boolean {
  const newest = records
    .filter(sure)
    .sort((a, b) => a.t - b.t)
    .pop()
  return newest != null && newest.activity === "automotive" && !newest.stationary
}

/**
 * Raw sensor samples that keep arriving once the Activity pauses, which is
 * where expo-sensors gives up on Android. Null means the caller has to sample
 * for itself: an older install without the module, or a device with nothing to
 * sample. The listener goes on before the sensors do, so the first batch has
 * somewhere to land.
 */
export async function startSensorBatches(
  onBatch: (samples: SensorSample[]) => void,
): Promise<Subscription | null> {
  if (!native) return null
  const subscription = native.addListener("onSensorBatch", (event: SensorBatchEvent) =>
    onBatch(event.samples),
  )
  try {
    if (await native.startSensorsAsync()) return subscription
  } catch {
    // An install carrying an older copy of the module has no such function, and
    // that is the same to the caller as having no module at all.
  }
  subscription.remove()
  return null
}

export async function stopSensorBatches(subscription: Subscription | null): Promise<void> {
  subscription?.remove()
  if (!native) return
  try {
    await native.stopSensorsAsync()
  } catch {
    // Nothing to stop is the state we wanted.
  }
}

export type { MotionActivity, MotionRecord, MotionSource, SensorSample }
