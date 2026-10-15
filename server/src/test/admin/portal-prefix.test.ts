import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliCompressSync } from "node:zlib"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { basePath, stripBasePath } from "../../lib/base-path"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Hearth behind a proxy at a path, with another app at the root of the
 * domain. Some proxies hand the path on and some strip it first, Caddy's
 * handle and handle_path, so everything here is asked for both ways.
 */

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hearth admin</title>
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="portal.css" />
    <script type="module" src="portal.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`

const built = mkdtempSync(join(tmpdir(), "hearth-portal-"))
writeFileSync(join(built, "index.html"), PAGE)
// A compressed copy of the page as built, which knows nothing of the path.
writeFileSync(join(built, "index.html.br"), brotliCompressSync(PAGE))
writeFileSync(join(built, "portal.js"), "console.log('portal')")
writeFileSync(join(built, "portal.css"), "body{}")

const ORIGIN = "http://lab.example.test"

let ctx: TestContext
let socketOrigin: string

beforeAll(async () => {
  ctx = await startTestApp({
    PUBLIC_URL: `${ORIGIN}/hearth/`,
    ADMIN_PORTAL_DIR: built,
    ENABLE_SWAGGER: "true",
  })
  await ctx.app.listen({ host: "127.0.0.1", port: 0 })
  socketOrigin = `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

const html = { accept: "text/html,application/xhtml+xml" }

function expectPortalPage(response: {
  statusCode: number
  body: string
  headers: Record<string, unknown>
}) {
  expect(response.statusCode).toBe(200)
  expect(response.headers["content-type"]).toContain("text/html")
  expect(response.body).toContain('<base href="/hearth/"')
  expect(response.body).toContain('<meta name="hearth-base" content="/hearth"')
  expect(response.body).toContain('src="portal.js"')
  expect(response.body).toContain('href="portal.css"')
  const policy = String(response.headers["content-security-policy"])
  expect(policy).toContain("default-src 'self'")
  expect(policy).toContain("script-src 'self'")
  expect(response.headers["cache-control"]).toContain("no-cache")
}

describe.each([
  ["a proxy that strips the path", ""],
  ["a proxy that hands it on", "/hearth"],
])("behind %s", (_style, prefix) => {
  it("reaches the API", async () => {
    const response = await ctx.app.inject({ method: "GET", url: `${prefix}/api/v1/server-info` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ apiVersion: "v1" })
  })

  it("reaches the probes and the invite page", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `${prefix}/healthz` })).statusCode).toBe(200)
    expect((await ctx.app.inject({ method: "GET", url: `${prefix}/readyz` })).statusCode).toBe(200)
    const join = await ctx.app.inject({ method: "GET", url: `${prefix}/join/ABCD1234` })
    expect(join.body).toContain("Join a circle")
  })

  it("answers the portal's address with the page, told where it is", async () => {
    expectPortalPage(await ctx.app.inject({ method: "GET", url: `${prefix}/`, headers: html }))
  })

  it("answers a deep link with the same page", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `${prefix}/accounts`,
      headers: html,
    })
    expectPortalPage(response)
  })

  // The build leaves a brotli copy of the page beside it. Sent in place of
  // the page the server writes, it would load the portal's files from the
  // root of the domain, which is another app.
  it("sends the page it wrote to a browser that takes brotli", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `${prefix}/`,
      headers: { ...html, "accept-encoding": "br, gzip" },
    })
    expect(response.headers["content-encoding"]).toBeUndefined()
    expectPortalPage(response)
  })

  it("serves the portal's files", async () => {
    const script = await ctx.app.inject({ method: "GET", url: `${prefix}/portal.js` })
    expect(script.statusCode).toBe(200)
    expect(script.headers["content-type"]).toContain("javascript")
    const styles = await ctx.app.inject({ method: "GET", url: `${prefix}/portal.css` })
    expect(styles.statusCode).toBe(200)
  })

  it("scopes the portal cookie to the path the browser sees, and takes it back there", async () => {
    const admin = await registerUser(ctx.app)
    const login = await ctx.app.inject({
      method: "POST",
      url: `${prefix}/api/v1/auth/portal/login`,
      payload: {
        email: admin.email,
        password: "correct-horse-battery",
        deviceId: "portal-browser",
      },
    })
    expect(login.statusCode).toBe(200)
    const cookie = String(login.headers["set-cookie"])
    expect(cookie).toContain("Path=/hearth/api/v1/auth/portal")

    const refresh = await ctx.app.inject({
      method: "POST",
      url: `${prefix}/api/v1/auth/portal/refresh`,
      headers: { cookie: cookie.split(";")[0]!, origin: ORIGIN, host: "lab.example.test" },
      payload: { deviceId: "portal-browser" },
    })
    expect(refresh.statusCode).toBe(200)
  })

  it("serves the API reference with its files under the path", async () => {
    const page = await ctx.app.inject({ method: "GET", url: `${prefix}/docs` })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('href="/hearth/docs/static/swagger-ui.css"')
    const styles = await ctx.app.inject({
      method: "GET",
      url: `${prefix}/docs/static/swagger-ui.css`,
    })
    expect(styles.statusCode).toBe(200)

    // "Try it out" puts /api/v1/... after this, so a slash on the end would double up.
    const spec = await ctx.app.inject({ method: "GET", url: `${prefix}/docs/json` })
    expect(spec.json()).toMatchObject({ servers: [{ url: `${ORIGIN}/hearth` }] })
  })

  it("opens the websocket", async () => {
    const user = await registerUser(ctx.app)
    const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => {
      on(event: "open" | "close", listener: () => void): void
      on(event: "error", listener: (error: Error) => void): void
      close(): void
    }
    const socket = new WebSocketImpl(
      `${socketOrigin}${prefix}/api/v1/ws?access_token=${user.accessToken}`,
    )
    socket.on("error", () => {})
    const opened = await new Promise<boolean>((resolve) => {
      socket.on("open", () => resolve(true))
      socket.on("close", () => resolve(false))
    })
    socket.close()
    expect(opened).toBe(true)
  })
})

it("answers exactly the path, with no slash after it, with the page", async () => {
  expectPortalPage(await ctx.app.inject({ method: "GET", url: "/hearth", headers: html }))
  expectPortalPage(await ctx.app.inject({ method: "GET", url: "/hearth?from=bookmark" }))
})

it("leaves a path that only begins with the same letters alone", async () => {
  const response = await ctx.app.inject({ method: "GET", url: "/hearthstone/api/v1/server-info" })
  expect(response.statusCode).toBe(404)
})

describe("the path Hearth is served under", () => {
  it("is the path of the public address, without a trailing slash", () => {
    expect(basePath("https://lab.example.com/hearth")).toBe("/hearth")
    expect(basePath("https://lab.example.com/hearth/")).toBe("/hearth")
    expect(basePath("https://lab.example.com/apps/hearth")).toBe("/apps/hearth")
    expect(basePath("https://hearth.example.com")).toBe("")
    expect(basePath("https://hearth.example.com/")).toBe("")
  })

  // Read as written, //hearth is an address on another host, which the page
  // would then name as its base.
  it("collapses a doubled slash rather than naming another host", () => {
    expect(basePath("https://lab.example.com//hearth")).toBe("/hearth")
    expect(basePath("https://lab.example.com/apps//hearth/")).toBe("/apps/hearth")
  })

  it("comes off a request that carries it, and only then", () => {
    expect(stripBasePath("/hearth", "/hearth")).toBe("/")
    expect(stripBasePath("/hearth/", "/hearth")).toBe("/")
    expect(stripBasePath("/hearth?x=1", "/hearth")).toBe("/?x=1")
    expect(stripBasePath("/hearth/api/v1/server-info", "/hearth")).toBe("/api/v1/server-info")
    expect(stripBasePath("/api/v1/server-info", "/hearth")).toBe("/api/v1/server-info")
    expect(stripBasePath("/hearthstone", "/hearth")).toBe("/hearthstone")
    expect(stripBasePath("/accounts", "")).toBe("/accounts")
  })

  // A proxy that strips /api hands on /api/v1/..., which is already an API
  // path. Taking /api off that as well would leave the phones nothing to reach.
  it("stays on an API path when the path is /api", () => {
    expect(stripBasePath("/api/v1/server-info", "/api")).toBe("/api/v1/server-info")
    expect(stripBasePath("/api/api/v1/server-info", "/api")).toBe("/api/v1/server-info")
    expect(stripBasePath("/api/accounts", "/api")).toBe("/accounts")
  })
})
