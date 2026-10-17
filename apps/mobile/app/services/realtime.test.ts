import type { FeedEvent, MemberPresence } from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { usePushStore } from "@/stores/push"

import { realtime } from "./realtime"

jest.mock("@/services/api", () => ({
  api: { websocketUrl: () => "wss://hearth.test/api/v1/ws" },
}))
jest.mock("@/services/location/tracker", () => ({ reportNow: jest.fn() }))
const mockSchedule = jest.fn(async (..._args: unknown[]) => "id")
const mockDismiss = jest.fn(async (..._args: unknown[]) => {})
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
  dismissNotificationAsync: (...args: unknown[]) => mockDismiss(...args),
  AndroidNotificationPriority: { MAX: "max" },
}))

/** Every socket the client opened, in order. */
const sockets: FakeSocket[] = []

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(public url: string) {
    sockets.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1000 })
  }
  /** The server side of the handshake. */
  accept() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  /** The network went away underneath it. */
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006 })
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function event(id: string, minutesAgo: number): FeedEvent {
  return {
    id,
    circleId: "c1",
    type: "check_in",
    actor: null,
    occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    payload: {},
    summary: `event ${id}`,
  }
}

const feedIds = () =>
  queryClient
    .getQueryData<{ pages: Array<{ items: FeedEvent[] }> }>(queryKeys.events("c1"))!
    .pages[0]!.items.map((item) => item.id)

beforeEach(() => {
  jest.useFakeTimers()
  sockets.length = 0
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  queryClient.clear()
  jest.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)
})

afterEach(() => {
  realtime.disconnect()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe("reconnecting", () => {
  it("refetches what the socket may have missed once it is back", () => {
    realtime.connect()
    sockets[0]!.accept()
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled()

    sockets[0]!.drop()
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
    sockets[1]!.accept()

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["events"] })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["presence"] })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["trips"] })
  })

  it("keeps only the first page of a long feed before asking for it again", () => {
    queryClient.setQueryData(queryKeys.events("c1"), {
      pages: [
        { items: [event("30", 1)], nextCursor: "a" },
        { items: [event("20", 5)], nextCursor: "b" },
        { items: [event("10", 60)], nextCursor: null },
      ],
      pageParams: [undefined, "a", "b"],
    })
    realtime.connect()
    sockets[0]!.accept()
    sockets[0]!.drop()
    jest.advanceTimersByTime(1_000)
    sockets[1]!.accept()

    const cached = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(
      queryKeys.events("c1"),
    )!
    expect(cached.pages).toHaveLength(1)
    expect(cached.pageParams).toHaveLength(1)
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["events"] })
  })

  it("refetches after the app comes back from the background too", () => {
    realtime.connect()
    sockets[0]!.accept()
    realtime.disconnect()
    ;(queryClient.invalidateQueries as jest.Mock).mockClear()

    realtime.connect()
    sockets[1]!.accept()

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["events"] })
  })
})

describe("a location over the socket", () => {
  const presenceOf = (recordedAt: string): MemberPresence => ({
    userId: "sam",
    lat: 33.7,
    lon: 73.05,
    accuracyMeters: 10,
    recordedAt,
    batteryLevel: 0.6,
    isCharging: false,
    activity: "driving",
    speedMps: 11,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: false,
    atPlace: null,
    sosAlertId: null,
    issues: [],
  })

  // The 60 second poll can leave before a frame and be answered after it.
  it("never steps the dot back to an older fix than the one it has", () => {
    const newer = new Date().toISOString()
    const older = new Date(Date.now() - 30_000).toISOString()
    queryClient.setQueryData(queryKeys.presence("c1"), [presenceOf(newer)])
    realtime.connect()
    sockets[0]!.accept()

    sockets[0]!.receive({ type: "location", circleId: "c1", presence: presenceOf(older) })
    sockets[0]!.receive({ type: "presence", circleId: "c1", presences: [presenceOf(older)] })

    const cached = queryClient.getQueryData<MemberPresence[]>(queryKeys.presence("c1"))!
    expect(cached[0]!.recordedAt).toBe(newer)
  })

  it("hands every fix of a frame to a Live page open on that member", () => {
    queryClient.setQueryData(queryKeys.liveTrail("c1", "sam"), [])
    realtime.connect()
    sockets[0]!.accept()
    const fixes = [0, 1, 2].map((n) => ({
      lat: 33.7 + n * 0.0001,
      lon: 73.05,
      recordedAt: new Date(Date.now() - (3 - n) * 1_000).toISOString(),
      accuracyMeters: 5,
    }))
    sockets[0]!.receive({
      type: "location",
      circleId: "c1",
      presence: presenceOf(fixes[2]!.recordedAt),
      fixes,
    })
    expect(queryClient.getQueryData(queryKeys.liveTrail("c1", "sam"))).toEqual(fixes)
  })

  it("keeps no trail for a member nobody has open on Live", () => {
    realtime.connect()
    sockets[0]!.accept()
    const fix = { lat: 33.7, lon: 73.05, recordedAt: new Date().toISOString(), accuracyMeters: 5 }
    sockets[0]!.receive({
      type: "location",
      circleId: "c1",
      presence: presenceOf(fix.recordedAt),
      fixes: [fix],
    })
    expect(queryClient.getQueryData(queryKeys.liveTrail("c1", "sam"))).toBeUndefined()
  })

  it("replaces that member's presence in the cache, recordedAt included", () => {
    const before = new Date(Date.now() - 12 * 60_000).toISOString()
    const now = new Date().toISOString()
    queryClient.setQueryData(queryKeys.presence("c1"), [presenceOf(before)])
    realtime.connect()
    sockets[0]!.accept()

    sockets[0]!.receive({ type: "location", circleId: "c1", presence: presenceOf(now) })

    const cached = queryClient.getQueryData<MemberPresence[]>(queryKeys.presence("c1"))!
    expect(cached).toHaveLength(1)
    expect(cached[0]!.recordedAt).toBe(now)
  })
})

describe("a socket that stops answering", () => {
  const pings = (socket: FakeSocket) =>
    socket.sent
      .map((frame) => JSON.parse(frame) as { type: string })
      .filter((f) => f.type === "ping")

  // A half-open socket looks open, and Live sat on the 60 second poll.
  it("is replaced within seconds while a Live page is open", () => {
    realtime.connect()
    sockets[0]!.accept()
    const release = realtime.watchClosely()
    jest.advanceTimersByTime(5_000)
    expect(pings(sockets[0]!)).toHaveLength(1)
    jest.advanceTimersByTime(4_000)
    expect(sockets).toHaveLength(2)
    release()
  })

  it("is left alone while it answers", () => {
    realtime.connect()
    sockets[0]!.accept()
    const release = realtime.watchClosely()
    for (let n = 0; n < 4; n += 1) {
      jest.advanceTimersByTime(5_000)
      sockets[0]!.receive({ type: "pong", serverTime: new Date().toISOString() })
    }
    jest.advanceTimersByTime(4_000)
    expect(sockets).toHaveLength(1)
    release()
  })

  it("is replaced on the slower beat when nothing is live", () => {
    realtime.connect()
    sockets[0]!.accept()
    jest.advanceTimersByTime(25_000)
    expect(pings(sockets[0]!)).toHaveLength(1)
    jest.advanceTimersByTime(9_000)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(2_000)
    expect(sockets).toHaveLength(2)
  })

  it("asks a Live page's trail to fill in once a new one is open", () => {
    realtime.connect()
    sockets[0]!.accept()
    sockets[0]!.drop()
    jest.advanceTimersByTime(1_000)
    sockets[1]!.accept()
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["live-trail"] })
  })
})

describe("whether the socket is down", () => {
  it("is down from the moment it is wanted until a socket opens", () => {
    expect(realtime.downSince).toBeNull()
    realtime.connect()
    expect(realtime.downSince).not.toBeNull()
    sockets[0]!.accept()
    expect(realtime.downSince).toBeNull()
    sockets[0]!.drop()
    expect(realtime.downSince).not.toBeNull()
  })

  it("is not down when it is not wanted, in the background or signed out", () => {
    realtime.connect()
    realtime.disconnect()
    expect(realtime.downSince).toBeNull()
  })

  it("tells whoever listens when it changes", () => {
    const heard = jest.fn()
    const stop = realtime.onStatusChange(heard)
    realtime.connect()
    sockets[0]!.accept()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe("someone joining or leaving the circle", () => {
  it("refreshes who is on the map, not just the member list", () => {
    realtime.connect()
    sockets[0]!.accept()
    ;(queryClient.invalidateQueries as jest.Mock).mockClear()
    sockets[0]!.receive({
      type: "event",
      circleId: "c1",
      event: { ...event("40", 0), type: "member_joined" },
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.members("c1"),
    })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.presence("c1"),
    })
  })
})

describe("a feed event over the socket", () => {
  beforeEach(() => {
    queryClient.setQueryData(queryKeys.events("c1"), {
      pages: [{ items: [event("20", 5), event("10", 60)], nextCursor: null }],
      pageParams: [undefined],
    })
    realtime.connect()
    sockets[0]!.accept()
  })

  it("goes on top when it is the newest thing that happened", () => {
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("30", 1) })
    expect(feedIds()).toEqual(["30", "20", "10"])
  })

  it("lands where it happened when it arrives late", () => {
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("30", 30) })
    expect(feedIds()).toEqual(["20", "30", "10"])
  })

  it("goes at the end when it is older than everything loaded and there is no more", () => {
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("5", 120) })
    expect(feedIds()).toEqual(["20", "10", "5"])
  })

  it("is left for the next page when it is older than what is loaded so far", () => {
    queryClient.setQueryData(queryKeys.events("c1"), {
      pages: [{ items: [event("20", 5), event("10", 60)], nextCursor: "some-cursor" }],
      pageParams: [undefined],
    })
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("5", 120) })
    expect(feedIds()).toEqual(["20", "10"])
  })

  it("is not added twice", () => {
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("20", 5) })
    expect(feedIds()).toEqual(["20", "10"])
  })
})

describe("a socket the server refused for its token", () => {
  it("comes back once the token has been refreshed", () => {
    realtime.connect()
    sockets[0]!.readyState = FakeSocket.CLOSED
    sockets[0]!.onclose?.({ code: 4401 })
    jest.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)

    realtime.refresh()

    expect(sockets).toHaveLength(2)
  })
})

describe("an alert over the socket on a server without push", () => {
  const sam = { id: "sam", displayName: "Sam", avatarColor: "#888888", avatarUrl: null }
  // One press opens an alert in each circle in the same transaction, so they
  // share a start. Separate presses never do.
  let pressed = 0
  const sos = (
    id: string,
    user = sam,
    circleId = "c1",
    startedAt = new Date(Date.UTC(2026, 0, 1) + (pressed += 1) * 60_000).toISOString(),
  ) => ({
    type: "sos",
    circleId,
    alert: {
      id,
      circleId,
      user,
      startedAt,
      resolvedAt: null,
      resolvedBy: null,
      note: null,
      lastLat: 51.45,
      lastLon: -2.58,
      lastFixAt: new Date().toISOString(),
    },
  })
  const scheduled = () => mockSchedule.mock.calls.map(([request]) => request as Record<string, any>)

  beforeEach(() => {
    mockSchedule.mockClear()
    mockDismiss.mockClear()
    useAuthStore.setState({
      user: { id: "me" } as never,
      serverInfo: { pushProvider: "none" } as never,
    })
    usePushStore.setState({ setup: { kind: "none" } })
    realtime.connect()
    sockets[0]!.accept()
  })

  afterEach(() => {
    useAuthStore.setState({ user: null, serverInfo: null })
    usePushStore.setState({ setup: null })
  })

  it("rings for somebody else's SOS on the SOS channel, with no position in it", () => {
    sockets[0]!.receive(sos("a1"))

    expect(scheduled()).toHaveLength(1)
    const [request] = scheduled()
    expect(request!.trigger).toEqual({ channelId: "sos" })
    expect(request!.content.interruptionLevel).toBe("timeSensitive")
    expect(request!.content.data).toEqual({ type: "sos_started", alertId: "a1", circleId: "c1" })
    expect(JSON.stringify(request)).not.toContain("51.45")
  })

  it("rings once for an alert, however many times the frame arrives", () => {
    const frame = sos("a2")
    sockets[0]!.receive(frame)
    sockets[0]!.receive(frame)
    expect(scheduled()).toHaveLength(1)
  })

  it("never rings for your own SOS", () => {
    sockets[0]!.receive(sos("a3", { ...sam, id: "me" }))
    expect(scheduled()).toHaveLength(0)
  })

  it("leaves it to push when the server has a provider", () => {
    useAuthStore.setState({ serverInfo: { pushProvider: "expo" } as never })
    usePushStore.setState({ setup: { kind: "registered", provider: "expo" } })
    sockets[0]!.receive(sos("a4"))
    expect(scheduled()).toHaveLength(0)
  })

  it("rings when push is configured but cannot reach this phone", () => {
    useAuthStore.setState({ serverInfo: { pushProvider: "expo" } as never })
    usePushStore.setState({ setup: { kind: "unsupported", reason: "no project id" } })
    sockets[0]!.receive(sos("a5"))
    expect(scheduled()).toHaveLength(1)
  })

  it("rings for the server's possible-incident check, which arrives as a feed event", () => {
    sockets[0]!.receive({
      type: "event",
      circleId: "c1",
      event: {
        ...event("e1", 0),
        type: "possible_incident",
        actor: sam,
        summary: "Sam stopped suddenly after driving at 60 km/h",
      },
    })

    expect(scheduled()).toHaveLength(1)
    const [request] = scheduled()
    expect(request!.trigger).toEqual({ channelId: "sos" })
    expect(request!.content.body).toBe("Sam stopped suddenly after driving at 60 km/h")
    expect(request!.content.data).toEqual(
      expect.objectContaining({ type: "possible_incident", circleId: "c1", userId: "sam" }),
    )
  })

  it("rings once for one press, though it opened an alert in each circle", () => {
    const at = "2026-02-01T09:00:00.000Z"
    sockets[0]!.receive(sos("a7", sam, "c1", at))
    sockets[0]!.receive(sos("a8", sam, "c2", at))
    expect(scheduled()).toHaveLength(1)
    const [request] = scheduled()

    // An admin closing it in one circle leaves it open in the other.
    sockets[0]!.receive({
      type: "event",
      circleId: "c1",
      event: { ...event("e3", 0), type: "sos_resolved", payload: { alertId: "a7" } },
    })
    expect(mockDismiss).not.toHaveBeenCalled()
    sockets[0]!.receive({
      type: "event",
      circleId: "c2",
      event: {
        ...event("e4", 0),
        circleId: "c2",
        type: "sos_resolved",
        payload: { alertId: "a8" },
      },
    })
    expect(mockDismiss).toHaveBeenCalledWith(request!.identifier)
  })

  it("takes the SOS away again once it is resolved", () => {
    sockets[0]!.receive(sos("a6"))
    const [request] = scheduled()
    sockets[0]!.receive({
      type: "event",
      circleId: "c1",
      event: { ...event("e2", 0), type: "sos_resolved", payload: { alertId: "a6" } },
    })
    expect(mockDismiss).toHaveBeenCalledWith(request!.identifier)
  })
})

describe("the circles the socket says it got", () => {
  // The server says so when somebody removes you or deletes a circle. Left
  // in the list, the circle goes on being polled, a 403 every time.
  it("asks for the circles again when one the app holds is missing", () => {
    queryClient.setQueryData(queryKeys.circles, [{ id: "c1" }, { id: "c2" }])
    const fetchSpy = jest.fn(async () => [{ id: "c1" }])
    queryClient.getQueryCache().find({ queryKey: queryKeys.circles })!.setOptions({
      queryKey: queryKeys.circles,
      queryFn: fetchSpy,
    })
    realtime.connect()
    sockets[0]!.accept()

    sockets[0]!.receive({ type: "subscribed", circleIds: ["c1"] })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("leaves the list alone when the socket agrees with it", () => {
    queryClient.setQueryData(queryKeys.circles, [{ id: "c1" }])
    const fetchSpy = jest.fn(async () => [{ id: "c1" }])
    queryClient.getQueryCache().find({ queryKey: queryKeys.circles })!.setOptions({
      queryKey: queryKeys.circles,
      queryFn: fetchSpy,
    })
    realtime.connect()
    sockets[0]!.accept()

    sockets[0]!.receive({ type: "subscribed", circleIds: ["c1"] })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("ignores a message it has never heard of, as an older app does", () => {
    realtime.connect()
    sockets[0]!.accept()
    expect(() => sockets[0]!.receive({ type: "something_new", circleId: "c1" })).not.toThrow()
  })
})
