import { useEffect, useRef } from "react"
import { AppState, type AppStateStatus } from "react-native"
import type {
  FeedEvent,
  MemberPresence,
  Paginated,
  TrailFix,
  WsServerMessage,
} from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { api } from "@/services/api"
import { reportNow } from "@/services/location/tracker"
import { queryClient, recheckCircles } from "@/services/queryClient"
import { noticeSocketAlert } from "@/services/socketAlerts"
import { useAuthStore } from "@/stores/auth"
import { useNudgeStore } from "@/stores/nudge"
import { mergePresence, withPresence } from "@/utils/presence"
import { mergeTrail } from "@/utils/trail"

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const PING_INTERVAL_MS = 25_000
/**
 * A socket can be open on paper with nothing behind it, after a network
 * change or a NAT that forgot it, and nothing says so until a ping goes
 * unanswered. The server answers within milliseconds, so this long without
 * a word is a dead socket, and a new one is opened.
 */
const PONG_DEADLINE_MS = 10_000
/** While a Live page is open the map falls behind a second at a time, so it is checked far more often. */
const LIVE_PING_INTERVAL_MS = 5_000
const LIVE_PONG_DEADLINE_MS = 4_000

type Listener = (message: WsServerMessage) => void

/**
 * One websocket for the screens, alive only in the foreground. Kept open in
 * the background it would wake the radio of a phone in a pocket for every
 * frame the map wants. Background asks come down the tracker's own control
 * channel instead (services/location/control.ts), which carries nothing but
 * asks, or by silent push when that is closed.
 *
 * Incoming frames are written straight into the React Query cache. Screens
 * render query data and never subscribe to the socket. A quick message is the
 * exception. Nothing keeps it, so it goes to the store the banner reads. An SOS
 * on a server with no push is the other one, because it has to ring.
 */
class RealtimeClient {
  private socket: WebSocket | null = null
  private backoff = MIN_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private wanted = false
  private listeners = new Set<Listener>()
  private statusListeners = new Set<() => void>()
  /** Live pages open, which ask for the closer check. */
  private closely = 0
  private down: number | null = null
  /**
   * Whether a socket has been open before. The one that follows it has a
   * gap behind it, in the background or through a dropped connection, and
   * what the server said during the gap is gone.
   */
  private hadSocket = false

  connect() {
    this.wanted = true
    this.open()
    this.noteStatus()
  }

  disconnect() {
    this.wanted = false
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.noteStatus()
  }

  /**
   * Since when the socket has been wanted and not open, or null while it is
   * open or not wanted at all. A screen says it is reconnecting once this is
   * a few seconds old.
   */
  get downSince(): number | null {
    return this.down
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /**
   * A Live page is open. Until the returned function is called, the socket
   * is pinged every few seconds and replaced as soon as one goes unanswered,
   * since a socket that looks open and carries nothing leaves the page on
   * the minute's poll.
   */
  watchClosely(): () => void {
    this.closely += 1
    this.restartPings()
    let released = false
    return () => {
      if (released) return
      released = true
      this.closely = Math.max(0, this.closely - 1)
      this.restartPings()
    }
  }

  private noteStatus() {
    const down = this.wanted && !this.connected ? (this.down ?? Date.now()) : null
    if (down === this.down) return
    this.down = down
    for (const listener of this.statusListeners) listener()
  }

  private restartPings() {
    const socket = this.socket
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const live = this.closely > 0
    this.pingTimer = setInterval(
      () => this.ping(socket, live ? LIVE_PONG_DEADLINE_MS : PONG_DEADLINE_MS),
      live ? LIVE_PING_INTERVAL_MS : PING_INTERVAL_MS,
    )
  }

  private ping(socket: WebSocket, deadlineMs: number) {
    if (socket.readyState !== WebSocket.OPEN || this.socket !== socket) return
    socket.send(JSON.stringify({ type: "ping" }))
    if (this.pongTimer) return
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      if (this.socket === socket) this.replace(socket)
    }, deadlineMs)
  }

  /** The socket went quiet without closing. Its own close may never come, so it is let go now. */
  private replace(socket: WebSocket) {
    this.socket = null
    this.clearTimers()
    socket.close()
    this.noteStatus()
    this.open()
  }

  /**
   * An open socket is closed and its onclose reconnects with the current
   * token. One the server already refused with 4401 is gone and waits for
   * this, and the refused socket usually loses the race to the refresh that
   * follows it, so it is opened here.
   */
  refresh() {
    if (!this.wanted) return
    if (this.socket) {
      this.socket.close()
      return
    }
    this.clearTimers()
    this.open()
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
      this.restartPings()
      this.noteStatus()
      if (this.hadSocket) refetchMissed()
      this.hadSocket = true
    }

    socket.onmessage = (event) => {
      // Anything at all from the server is the answer a ping waits for.
      if (this.socket === socket && this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
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
      this.noteStatus()
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
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.reconnectTimer = null
    this.pingTimer = null
    this.pongTimer = null
  }

  private handle(message: WsServerMessage) {
    noticeSocketAlert(message)
    switch (message.type) {
      case "presence":
        queryClient.setQueryData<MemberPresence[]>(
          queryKeys.presence(message.circleId),
          (current) => mergePresence(current, message.presences),
        )
        break

      case "location":
        queryClient.setQueryData<MemberPresence[]>(
          queryKeys.presence(message.circleId),
          (current) => withPresence(current, message.presence),
        )
        if (message.fixes?.length) {
          addLiveFixes(message.circleId, message.presence.userId, message.fixes)
        }
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

      case "subscribed": {
        // The app never narrows its subscription, so this is every circle the
        // server has it in. One the list holds that is missing here was left,
        // lost to a removal or deleted, and the list is asked for again so
        // the hooks stop polling it. Asked, not trimmed here, because a
        // circle joined a moment ago can be missing from this too.
        const circles = queryClient.getQueryData<Array<{ id: string }>>(queryKeys.circles)
        const got = new Set(message.circleIds)
        const differs =
          circles !== undefined &&
          (circles.some((circle) => !got.has(circle.id)) || got.size !== circles.length)
        if (differs) recheckCircles()
        break
      }

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
 * Every fix of an upload, for a Live page open on that member. Nothing is
 * kept for anybody nobody is following, and the page's own query is what
 * says somebody is.
 */
function addLiveFixes(circleId: string, userId: string, fixes: TrailFix[]) {
  const key = queryKeys.liveTrail(circleId, userId)
  if (!queryClient.getQueryCache().find({ queryKey: key, exact: true })) return
  queryClient.setQueryData<TrailFix[]>(key, (current) => mergeTrail(current ?? [], fixes))
}

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
  void queryClient.invalidateQueries({ queryKey: ["live-trail"] })
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
  const appState = useRef(AppState.currentState as AppStateStatus)

  useEffect(() => {
    if (status !== "signed_in") {
      realtime.disconnect()
      return
    }
    if (appState.current === "active") realtime.connect()

    // Only the background closes it. Pulling down Control Centre on an
    // iPhone makes the app inactive with the screen still showing, and a
    // socket closed for that left Live on the minute's poll until it reopened.
    let away = false
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = appState.current
      appState.current = next
      if (next === "active" && previous !== "active") {
        realtime.connect()
        // The socket may have missed events while we were suspended.
        if (away) void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
        away = false
      } else if (next === "background" && !away) {
        away = true
        realtime.disconnect()
      }
    })

    return () => {
      subscription.remove()
      realtime.disconnect()
    }
  }, [status, userId])
}
