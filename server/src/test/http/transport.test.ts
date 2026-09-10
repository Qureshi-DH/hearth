import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { buildApp, proxyTrust } from "../../app"
import { loadConfig, resetConfig } from "../../env"
import { loggerOptions, scrubUrl } from "../../logger"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The transport layer: dates Postgres cannot hold, an X-Forwarded-For header a
 * client cannot use to pick its own rate-limit bucket, and tokens kept out of
 * the log.
 */

const YEAR_ZERO = "0000-01-01T00:00:00Z"

const testEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://hearth:hearth@localhost:55432/hearth",
  JWT_SECRET: "test-secret-test-secret-test-secret-test-secret",
  REGISTRATION_MODE: "open",
  PUSH_PROVIDER: "none",
  ENABLE_JOBS: "false",
  ENABLE_SWAGGER: "false",
  RATE_LIMIT_MAX: "100000",
} as NodeJS.ProcessEnv

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

describe("date parameters that Postgres cannot represent", () => {
  async function alice() {
    const user = await registerUser(ctx.app)
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: user.headers,
      payload: { name: "Home" },
    })
    expect(created.statusCode).toBe(201)
    const circleId = (created.json() as { id: string }).id
    return { ...user, circleId }
  }

  it("rejects year zero on history rather than handing it to the driver", async () => {
    const user = await alice()
    const base = `/api/v1/circles/${user.circleId}/members/${user.user.id}/history`

    for (const url of [`${base}?to=${YEAR_ZERO}`, `${base}?from=${YEAR_ZERO}`]) {
      const response = await ctx.app.inject({ method: "GET", url, headers: user.headers })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: { code: string } }).error.code).toBe("validation_error")
    }
  })

  it("rejects year zero on the history delete", async () => {
    const user = await alice()
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/me/history?before=${YEAR_ZERO}`,
      headers: user.headers,
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe("validation_error")
  })

  it("still accepts the ranges a client actually sends", async () => {
    const user = await alice()
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const history = await ctx.app.inject({
      method: "GET",
      url:
        `/api/v1/circles/${user.circleId}/members/${user.user.id}/history` +
        `?from=${yesterday.toISOString()}&to=${now.toISOString()}`,
      headers: user.headers,
    })
    expect(history.statusCode).toBe(200)

    const erased = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/me/history?before=${now.toISOString()}`,
      headers: user.headers,
    })
    expect(erased.statusCode).toBe(200)
    expect(erased.json()).toEqual({ ok: true, deleted: 0 })
  })
})

describe("X-Forwarded-For cannot pick the caller's own address", () => {
  async function ipSeenBy(
    trustProxy: ReturnType<typeof proxyTrust> | true,
    forwardedFor: string | undefined,
    peer: string,
  ) {
    const app = Fastify({ trustProxy, logger: false })
    app.get("/ip", async (request) => ({ ip: request.ip, protocol: request.protocol }))
    await app.ready()
    const headers: Record<string, string> = { "x-forwarded-proto": "https" }
    if (forwardedFor) headers["x-forwarded-for"] = forwardedFor
    const response = await app.inject({ method: "GET", url: "/ip", headers, remoteAddress: peer })
    await app.close()
    return response.json() as { ip: string; protocol: string }
  }

  const trusted = proxyTrust(true)

  it("reads the address the proxy appended, not the one the caller sent", async () => {
    const forged = "1.2.3.4, 203.0.113.9"

    // nginx on the same host, then the same proxy inside a compose network.
    expect((await ipSeenBy(trusted, forged, "127.0.0.1")).ip).toBe("203.0.113.9")
    expect((await ipSeenBy(trusted, forged, "172.18.0.4")).ip).toBe("203.0.113.9")
    expect((await ipSeenBy(trusted, "9.9.9.9, 8.8.8.8, 203.0.113.9", "::1")).ip).toBe("203.0.113.9")

    // The setting this replaced took the leftmost value, so every request could
    // carry a rate-limit key of the caller's choosing.
    expect((await ipSeenBy(true, forged, "127.0.0.1")).ip).toBe("1.2.3.4")
  })

  it("gives every forged chain the same key, so the throttle still bites", async () => {
    const seen = new Set<string>()
    for (let n = 1; n <= 20; n += 1) {
      seen.add((await ipSeenBy(trusted, `203.0.113.${n}, 198.51.100.7`, "127.0.0.1")).ip)
    }
    expect([...seen]).toEqual(["198.51.100.7"])
  })

  it("believes nothing from a caller that is not on a private network", async () => {
    const direct = await ipSeenBy(trusted, "1.2.3.4", "198.51.100.22")
    expect(direct.ip).toBe("198.51.100.22")
    expect(direct.protocol).toBe("http")
  })

  it("falls back to the socket address when the proxy sends no header", async () => {
    expect((await ipSeenBy(trusted, undefined, "127.0.0.1")).ip).toBe("127.0.0.1")
  })

  it("ignores the header entirely when TRUST_PROXY is off", async () => {
    expect(proxyTrust(false)).toBe(false)
    expect((await ipSeenBy(proxyTrust(false), "203.0.113.9", "10.0.0.1")).ip).toBe("10.0.0.1")
  })
})

describe("the login throttle behind a real proxy", () => {
  let proxied: FastifyInstance

  beforeAll(async () => {
    resetConfig()
    loadConfig({ ...testEnv, TRUST_PROXY: "true" })
    proxied = await buildApp()
    await proxied.ready()
  })

  afterAll(async () => {
    await proxied.close()
    resetConfig()
    loadConfig(testEnv)
  })

  it("still cuts off wrong passwords when every request forges a new address", async () => {
    const user = await registerUser(ctx.app)

    const codes: number[] = []
    for (let n = 1; n <= 12; n += 1) {
      const response = await proxied.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-forwarded-for": `203.0.113.${n}, 198.51.100.7` },
        remoteAddress: "127.0.0.1",
        payload: {
          email: user.email,
          password: "not-the-password",
          device: { deviceId: "throttle-probe", deviceName: "Probe", platform: "ios" },
        },
      })
      codes.push(response.statusCode)
    }

    expect(codes.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(codes.slice(8)).toEqual(Array(4).fill(429))
  })
})

describe("the login throttle across an IPv6 network", () => {
  it("counts every address in one /64 as the same client", async () => {
    const user = await registerUser(ctx.app)

    const codes: number[] = []
    for (let n = 1; n <= 10; n += 1) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: `2001:db8:1234:5678::${n.toString(16)}`,
        payload: {
          email: user.email,
          password: "not-the-password",
          device: { deviceId: "throttle-probe-v6", deviceName: "Probe", platform: "ios" },
        },
      })
      codes.push(response.statusCode)
    }

    expect(codes.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(codes.slice(8)).toEqual([429, 429])
  })
})

describe("logger scrubbing outside production", () => {
  afterEach(() => {
    resetConfig()
    loadConfig(testEnv)
  })

  function reqSerializerFor(env: NodeJS.ProcessEnv) {
    resetConfig()
    loadConfig(env)
    const options = loggerOptions() as {
      redact?: { paths: string[] }
      serializers?: { req(request: { method: string; url: string; ip: string }): { url: string } }
      transport?: unknown
    }
    return options
  }

  it("redacts the websocket token in development, where NODE_ENV is unset", () => {
    const options = reqSerializerFor({ ...testEnv, NODE_ENV: undefined, LOG_LEVEL: undefined })

    expect(options.redact?.paths).toContain("req.headers.authorization")
    expect(options.transport).toBeDefined()

    const line = options.serializers?.req({
      method: "GET",
      url: "/api/v1/ws?access_token=eyJhbGciOiJIUzI1NiJ9.payload.signature",
      ip: "127.0.0.1",
    })
    expect(line?.url).toBe("/api/v1/ws?access_token=[redacted]")
  })

  it("keeps production quiet and unpretty", () => {
    const options = reqSerializerFor({
      ...testEnv,
      NODE_ENV: "production",
      ADMIN_EMAIL: "admin@example.test",
      ADMIN_PASSWORD: "correct-horse-battery",
    })

    expect(options.transport).toBeUndefined()
    expect(options.redact?.paths).toContain("body.password")
  })

  it("scrubs the token wherever it appears in the query string", () => {
    expect(scrubUrl("/api/v1/ws?v=1&access_token=abc.def.ghi&x=2")).toBe(
      "/api/v1/ws?v=1&access_token=[redacted]&x=2",
    )
  })
})
