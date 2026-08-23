import { Platform } from "react-native"
import type * as Location from "expo-location"

import type {
  NativeEvent,
  NativeFix,
  ServiceRequest,
  ServiceStatus,
  TrackerState,
} from "../../../modules/hearth-motion"

export type { NativeEvent, ServiceRequest, ServiceStatus }
export type NativeTrackerState = TrackerState

/**
 * The Android transport, in modules/hearth-motion. Everything that has to
 * survive this process being killed lives there: the receivers the OS wakes
 * on a geofence exit or an activity transition, the foreground service they
 * start inside the moment Android allows it, the location request that
 * service owns, and a queue of the fixes and events it saw while this side
 * was down. This side is the policy: it drains the queue, decides the tier,
 * and tells native what to run.
 */

type NativeModule = {
  startServiceAsync(request: ServiceRequest): Promise<ServiceStatus>
  stopServiceAsync(): Promise<void>
  startBriefAsync(): Promise<boolean>
  stopBriefAsync(): Promise<void>
  getServiceStatusAsync(): Promise<ServiceStatus>
  armFenceAsync(lat: number, lon: number, radius: number): Promise<boolean>
  disarmFenceAsync(): Promise<void>
  isFenceArmedAsync(): Promise<boolean>
  setTrackerStateAsync(state: NativeTrackerState): Promise<void>
  drainFixesAsync(): Promise<NativeFix[]>
  drainEventsAsync(): Promise<NativeEvent[]>
  addListener(event: "onNativeQueue", listener: () => void): { remove(): void }
}

let native: NativeModule | null = null
if (Platform.OS === "android") {
  try {
    native = (require("../../../modules/hearth-motion") as { default: NativeModule }).default
  } catch {
    native = null
  }
}

/** Android with the module compiled in. Every build has it; a test does not unless it says so. */
export const nativeTrackerAvailable = native !== null

function required(): NativeModule {
  if (!native) throw new Error("The native tracker is not in this build")
  return native
}

export function startService(request: ServiceRequest): Promise<ServiceStatus> {
  return required().startServiceAsync(request)
}

export function stopService(): Promise<void> {
  return required().stopServiceAsync()
}

/**
 * The brief service: foreground for one fix and its "Updating your
 * location", then gone, the way a messaging app checks for messages. A push
 * starts it natively inside the message handler; a wake that came another
 * way starts it here.
 */
export async function startBrief(): Promise<boolean> {
  try {
    return await required().startBriefAsync()
  } catch {
    return false
  }
}

export async function stopBrief(): Promise<void> {
  try {
    await required().stopBriefAsync()
  } catch {
    // Already gone, or never started.
  }
}

export function serviceStatus(): Promise<ServiceStatus> {
  return required().getServiceStatusAsync()
}

export function armFence(lat: number, lon: number, radius: number): Promise<boolean> {
  return required().armFenceAsync(lat, lon, radius)
}

export function disarmFence(): Promise<void> {
  return required().disarmFenceAsync()
}

export function fenceArmed(): Promise<boolean> {
  return required().isFenceArmedAsync()
}

export function setTrackerState(state: NativeTrackerState): Promise<void> {
  return required().setTrackerStateAsync(state)
}

export function drainFixes(): Promise<Location.LocationObject[]> {
  return required().drainFixesAsync() as Promise<Location.LocationObject[]>
}

export function drainEvents(): Promise<NativeEvent[]> {
  return required().drainEventsAsync()
}

/** Native saying the queue has something in it. Null where there is no native side. */
export function onNativeQueue(handler: () => void): { remove(): void } | null {
  if (!native) return null
  return native.addListener("onNativeQueue", handler)
}
