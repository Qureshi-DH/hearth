import type { WsServerMessage } from "@hearth/shared"

import { api } from "@/services/api"

import { logTracker } from "./log"

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
/**
 * Far apart, since a phone on cellular pays for every radio wake. The server
 * pings on its own every half minute and the OS answers those for us; this
 * is the app-level frame that keeps a proxy from timing the socket out.
 */
const PING_INTERVAL_MS = 2 * 60 * 1000

export interface ControlHandler {
  watch(seconds: number): Promise<void>
  wake(): Promise<void>
}

let handler: ControlHandler | null = null

/** The tracker registers itself here; the channel does not import it, to keep the two apart. */
export function setControlHandler(next: ControlHandler): void {
  handler = next
}

/**
 * The phone's own line to the server, open whenever the tracker's process
 * is alive with a location session: on Android while the phone is on the
 * move (the service is up anyway), on iOS in every tier (the parked session
 * keeps the app alive). An ask from the family (a page opened, Live, the
 * sweep's wake) comes down it and is answered within a second. The UI's own
 * socket is a different thing: it lives with the screen and closes when the
 * app goes to the background, which is exactly when this one matters.
 */
class ControlChannel {
  private socket: WebSocket | null = null
  private wanted = false
  private backoff = MIN_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Refused by the server: no retry until a new token arrives through refresh(). */
  private refused = false

  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) return
    this.wanted = wanted
    if (wanted) this.open()
    else this.close()
  }

  /** A rotated token leaves the open socket holding a dead credential. */
  refresh(): void {
    this.refused = false
    if (!this.wanted) return
    this.socket?.close()
    this.socket = null
    this.clearTimers()
    this.reconnectTimer = setTimeout(() => this.open(), MIN_BACKOFF_MS)
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private open(): void {
    if (!this.wanted || this.refused) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    const url = api.websocketUrl()
    if (!url) return

    const socket = new WebSocket(url)
    this.socket = socket

    socket.onopen = () => {
      this.backoff = MIN_BACKOFF_MS
      socket.send(JSON.stringify({ type: "control" }))
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }))
      }, PING_INTERVAL_MS)
      logTracker("control", { open: true })
    }

    socket.onmessage = (event) => {
      let message: WsServerMessage
      try {
        message = JSON.parse(String(event.data)) as WsServerMessage
      } catch {
        return
      }
      if (message.type !== "control" || !handler) return
      if (message.command === "watch") {
        logTracker("control", { command: "watch", seconds: message.seconds })
        void handler.watch(message.seconds ?? 0).catch(() => undefined)
      } else if (message.command === "wake") {
        logTracker("control", { command: "wake" })
        void handler.wake().catch(() => undefined)
      }
    }

    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      if (!this.wanted) return
      // 4401 is the server refusing the token; the next refresh brings a new one.
      if (event.code === 4401) {
        this.refused = true
        logTracker("control", { open: false, refused: true })
        return
      }
      this.reconnectTimer = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
    }

    socket.onerror = () => {
      // onclose follows.
    }
  }

  private close(): void {
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.backoff = MIN_BACKOFF_MS
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
  }
}

export const control = new ControlChannel()
