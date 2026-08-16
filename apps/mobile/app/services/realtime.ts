import { useEffect, useRef } from "react"
import { AppState, type AppStateStatus } from "react-native"
import type { FeedEvent, MemberPresence, Paginated, WsServerMessage } from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { api } from "@/services/api"
import { reportNow } from "@/services/location/tracker"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { useNudgeStore } from "@/stores/nudge"

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const PING_INTERVAL_MS = 25_000

type Listener = (message: WsServerMessage) => void

/**
 * One websocket for the whole app, alive only in the foreground. Holding a
 * socket open from a suspended phone is unreliable and drains the battery, so
 * background wake-ups come from push instead.
 *
 * Incoming frames are written straight into the React Query cache. Screens
 * render query data and never subscribe to the socket. A quick message is the
 * exception: nothing keeps it, so it goes to the store the banner reads.
 */
class RealtimeClient {
  private socket: WebSocket | null = null
  private backoff = MIN_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private wanted = false
  private listeners = new Set<Listener>()
  /**
   * Whether a socket has been open before. The one that follows it has a
   * gap behind it, in the background or through a dropped connection, and
   * what the server said during the gap is gone.
   */
  private hadSocket = false

  connect() {
    this.wanted = true
    this.open()
  }

  disconnect() {
    this.wanted = false
    this.clearTimers()
    this.socket?.close()
    this.socket = null
  }

  /** Closing is enough. The onclose handler reconnects with the current token. */
  refresh() {
    if (!this.wanted) return
    this.socket?.close()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private open() {
    if (!this.wanted) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return

    const url = api.websocketUrl()
    if (!url) return

    const socket = new WebSocket(url)
    this.socket = socket

    socket.onopen = () => {
      this.backoff = MIN_BACKOFF_MS
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }))
      }, PING_INTERVAL_MS)
      if (this.hadSocket) refetchMissed()
      this.hadSocket = true
    }

    socket.onmessage = (event) => {
      let message: WsServerMessage
      try {
        message = JSON.parse(String(event.data)) as WsServerMessage
      } catch {
        return
      }
      this.handle(message)
      for (const listener of this.listeners) listener(message)
    }

    socket.onclose = (event) => {
      // A socket that was already replaced closes late, after its successor is
      // open. Letting it run on would clear the live socket's ping timer and
      // schedule a second connection on top of it.
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      // 4401 means the server considers the token dead. A refresh happens on the
      // next REST call and `refresh()` reconnects us, so do not hammer it here.
      if (!this.wanted || event.code === 4401) return
      this.reconnectTimer = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2)
    }

    socket.onerror = () => {
      // onclose follows, so the reconnect is already handled there.
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
  }

  private handle(message: WsServerMessage) {
    switch (message.type) {
      case "presence":
        queryClient.setQueryData<MemberPresence[]>(
          queryKeys.presence(message.circleId),
          message.presences,
        )
        break

      case "location":
        queryClient.setQueryData<MemberPresence[]>(
          queryKeys.presence(message.circleId),
          (current) => {
            if (!current) return [message.presence]
            const index = current.findIndex((entry) => entry.userId === message.presence.userId)
            if (index === -1) return [...current, message.presence]
            const next = current.slice()
            next[index] = message.presence
            return next
          },
        )
        break

      case "event":
        queryClient.setQueryData<{ pages: Paginated<FeedEvent>[]; pageParams: unknown[] }>(
          queryKeys.events(message.circleId),
          (current) => {
            if (!current || current.pages.length === 0) return current
            const [first, ...rest] = current.pages
            if (!first || first.items.some((item) => item.id === message.event.id)) return current
            const items = placeByTime(first.items, message.event, first.nextCursor != null)
            if (items === first.items) return current
            return { ...current, pages: [{ ...first, items }, ...rest] }
          },
        )
        void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
        if (message.event.type.startsWith("place_")) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.places(message.circleId) })
        }
        if (message.event.type.startsWith("member_") || message.event.type === "role_changed") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.members(message.circleId) })
          // A new member is a new dot, and one who left is a dot to take
          // away; the presence list is what the map draws from.
          void queryClient.invalidateQueries({ queryKey: queryKeys.presence(message.circleId) })
        }
        break

      case "sos":
        void queryClient.invalidateQueries({ queryKey: queryKeys.sos(message.circleId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.presence(message.circleId) })
        break

      case "nudge":
        // Two things at once: report a fresh position, and put the sender's
        // words on screen. Delivered on this user's own topic, so it is
        // already addressed and needs no filtering.
        useNudgeStore.getState().receive(message.nudge)
        void reportNow("nudge")
        break

      default:
        break
    }
  }
}

export const realtime = new RealtimeClient()

/**
 * Everything the socket keeps current, asked for again after a gap in it.
 * Only a feed's first page can hold anything new, and refetching an
 * infinite query refetches every page it has, so a feed scrolled deep is
 * cut back to its first page first.
 */
function refetchMissed() {
  queryClient.setQueriesData<{ pages: Paginated<FeedEvent>[]; pageParams: unknown[] }>(
    { queryKey: ["events"] },
    (current) =>
      current && current.pages.length > 1
        ? { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) }
        : current,
  )
  void queryClient.invalidateQueries({ queryKey: ["events"] })
  void queryClient.invalidateQueries({ queryKey: ["presence"] })
  void queryClient.invalidateQueries({ queryKey: ["trips"] })
  void queryClient.invalidateQueries({ queryKey: queryKeys.myTrips })
}

/**
 * The feed is in the order things happened. An event that reaches the
 * socket late, because the phone it is about uploaded a backlog, belongs
 * below the ones that happened after it, not on top. One older than
 * everything loaded belongs on a page not loaded yet, if there is one, and
 * the next fetch brings it; appending it here would show it twice.
 */
function placeByTime(items: FeedEvent[], event: FeedEvent, morePages: boolean): FeedEvent[] {
  const at = Date.parse(event.occurredAt)
  const index = items.findIndex((item) => Date.parse(item.occurredAt) <= at)
  if (index === -1) return morePages ? items : [...items, event]
  return [...items.slice(0, index), event, ...items.slice(index)]
}

/** Mount this once, near the root. */
export function useRealtimeConnection() {
  const status = useAuthStore((state) => state.status)
  const userId = useAuthStore((state) => state.user?.id)
  const appState = useRef<AppStateStatus>(AppState.currentState)

  useEffect(() => {
    if (status !== "signed_in") {
      realtime.disconnect()
      return
    }
    if (appState.current === "active") realtime.connect()

    const subscription = AppState.addEventListener("change", (next) => {
      const wasActive = appState.current === "active"
      appState.current = next
      if (next === "active" && !wasActive) {
        realtime.connect()
        // The socket may have missed events while we were suspended.
        void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
      } else if (next !== "active" && wasActive) {
        realtime.disconnect()
      }
    })

    return () => {
      subscription.remove()
      realtime.disconnect()
    }
  }, [status, userId])
}
