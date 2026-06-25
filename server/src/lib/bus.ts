import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"

import { getConfig } from "../env"

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
const PUBLISH_TIMEOUT_MS = 2000
const FRAME_VERSION = "h1"

/*
 * Redis is not a trusted party. The overlay ships it with no password on a
 * private compose network, so anything that reaches that network could publish
 * a forged position for a child, or simply subscribe and read every member's
 * precise coordinates as they are broadcast, because the rows on the bus are
 * unprojected by design.
 *
 * Sealing the envelope makes the shared server secret, not network placement,
 * the thing that decides who may speak on the bus and who may read it. Replicas
 * already have to agree on JWT_SECRET or they could not verify each other's
 * tokens, so this needs no new configuration.
 */

function busKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "hearth realtime bus", 32))
}

export function sealEnvelope(key: Buffer, envelope: BusEnvelope): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()])
  return [
    FRAME_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".")
}

/** Null for anything not sealed by a server holding the same secret. */
export function openEnvelope(key: Buffer, frame: string): BusEnvelope | null {
  const [version, iv, tag, body] = frame.split(".")
  if (version !== FRAME_VERSION || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8")
    const envelope = JSON.parse(plain) as BusEnvelope
    return typeof envelope?.topic === "string" ? envelope : null
  } catch {
    return null
  }
}

class RedisBus implements RealtimeBus {
  readonly kind = "redis" as const
  private readonly local = new EventEmitter()

  private constructor(
    private readonly pub: import("ioredis").Redis,
    private readonly sub: import("ioredis").Redis,
    private readonly key: Buffer,
  ) {
    this.local.setMaxListeners(0)
    this.sub.on("message", (_channel: string, raw: string) => {
      const envelope = openEnvelope(this.key, raw)
      // Dropped silently: a frame we cannot open is either from a mismatched
      // version or from something that is not a Hearth replica at all, and
      // neither is worth a log line per message.
      if (envelope) this.local.emit("message", envelope)
    })
  }

  static async connect(url: string): Promise<RedisBus> {
    const { Redis } = await import("ioredis")
    // Publishing is awaited on the request path, so the publisher has to fail
    // fast rather than queue commands for as long as Redis is unreachable. The
    // subscriber has no caller waiting on it and keeps retrying so that it
    // resubscribes after an outage.
    const pub = new Redis(url, {
      maxRetriesPerRequest: 1,
      commandTimeout: PUBLISH_TIMEOUT_MS,
      lazyConnect: false,
    })
    const sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    await sub.subscribe(REDIS_CHANNEL)
    return new RedisBus(pub, sub, busKey(getConfig().jwtSecret))
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    try {
      await this.pub.publish(REDIS_CHANNEL, sealEnvelope(this.key, { topic, payload }))
    } catch {
      // Fan-out is best effort. Losing a frame while Redis is down is far
      // better than failing the write that produced it.
    }
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
