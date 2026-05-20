import type { EventSubscription } from "expo-modules-core"

import type {
  MotionActivity,
  MotionChangeEvent,
  MotionPermission,
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

export type { MotionActivity }
