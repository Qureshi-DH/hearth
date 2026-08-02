import type { FeedEvent } from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { queryClient } from "@/services/queryClient"

import { realtime } from "./realtime"

jest.mock("@/services/api", () => ({
  api: { websocketUrl: () => "wss://hearth.test/api/v1/ws" },
}))
jest.mock("@/services/location/tracker", () => ({ reportNow: jest.fn() }))

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

  it("is not added twice", () => {
    sockets[0]!.receive({ type: "event", circleId: "c1", event: event("20", 5) })
    expect(feedIds()).toEqual(["20", "10"])
  })
})
