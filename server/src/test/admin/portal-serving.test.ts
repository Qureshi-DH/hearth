import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliCompressSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startTestApp, type TestContext } from "../helpers"

/**
 * The admin portal is served at the server's own address. A stand-in build
 * directory keeps this independent of whether the real one has been built.
 */

const built = mkdtempSync(join(tmpdir(), "hearth-portal-"))
mkdirSync(join(built, "assets"))
writeFileSync(
  join(built, "index.html"),
  "<!doctype html><title>Hearth admin</title><div id=root></div>",
)
writeFileSync(
  join(built, "index.html.br"),
  brotliCompressSync("<!doctype html><title>Hearth admin</title><div id=root></div>"),
)
writeFileSync(join(built, "assets", "portal-abc123.js"), "console.log('portal')")

let ctx: TestContext

beforeAll(async () => {
  process.env.ADMIN_PORTAL_DIR = built
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
  delete process.env.ADMIN_PORTAL_DIR
})

describe("the admin portal at the server's address", () => {
  it("serves the page, with a policy that allows nothing from anywhere else", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/html")
    expect(response.body).toContain("Hearth admin")
    const policy = String(response.headers["content-security-policy"])
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(response.headers["cache-control"]).toContain("no-cache")
  })

  // The build leaves a compressed copy beside the page, and the copy is what a
  // browser gets. It must carry the same policy.
  it("keeps the policy on the compressed copy of the page", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/",
      headers: { "accept-encoding": "br" },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-encoding"]).toBe("br")
    expect(String(response.headers["content-security-policy"])).toContain("default-src 'self'")
  })

  it("serves its scripts", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/assets/portal-abc123.js" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("javascript")
  })

  it("answers a deep link in a browser with the page", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/accounts",
      headers: { accept: "text/html,application/xhtml+xml" },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain("Hearth admin")
    expect(String(response.headers["content-security-policy"])).toContain("default-src 'self'")
  })

  it("leaves the API, the probes and the invite page as they were", async () => {
    const api = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/no-such-route",
      headers: { accept: "text/html" },
    })
    expect(api.statusCode).toBe(404)
    expect(api.headers["content-type"]).toContain("application/json")

    expect((await ctx.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200)
    const join = await ctx.app.inject({ method: "GET", url: "/join/ABCD1234" })
    expect(join.body).toContain("Join a circle")
  })

  it("does not answer a missing file with the page", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/assets/missing.js" })
    expect(response.statusCode).toBe(404)
  })
})
