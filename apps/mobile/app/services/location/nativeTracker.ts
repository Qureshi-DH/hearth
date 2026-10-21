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
  stopServiceAsync(force: boolean): Promise<void>
  watchAsync(seconds: number): Promise<boolean>
  endWatchAsync(): Promise<void>
  setUploaderAsync(url: string, key: string): Promise<void>
  clearUploaderAsync(): Promise<void>
  answersNativelyAsync(): Promise<boolean>
  moveTaskToBackAsync(): Promise<boolean>
  startBriefAsync(): Promise<boolean>
  stopBriefAsync(): Promise<void>
  releaseAwakeAsync(): Promise<void>
  getServiceStatusAsync(): Promise<ServiceStatus>
  armFenceAsync(lat: number, lon: number, radius: number): Promise<boolean>
  disarmFenceAsync(): Promise<void>
  isFenceArmedAsync(): Promise<boolean>
  setTrackerStateAsync(state: NativeTrackerState): Promise<void>
  drainFixesAsync(): Promise<NativeFix[]>
  drainEventsAsync(): Promise<NativeEvent[]>
  clearQueueAsync(): Promise<void>
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

/** Forced for signing out or sharing off. Unforced, a watch the service holds outlives the tier. */
export function stopService(force = false): Promise<void> {
  return required().stopServiceAsync(force)
}

/** True when Android accepted the start. */
export async function watch(seconds: number): Promise<boolean> {
  try {
    return await required().watchAsync(seconds)
  } catch {
    return false
  }
}

export async function endWatch(): Promise<void> {
  try {
    await required().endWatchAsync()
  } catch {
    // Nothing running to end.
  }
}

export async function setUploader(url: string, key: string): Promise<void> {
  try {
    await required().setUploaderAsync(url, key)
  } catch {
    // An older build without the uploader. JavaScript answers, as before.
  }
}

export async function clearUploader(): Promise<void> {
  try {
    await required().clearUploaderAsync()
  } catch {
    // As above.
  }
}

export async function answersNatively(): Promise<boolean> {
  if (!native) return false
  try {
    return await native.answersNativelyAsync()
  } catch {
    return false
  }
}

export async function moveTaskToBack(): Promise<boolean> {
  if (!native) return false
  try {
    return await native.moveTaskToBackAsync()
  } catch {
    return false
  }
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

/** The headless task the tracking service holds open for this side is no longer wanted. */
export async function releaseAwake(): Promise<void> {
  try {
    await required().releaseAwakeAsync()
  } catch {
    // A build from before the hold, which never opened one.
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

/** The fixes the service took, oldest first. `sent` marks one the native uploader already sent. */
export function drainFixes(): Promise<(Location.LocationObject & { sent?: boolean })[]> {
  return required().drainFixesAsync() as Promise<(Location.LocationObject & { sent?: boolean })[]>
}

export function drainEvents(): Promise<NativeEvent[]> {
  return required().drainEventsAsync()
}

export function clearQueue(): Promise<void> {
  return required().clearQueueAsync()
}

/** Native saying the queue has something in it. Null where there is no native side. */
export function onNativeQueue(handler: () => void): { remove(): void } | null {
  if (!native) return null
  return native.addListener("onNativeQueue", handler)
}
