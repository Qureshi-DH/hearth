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

// A firewall or a proxy in front of the server answers with its own page, and
// a 403 from it says nothing about the session. Only the server's own refusal
// may sign the phone out.
describe("a renewal refused by something in front of the server", () => {
  const firewall = (status: number) => () => ({ status, body: "<html>Access denied</html>" })

  it("keeps the session when a firewall's page answers 403", async () => {
    const { client, expired, tokens } = setup([refused, firewall(403)])
    await expect(client.get("/circles")).rejects.toBeInstanceOf(ApiError)
    expect(expired).not.toHaveBeenCalled()
    expect(tokens()).not.toBeNull()
  })

  it("keeps the session when a proxy's page answers 401", async () => {
    const { client, expired } = setup([refused, firewall(401)])
    await expect(client.get("/circles")).rejects.toBeInstanceOf(ApiError)
    expect(expired).not.toHaveBeenCalled()
  })

  it("still signs out when the server itself refuses", async () => {
    const { client, expired, tokens } = setup([refused, refused])
    await expect(client.get("/circles")).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledTimes(1)
    expect(tokens()).toBeNull()
  })
})

describe("a 401 about something other than the token", () => {
  // A wrong password is a 401 too. Renewing does not make it right, and
  // sending it again is a second 401 for the firewall to count.
  it("comes straight back for a wrong password, without renewing or asking again", async () => {
    const { client, calls, expired } = setup([
      () => ({
        status: 401,
        body: { error: { code: "wrong_password", message: "That password is not right." } },
      }),
    ])
    await expect(
      client.post("/auth/password", { currentPassword: "nope", newPassword: "a-new-one" }),
    ).rejects.toMatchObject({ status: 401, code: "wrong_password" })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /auth/password"])
    expect(expired).not.toHaveBeenCalled()
  })

  it("comes straight back for a 401 page from something in front of the server", async () => {
    const { client, calls } = setup([() => ({ status: 401, body: "<html>Denied</html>" })])
    await expect(client.get("/circles")).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
  })
})

// The native tracker uploads with the session's key when JavaScript cannot
// run, and the key lasts as long as the session, whatever its tokens do.
describe("the session's upload key", () => {
  it("is taken from a renewal that carries one", async () => {
    const { client, tokens } = setup([
      () => ({ status: 200, body: { ...renewed("second")().body, uploadKey: "hk1.key" } }),
    ])
    await client.refreshTokens()
    expect(tokens()).toMatchObject({ refreshToken: "refresh-second", uploadKey: "hk1.key" })
  })

  it("is kept through a renewal from a server that sends none", async () => {
    const { client, tokens } = setup([
      () => ({ status: 200, body: { ...renewed("second")().body, uploadKey: "hk1.key" } }),
      renewed("third"),
    ])
    await client.refreshTokens()
    await client.refreshTokens()
    expect(tokens()).toMatchObject({ refreshToken: "refresh-third", uploadKey: "hk1.key" })
  })
})
