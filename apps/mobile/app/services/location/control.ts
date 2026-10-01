import type { WsServerMessage } from "@hearth/shared"

import { api } from "@/services/api"

import { logTracker } from "./log"

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

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
 * The phone's own line to the server. An iPhone holds it for as long as
 * sharing is on, because its parked session keeps the process alive. An
 * Android phone holds it only while moving (syncControl in the tracker), and
 * a parked one is reached by silent push instead. An ask from the family (a
 * page opened, Live, the sweep's wake) comes down it and is answered within
 * a second. The UI's own socket is a different thing: it lives with the
 * screen and closes when the app goes to the background, which is exactly
 * when this one matters.
 */
class ControlChannel {
  private socket: WebSocket | null = null
  private wanted = false
  private backoff = MIN_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Refused by the server: no retry until a new token arrives through refresh(). */
  private refused = false

  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) {
      // Wanted again with nothing open and nothing scheduled: the last try
      // found no token, and the keychain may have handed one over since.
      if (wanted && !this.socket && !this.reconnectTimer) this.open()
      return
    }
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
      // Nothing more is sent from here. The server pings a declared socket
      // every couple of minutes and the socket layer answers without the
      // app; every frame of the phone's own would be a radio wake.
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
      // 4401 is the server refusing the token. A parked phone may make no
      // REST call for a quarter hour, so the channel rotates it itself.
      if (event.code === 4401) {
        this.refused = true
        logTracker("control", { open: false, refused: true })
        void this.renew()
        return
      }
      this.reconnectTimer = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
    }

    socket.onerror = () => {
      // onclose follows.
    }
  }

  /**
   * The rotation lands in the API client's token hook, which calls refresh()
   * here as it does for every rotation; the call after is for a hook that
   * has nothing to say. A rotation that fails for want of a network is tried
   * again on the longest backoff; one the server refuses ends the session,
   * and the tracker is stopped by the same hook.
   */
  private async renew(): Promise<void> {
    if (!this.wanted) return
    const next = await api.refreshTokens({ refused: true }).catch(() => null)
    if (!this.wanted) return
    if (next) {
      this.refresh()
      return
    }
    this.clearTimers()
    this.reconnectTimer = setTimeout(() => void this.renew(), MAX_BACKOFF_MS)
  }

  private close(): void {
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.backoff = MIN_BACKOFF_MS
    // A channel wanted again later starts afresh; a refusal from before
    // sharing was switched off says nothing about the token it has now.
    this.refused = false
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}

export const control = new ControlChannel()
