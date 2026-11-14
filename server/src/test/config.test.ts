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

  it("takes its public address from the hosting platform when none is set", () => {
    const platforms: [Record<string, string>, string][] = [
      [{ RENDER_EXTERNAL_URL: "https://hearth-x1.onrender.com" }, "https://hearth-x1.onrender.com"],
      [
        { RAILWAY_PUBLIC_DOMAIN: "hearth-production.up.railway.app" },
        "https://hearth-production.up.railway.app",
      ],
      [{ FLY_APP_NAME: "hearth-family" }, "https://hearth-family.fly.dev"],
    ]
    for (const [platform, expected] of platforms) {
      const config = loadConfig({ DATABASE_URL: "postgres://localhost/hearth", ...platform })
      expect(config.PUBLIC_URL).toBe(expected)
      resetConfig()
    }
  })

  it("keeps a public address that was set over the platform's own", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/hearth",
      PUBLIC_URL: "https://hearth.example.com",
      RENDER_EXTERNAL_URL: "https://hearth-x1.onrender.com",
    })
    expect(config.PUBLIC_URL).toBe("https://hearth.example.com")
  })

  it("falls back to the platform's address when PUBLIC_URL is left empty", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/hearth",
      PUBLIC_URL: "",
      FLY_APP_NAME: "hearth-family",
    })
    expect(config.PUBLIC_URL).toBe("https://hearth-family.fly.dev")
  })

  it("reads an empty value as unset rather than as an empty string", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/hearth", ADMIN_NAME: "" })
    expect(config.ADMIN_NAME).toBeUndefined()
  })
})
