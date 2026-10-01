import { ApiClient, ApiError, type TokenPair } from "./client"

/**
 * The client behind a proxy that turns every 4xx into a few minutes of 429s
 * for the whole address: the shape of a firewall in front of a home server.
 * Every 401 the phone can avoid is a family locked out for a while.
 */

const BASE = "https://hearth.example"

/** An access token the way the server signs them, lifetime and all. */
function accessToken(name: string, lifetimeSeconds = 900, issuedAtSeconds = 1_000_000) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: name, iat: issuedAtSeconds, exp: issuedAtSeconds + lifetimeSeconds }),
    "signature",
  ].join(".")
}

interface Call {
  method: string
  path: string
  token: string | null
}

function setup(answers: Array<(call: Call) => { status: number; body?: unknown }>) {
  let tokens: TokenPair | null = { accessToken: accessToken("first"), refreshToken: "refresh-1" }
  const calls: Call[] = []
  const expired = jest.fn()
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const call: Call = {
      method: init.method ?? "GET",
      path: url.replace(`${BASE}/api/v1`, ""),
      token: headers.authorization?.replace("Bearer ", "") ?? null,
    }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected ${call.method} ${call.path}`)
    const { status, body } = answer(call)
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  })
  global.fetch = fetchMock as unknown as typeof fetch
  const client = new ApiClient({
    getBaseUrl: () => BASE,
    getTokens: () => tokens,
    setTokens: (next) => {
      tokens = next
    },
    onSessionExpired: expired,
    getDeviceId: () => "phone-1",
  })
  return { client, calls, expired, tokens: () => tokens }
}

const ok =
  (body: unknown = {}) =>
  () => ({ status: 200, body })
const refused = () => ({
  status: 401,
  body: { error: { code: "unauthorized", message: "This session is no longer valid." } },
})
const blocked = () => ({ status: 429, body: { error: { code: "blocked", message: "Blocked." } } })
const renewed = (name: string) => () => ({
  status: 200,
  body: { accessToken: accessToken(name), refreshToken: `refresh-${name}`, expiresIn: 900 },
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("a token the server refuses", () => {
  it("is renewed and the request sent once more", async () => {
    const { client, calls } = setup([refused, renewed("second"), ok({ hello: true })])
    await expect(client.get("/circles")).resolves.toEqual({ hello: true })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /circles",
      "POST /auth/refresh",
      "GET /circles",
    ])
  })

  // A phone signed out from another device used to send its dead token again
  // every time the firewall let it through, and every one of those 401s shut
  // the whole household out again.
  it("is not sent again while its renewal goes unanswered", async () => {
    const { client, calls, expired, tokens } = setup([refused, blocked, refused])
    await expect(client.get("/circles")).rejects.toBeInstanceOf(ApiError)

    await expect(client.get("/circles")).rejects.toMatchObject({ status: 401 })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /circles",
      "POST /auth/refresh",
      "POST /auth/refresh",
    ])
    expect(expired).toHaveBeenCalledTimes(1)
    expect(tokens()).toBeNull()
  })

  it("carries on once a renewal gets through", async () => {
    const { client, calls } = setup([refused, blocked, renewed("second"), ok({ hello: true })])
    await expect(client.get("/circles")).rejects.toBeInstanceOf(ApiError)

    await expect(client.get("/circles")).resolves.toEqual({ hello: true })
    expect(calls.at(-1)).toMatchObject({ method: "GET", token: accessToken("second") })
  })

  it("says why when the renewal is still unanswered", async () => {
    const { client } = setup([refused, blocked, blocked])
    await expect(client.get("/circles")).rejects.toBeInstanceOf(ApiError)
    await expect(client.get("/circles")).rejects.toMatchObject({ status: 429 })
  })
})

describe("a token about to run out", () => {
  it("is renewed before it is sent, so the server never has to refuse it", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(5_000_000)
    const { client, calls } = setup([ok(), renewed("second"), ok()])
    await client.get("/circles")

    now.mockReturnValue(5_000_000 + 880_000)
    await client.get("/circles")

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /circles",
      "POST /auth/refresh",
      "GET /circles",
    ])
    expect(calls.at(-1)?.token).toBe(accessToken("second"))
  })

  // The token's own times are the server's clock. Read against a phone set an
  // hour wrong, every token would look spent and every call would renew.
  it("is judged by how long this phone has held it, not by the phone's clock", async () => {
    jest.spyOn(Date, "now").mockReturnValue(99_000_000_000)
    const { client, calls } = setup([ok(), ok()])
    await client.get("/circles")
    await client.get("/places")
    expect(calls.map((call) => call.path)).toEqual(["/circles", "/places"])
  })
})
