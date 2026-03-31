import type { RealtimeBus } from "./lib/bus"
import type { PushDriver } from "./services/push"

/**
 * Services reach for these singletons instead of threading the Fastify
 * instance through every call site. Tests call `setRuntime` with fakes and
 * `resetRuntime` afterwards.
 */
interface Runtime {
  bus: RealtimeBus | null
  pushDriver: PushDriver | null
  startedAt: number
}

const runtime: Runtime = { bus: null, pushDriver: null, startedAt: Date.now() }

export function setRuntime(next: Partial<Runtime>): void {
  Object.assign(runtime, next)
}

export function resetRuntime(): void {
  runtime.bus = null
  runtime.pushDriver = null
}

export function getBus(): RealtimeBus | null {
  return runtime.bus
}

export function getPushDriver(): PushDriver | null {
  return runtime.pushDriver
}

export function uptimeSeconds(): number {
  return Math.round((Date.now() - runtime.startedAt) / 1000)
}
