import { control, setControlHandler } from "./control"

jest.mock("@/services/api", () => ({
  api: { websocketUrl: () => mockUrl, refreshTokens: () => mockRefreshTokens() },
}))

let mockUrl: string | null = "wss://hearth.test/api/v1/ws?access_token=t"
const mockRefreshTokens = jest.fn(async (): Promise<{ accessToken: string } | null> => null)

/** Every socket the channel opened, in order. */
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
  accept() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  drop() {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006 })
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const handler = { watch: jest.fn(async () => {}), wake: jest.fn(async () => {}) }

beforeEach(() => {
  jest.useFakeTimers()
  sockets.length = 0
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  mockUrl = "wss://hearth.test/api/v1/ws?access_token=t"
  handler.watch.mockClear()
  handler.wake.mockClear()
  mockRefreshTokens.mockReset()
  mockRefreshTokens.mockImplementation(async () => null)
  setControlHandler(handler)
})

afterEach(() => {
  control.setWanted(false)
  jest.useRealTimers()
})

describe("the control channel", () => {
  it("opens when wanted and declares itself the phone's channel", () => {
    control.setWanted(true)
    expect(sockets).toHaveLength(1)
    sockets[0]!.accept()
    expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "control" }])
  })

  it("does nothing until it is wanted, and closes when it is not", () => {
    expect(sockets).toHaveLength(0)
    control.setWanted(true)
    sockets[0]!.accept()
    control.setWanted(false)
    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED)
    jest.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })

  it("hands a watch and a wake to the tracker", async () => {
    control.setWanted(true)
    sockets[0]!.accept()
    sockets[0]!.receive({ type: "control", command: "watch", seconds: 600 })
    sockets[0]!.receive({ type: "control", command: "wake" })
    await Promise.resolve()
    expect(handler.watch).toHaveBeenCalledWith(600)
    expect(handler.wake).toHaveBeenCalledTimes(1)
  })

  it("comes back on its own after the connection drops", () => {
    control.setWanted(true)
    sockets[0]!.accept()
    sockets[0]!.drop()
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
    sockets[1]!.drop()
    // Backing off, so a server that is down is not hammered.
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(3)
  })

  it("sends nothing of its own once declared; the OS answers the server's pings", () => {
    // Every frame from the phone wakes its radio. The server pings, and the
    // socket layer answers those without the app.
    control.setWanted(true)
    sockets[0]!.accept()
    jest.advanceTimersByTime(30 * 60_000)
    expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "control" }])
  })

  it("reconnects with the new token when asked", () => {
    control.setWanted(true)
    sockets[0]!.accept()
    mockUrl = "wss://hearth.test/api/v1/ws?access_token=t2"
    control.refresh()
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.url).toContain("access_token=t2")
  })

  it("renews its token itself after being refused, and reconnects with it", async () => {
    // A parked phone may make no REST call for a quarter hour, so the
    // channel cannot wait for one to rotate the token.
    mockRefreshTokens.mockImplementationOnce(async () => {
      mockUrl = "wss://hearth.test/api/v1/ws?access_token=t2"
      return { accessToken: "t2" }
    })
    control.setWanted(true)
    sockets[0]!.readyState = FakeSocket.CLOSED
    sockets[0]!.onclose?.({ code: 4401 })
    await Promise.resolve()
    await Promise.resolve()
    expect(mockRefreshTokens).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.url).toContain("access_token=t2")
  })

  it("tries the renewal again later when it fails for want of a network", async () => {
    control.setWanted(true)
    sockets[0]!.readyState = FakeSocket.CLOSED
    sockets[0]!.onclose?.({ code: 4401 })
    await Promise.resolve()
    await Promise.resolve()
    expect(mockRefreshTokens).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(mockRefreshTokens).toHaveBeenCalledTimes(2)
  })

  it("stops trying once it is no longer wanted", async () => {
    control.setWanted(true)
    sockets[0]!.readyState = FakeSocket.CLOSED
    sockets[0]!.onclose?.({ code: 4401 })
    await Promise.resolve()
    control.setWanted(false)
    jest.advanceTimersByTime(120_000)
    expect(mockRefreshTokens).toHaveBeenCalledTimes(1)
  })

  it("does not open without a server or a token", () => {
    mockUrl = null
    control.setWanted(true)
    expect(sockets).toHaveLength(0)
  })
})

describe("a channel wanted before the tokens are loaded", () => {
  it("opens once they are, without waiting for a rotation", () => {
    mockUrl = null
    control.setWanted(true)
    expect(sockets).toHaveLength(0)

    // The tracker asks again once the keychain has handed the tokens over.
    mockUrl = "wss://hearth.test/api/v1/ws?access_token=t"
    control.setWanted(true)

    expect(sockets).toHaveLength(1)
  })
})
