import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"

import { startTestApp, type TestContext } from "../helpers"

// An operator who wants no sign-in page on the public address turns it off,
// and a built portal sitting on disk changes nothing.
const built = mkdtempSync(join(tmpdir(), "hearth-portal-"))
writeFileSync(join(built, "index.html"), "<!doctype html><title>Hearth admin</title>")

let ctx: TestContext

beforeAll(async () => {
  process.env.ADMIN_PORTAL_DIR = built
  process.env.ENABLE_ADMIN_PORTAL = "false"
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
  delete process.env.ADMIN_PORTAL_DIR
  delete process.env.ENABLE_ADMIN_PORTAL
})

it("serves nothing at the address when the portal is off", async () => {
  const root = await ctx.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } })
  expect(root.statusCode).toBe(404)
  const deep = await ctx.app.inject({
    method: "GET",
    url: "/accounts",
    headers: { accept: "text/html" },
  })
  expect(deep.statusCode).toBe(404)
})
