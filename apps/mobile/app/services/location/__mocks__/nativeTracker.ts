import type * as Location from "expo-location"

import type {
  NativeEvent,
  NativeTrackerState,
  ServiceRequest,
  ServiceStatus,
} from "../nativeTracker"

/**
 * The native transport as a test double: what Android would hold on the
 * phone's behalf while JavaScript is down, and what JavaScript asked of it.
 * Tests seed the queues the way a receiver would have, then poke the
 * tracker the way the module does.
 */
export const fake = {
  status: "none" as ServiceStatus,
  /** Whether Android would refuse the next start, as it does outside its allowed moments. */
  refuse: false,
  /** Whether Play Services would refuse the fence, as it does short of the Always permission. */
  refuseFence: false,
  fence: null as { lat: number; lon: number; radius: number } | null,
  state: null as NativeTrackerState | null,
  fixes: [] as (Location.LocationObject & { sent?: boolean })[],
  /** The upload address and key JavaScript handed over, which is what lets native answer a wake. */
  uploader: null as { url: string; key: string } | null,
  /** The seconds of the last watch asked for, while the service holds it. */
  watching: null as number | null,
  events: [] as NativeEvent[],
  handlers: [] as Array<() => void>,
  startService: jest.fn(),
  stopService: jest.fn(),
  startBrief: jest.fn(),
  stopBrief: jest.fn(),
  releaseAwake: jest.fn(),
  watch: jest.fn(),
  endWatch: jest.fn(),
  moveTaskToBack: jest.fn(),
  armFence: jest.fn(),
  disarmFence: jest.fn(),
  reset() {
    fake.status = "none"
    fake.refuse = false
    fake.refuseFence = false
    fake.fence = null
    fake.state = null
    fake.fixes = []
    fake.events = []
    fake.uploader = null
    fake.watching = null
    // Listeners stay: the tracker adds its one when it loads, for good.
    fake.startService.mockClear()
    fake.stopService.mockClear()
    fake.startBrief.mockClear()
    fake.stopBrief.mockClear()
    fake.releaseAwake.mockClear()
    fake.watch.mockClear()
    fake.endWatch.mockClear()
    fake.moveTaskToBack.mockClear()
    fake.armFence.mockClear()
    fake.disarmFence.mockClear()
  },
  /** The native side saying the queue has something in it. */
  poke() {
    for (const handler of fake.handlers) handler()
  },
}

export const nativeTrackerAvailable = true

export async function startService(request: ServiceRequest): Promise<ServiceStatus> {
  fake.startService(request)
  if (fake.refuse) {
    fake.status = "refused"
    return "refused"
  }
  fake.status = "running"
  return "running"
}

export async function stopService(force = false): Promise<void> {
  fake.stopService(force)
  // A watch the service holds outlives the tier, as on the phone.
  if (fake.watching != null && !force) return
  fake.watching = null
  fake.status = "none"
}

export async function watch(seconds: number): Promise<boolean> {
  fake.watch(seconds)
  if (fake.refuse) return false
  fake.watching = seconds
  fake.status = "running"
  return true
}

export async function endWatch(): Promise<void> {
  fake.endWatch()
  fake.watching = null
}

export async function setUploader(url: string, key: string): Promise<void> {
  fake.uploader = { url, key }
}

export async function clearUploader(): Promise<void> {
  fake.uploader = null
}

export async function answersNatively(): Promise<boolean> {
  return fake.uploader != null && fake.state?.enabled === true && fake.state.mode !== "off"
}

export async function moveTaskToBack(): Promise<boolean> {
  fake.moveTaskToBack()
  return true
}

export async function startBrief(): Promise<boolean> {
  fake.startBrief()
  if (fake.status === "none" || fake.status === "refused") fake.status = "brief"
  return true
}

export async function releaseAwake(): Promise<void> {
  fake.releaseAwake()
}

export async function stopBrief(): Promise<void> {
  fake.stopBrief()
  if (fake.status === "brief") fake.status = "none"
}

export async function serviceStatus(): Promise<ServiceStatus> {
  return fake.status
}

export async function armFence(lat: number, lon: number, radius: number): Promise<boolean> {
  fake.armFence(lat, lon, radius)
  if (fake.refuseFence) return false
  fake.fence = { lat, lon, radius }
  return true
}

export async function disarmFence(): Promise<void> {
  fake.disarmFence()
  fake.fence = null
}

export async function fenceArmed(): Promise<boolean> {
  return fake.fence != null
}

export async function setTrackerState(state: NativeTrackerState): Promise<void> {
  fake.state = state
}

export async function drainFixes(): Promise<(Location.LocationObject & { sent?: boolean })[]> {
  const drained = fake.fixes
  fake.fixes = []
  return drained
}

export async function drainEvents(): Promise<NativeEvent[]> {
  const drained = fake.events
  fake.events = []
  return drained
}

export async function clearQueue(): Promise<void> {
  fake.fixes = []
  fake.events = []
}

export function onNativeQueue(handler: () => void): { remove(): void } {
  fake.handlers.push(handler)
  return {
    remove() {
      fake.handlers = fake.handlers.filter((registered) => registered !== handler)
    },
  }
}
