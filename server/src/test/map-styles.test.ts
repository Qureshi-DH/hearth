import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { loadConfig, resetConfig } from "../env"
import { startTestApp, type TestContext } from "./helpers"

const OPENFREEMAP = "https://tiles.openfreemap.org/styles"

const base = { DATABASE_URL: "postgres://localhost/hearth" }

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
  MAP_STYLE_URL: "",
  MAP_STYLE_URL_DARK: "",
  MAP_STYLES: "",
} as NodeJS.ProcessEnv

const ownStyles = [
  { id: "streets", name: "Streets", url: "https://maps.example.com/streets.json", scheme: "light" },
  { id: "night", name: "Night", url: "https://maps.example.com/night.json", scheme: "dark" },
  { id: "pale", name: "Pale", url: "https://maps.example.com/pale.json", scheme: "light" },
]

describe("map style configuration", () => {
  afterEach(() => resetConfig())

  it("offers OpenFreeMap's own variants when nothing about maps is configured", () => {
    const config = loadConfig(base)

    expect(config.mapStyles).toEqual([
      { id: "liberty", name: "Liberty", url: `${OPENFREEMAP}/liberty`, scheme: "light" },
      { id: "bright", name: "Bright", url: `${OPENFREEMAP}/bright`, scheme: "light" },
      { id: "positron", name: "Positron", url: `${OPENFREEMAP}/positron`, scheme: "light" },
      { id: "dark", name: "Dark", url: `${OPENFREEMAP}/dark`, scheme: "dark" },
      { id: "fiord", name: "Fiord", url: `${OPENFREEMAP}/fiord`, scheme: "dark" },
    ])
  })

  it("still offers the variants when the defaults are spelled out, as .env.example does", () => {
    const config = loadConfig({
      ...base,
      MAP_STYLE_URL: `${OPENFREEMAP}/liberty`,
      MAP_STYLE_URL_DARK: `${OPENFREEMAP}/dark`,
    })

    expect(config.mapStyles.map((style) => style.id)).toEqual([
      "liberty",
      "bright",
      "positron",
      "dark",
      "fiord",
    ])
  })

  it("publishes only the operator's two styles once either URL is their own", () => {
    // Someone hosting their own tiles must never find a third party's offered
    // beside them.
    const config = loadConfig({ ...base, MAP_STYLE_URL: "https://maps.example.com/style.json" })

    expect(config.mapStyles).toEqual([
      {
        id: "default-light",
        name: "Default",
        url: "https://maps.example.com/style.json",
        scheme: "light",
      },
      { id: "default-dark", name: "Default", url: `${OPENFREEMAP}/dark`, scheme: "dark" },
    ])
  })

  it("publishes MAP_STYLES as given", () => {
    const config = loadConfig({ ...base, MAP_STYLES: JSON.stringify(ownStyles) })

    expect(config.mapStyles).toEqual(ownStyles)
  })

  it("refuses MAP_STYLES that is not JSON, and says which setting", () => {
    expect(() => loadConfig({ ...base, MAP_STYLES: "liberty,dark" })).toThrow(/MAP_STYLES/)
  })

  it("refuses a style with an unknown scheme or no URL", () => {
    const badScheme = [{ id: "a", name: "A", url: "https://maps.example.com/a", scheme: "dusk" }]
    const noUrl = [{ id: "a", name: "A", scheme: "light" }]

    expect(() => loadConfig({ ...base, MAP_STYLES: JSON.stringify(badScheme) })).toThrow(
      /MAP_STYLES/,
    )
    expect(() => loadConfig({ ...base, MAP_STYLES: JSON.stringify(noUrl) })).toThrow(/MAP_STYLES/)
  })

  it("refuses a URL a phone could not load", () => {
    const relative = [{ id: "a", name: "A", url: "styles/a.json", scheme: "light" }]

    expect(() => loadConfig({ ...base, MAP_STYLES: JSON.stringify(relative) })).toThrow(
      /MAP_STYLES/,
    )
  })

  it("refuses two styles with one id, since phones remember a choice by id", () => {
    const twice = [
      { id: "a", name: "A", url: "https://maps.example.com/a", scheme: "light" },
      { id: "a", name: "A dark", url: "https://maps.example.com/b", scheme: "dark" },
    ]

    expect(() => loadConfig({ ...base, MAP_STYLES: JSON.stringify(twice) })).toThrow(
      /MAP_STYLES.*"a"/s,
    )
  })

  it("refuses an empty list", () => {
    expect(() => loadConfig({ ...base, MAP_STYLES: "[]" })).toThrow(/MAP_STYLES/)
  })
})

describe("map styles in server-info", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await startTestApp()
  })

  afterAll(async () => {
    await ctx.close()
  })

  afterEach(() => {
    loadConfig(testEnv)
  })

  async function serverInfo() {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/server-info" })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  it("lists the styles and keeps the old fields pointing at the defaults", async () => {
    loadConfig(testEnv)

    const body = await serverInfo()

    expect(body.mapStyles).toHaveLength(5)
    expect(body.mapStyleUrl).toBe(`${OPENFREEMAP}/liberty`)
    expect(body.mapStyleUrlDark).toBe(`${OPENFREEMAP}/dark`)
  })

  it("takes the first style of each scheme in MAP_STYLES as the default", async () => {
    loadConfig({ ...testEnv, MAP_STYLES: JSON.stringify(ownStyles) })

    const body = await serverInfo()

    expect(body.mapStyles).toEqual(ownStyles)
    expect(body.mapStyleUrl).toBe("https://maps.example.com/streets.json")
    expect(body.mapStyleUrlDark).toBe("https://maps.example.com/night.json")
  })

  it("draws dark mode with a light style rather than a third party's when MAP_STYLES has no dark one", async () => {
    const lightOnly = ownStyles.filter((style) => style.scheme === "light")
    loadConfig({ ...testEnv, MAP_STYLES: JSON.stringify(lightOnly) })

    const body = await serverInfo()

    expect(body.mapStyleUrl).toBe("https://maps.example.com/streets.json")
    expect(body.mapStyleUrlDark).toBe("https://maps.example.com/streets.json")
  })
})
