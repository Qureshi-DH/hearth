import { EventEmitter } from "node:events"

/**
 * Realtime fan-out between the HTTP handlers that mutate state and the
 * websocket connections that need to hear about it.
 *
 * Single-node deployments use the in-process emitter and need no extra
 * service. Setting REDIS_URL swaps in a Redis-backed bus so several API
 * replicas stay in sync.
 */
export interface BusEnvelope {
  /** Logical topic, e.g. `circle:<uuid>` or `user:<uuid>`. */
  topic: string
  payload: unknown
}

export interface RealtimeBus {
  readonly kind: "memory" | "redis"
  publish(topic: string, payload: unknown): Promise<void>
  onMessage(handler: (envelope: BusEnvelope) => void): () => void
  close(): Promise<void>
}

class MemoryBus implements RealtimeBus {
  readonly kind = "memory" as const
  private readonly emitter = new EventEmitter()

  constructor() {
    // A busy circle can legitimately have many websocket listeners.
    this.emitter.setMaxListeners(0)
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    this.emitter.emit("message", { topic, payload } satisfies BusEnvelope)
  }

  onMessage(handler: (envelope: BusEnvelope) => void): () => void {
    this.emitter.on("message", handler)
    return () => this.emitter.off("message", handler)
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners()
  }
}

const REDIS_CHANNEL = "hearth:realtime"

class RedisBus implements RealtimeBus {
  readonly kind = "redis" as const
  private readonly local = new EventEmitter()

  private constructor(
    private readonly pub: import("ioredis").Redis,
    private readonly sub: import("ioredis").Redis,
  ) {
    this.local.setMaxListeners(0)
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        this.local.emit("message", JSON.parse(raw) as BusEnvelope)
      } catch {
        // A malformed frame from another (mismatched) version is not fatal.
      }
    })
  }

  static async connect(url: string): Promise<RedisBus> {
    const { Redis } = await import("ioredis")
    const pub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    const sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    await sub.subscribe(REDIS_CHANNEL)
    return new RedisBus(pub, sub)
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    await this.pub.publish(REDIS_CHANNEL, JSON.stringify({ topic, payload }))
  }

  onMessage(handler: (envelope: BusEnvelope) => void): () => void {
    this.local.on("message", handler)
    return () => this.local.off("message", handler)
  }

  async close(): Promise<void> {
    this.local.removeAllListeners()
    await Promise.allSettled([this.sub.quit(), this.pub.quit()])
  }
}

export async function createBus(redisUrl?: string): Promise<RealtimeBus> {
  if (!redisUrl) return new MemoryBus()
  return RedisBus.connect(redisUrl)
}

export const circleTopic = (circleId: string) => `circle:${circleId}`
export const userTopic = (userId: string) => `user:${userId}`
