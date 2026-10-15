import { readFileSync } from "node:fs"
import { parseEnv } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { loadConfig, resetConfig } from "../env"

afterEach(() => resetConfig())

describe("configuration", () => {
  it("boots from .env.example with only the documented values filled in", () => {
    const example = parseEnv(
      readFileSync(new URL("../../../.env.example", import.meta.url), "utf8"),
    )
    const config = loadConfig({
      ...example,
      DATABASE_URL: "postgres://hearth:secret@localhost:5432/hearth",
      JWT_SECRET: "a".repeat(48),
      ADMIN_EMAIL: "you@example.com",
      ADMIN_PASSWORD: "a-long-passphrase",
    })
    expect(config.ADMIN_NAME).toBeUndefined()
    expect(config.CORS_ORIGINS).toBeUndefined()
  })

  // Behind a proxy that strips the path, a request for one of these arrives
  // already stripped and would have the path taken off a second time. The
  // invite page under /join would open the portal instead.
  it("refuses a public address under a path Hearth serves itself", () => {
    for (const path of ["/join", "/docs", "/healthz", "/readyz", "/api/v1", "/join/family"]) {
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgres://localhost/hearth",
          PUBLIC_URL: `https://lab.example.com${path}`,
        }),
      ).toThrow(/PUBLIC_URL/)
      resetConfig()
    }
  })

  it("takes a public address under a path of its own", () => {
    for (const path of ["/hearth", "/apps/hearth", "/api", "/joiner", ""]) {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/hearth",
        PUBLIC_URL: `https://lab.example.com${path}`,
      })
      expect(config.PUBLIC_URL).toBe(`https://lab.example.com${path}`)
      resetConfig()
    }
  })

  it("reads an empty value as unset rather than as an empty string", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/hearth", ADMIN_NAME: "" })
    expect(config.ADMIN_NAME).toBeUndefined()
  })
})
