import { Platform } from "react-native"
import type * as Location from "expo-location"

import type {
  NativeEvent,
  NativeFix,
  ServiceStatus,
  TrackerState,
} from "../../../modules/hearth-motion"

export type { NativeEvent, ServiceStatus }
export type NativeTrackerState = TrackerState

/**
 * The Android transport, in modules/hearth-motion. The push handler there
 * answers the server's pings and Live asks with a foreground service it
 * starts inside the moment Android allows it, and sends the fixes itself
 * with the session's upload key. The classifier's receiver there writes down
 * whether the phone is moving, and starts a drive for crash detection. This
 * side tells it whether sharing and crash alerts are on and which key to
 * send with, and reads back what it did from its queue.
 */

type NativeModule = {
  stopServiceAsync(): Promise<void>
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

/** Sharing off or signed out. A ping or Live the service is answering ends. */
export async function stopService(): Promise<void> {
  try {
    await required().stopServiceAsync()
  } catch {
    // Nothing running to stop.
  }
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
 * location", then gone. A push starts it natively inside the message
 * handler for a session with no upload key; an ask that came another way
 * starts it here.
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

/** The headless task a drive holds open for this side is no longer wanted. */
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
