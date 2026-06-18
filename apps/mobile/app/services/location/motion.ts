import type { EventSubscription } from "expo-modules-core"

import type {
  MotionActivity,
  MotionChangeEvent,
  MotionPermission,
  SensorBatchEvent,
  SensorSample,
} from "../../../modules/hearth-motion"

type MotionModule = typeof import("../../../modules/hearth-motion").default

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

export async function motionUsable(): Promise<boolean> {
  if (!native) return false
  try {
    return await native.isAvailableAsync()
  } catch {
    return false
  }
}

/** "unavailable" covers a simulator, an old device, or a build without the module. */
export async function motionPermission(): Promise<MotionPermission | "unavailable"> {
  if (!native) return "unavailable"
  if (!(await motionUsable())) return "unavailable"
  try {
    return await native.getPermissionAsync()
  } catch {
    return "unavailable"
  }
}

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

export async function startMotion(
  onChange: (activity: MotionActivity, confidence: number) => void,
): Promise<EventSubscription | null> {
  if (!native) return null
  if (!(await motionUsable())) return null
  if (!(await ensureMotionPermission())) return null
  const subscription = native.addListener("onMotionChange", (event: MotionChangeEvent) =>
    onChange(event.activity, event.confidence),
  )
  try {
    await native.startUpdatesAsync()
  } catch {
    subscription.remove()
    return null
  }
  return subscription
}

export async function stopMotion(subscription: EventSubscription | null): Promise<void> {
  subscription?.remove()
  if (!native) return
  try {
    await native.stopUpdatesAsync()
  } catch {
    // Nothing to stop is the state we wanted.
  }
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
): Promise<EventSubscription | null> {
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

export async function stopSensorBatches(subscription: EventSubscription | null): Promise<void> {
  subscription?.remove()
  if (!native) return
  try {
    await native.stopSensorsAsync()
  } catch {
    // Nothing to stop is the state we wanted.
  }
}

export type { MotionActivity, SensorSample }
