import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createCircle, registerUser, startTestApp, type TestContext } from "../helpers"

let ctx: TestContext

async function page(code: string) {
  const response = await ctx.app.inject({ method: "GET", url: `/join/${code}` })
  expect(response.statusCode).toBe(200)
  return response.body
}

describe("invite links at a path", () => {
  beforeAll(async () => {
    ctx = await startTestApp({ PUBLIC_URL: "https://lab.example.com/hearth" })
  })

  afterAll(async () => {
    await ctx.close()
  })

  beforeEach(async () => {
    await ctx.reset()
  })

  it("hands out a link at the server's own address", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)
    const invites = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/invites`,
      headers: owner.headers,
    })
    expect(invites.json()[0].url).toBe(`https://lab.example.com/hearth/join/${circle.invite.code}`)
  })

  // An app that has never been told a server has nowhere to look the code up.
  it("opens the app with the server address and the code", async () => {
    const body = await page("ab12cd34")
    const deepLink = `hearth://join/AB12CD34?server=${encodeURIComponent("https://lab.example.com/hearth")}`
    expect(body).toContain(`href="${deepLink}"`)
  })

  it("tells somebody without the app what to do", async () => {
    const body = await page("AB12CD34")
    expect(body).toContain("Install Hearth")
    expect(body).toContain("https://lab.example.com/hearth")
    expect(body).toContain("AB12CD34")
    // No store listing is configured, so the page must not invent one.
    expect(body).not.toMatch(/apps\.apple\.com|play\.google\.com/)
    expect(body).toContain("Ask whoever invited you")
  })

  // Without the app, a scheme the phone does not know is an error dialog
  // before the steps can be read.
  it("does not try to open the app on its own", async () => {
    expect(await page("AB12CD34")).not.toContain("location.href")
  })

  it("keeps a code that is not one out of the page", async () => {
    const body = await page("ab12<script>")
    expect(body).not.toContain("<script>")
    expect(body).toContain("AB12SCRIPT")
  })
})

describe("the join page with install links", () => {
  beforeAll(async () => {
    ctx = await startTestApp({
      PUBLIC_URL: "https://hearth.example.com",
      IOS_APP_URL: "https://testflight.apple.com/join/abc",
      ANDROID_APP_URL: "https://hearth.example.com/files/hearth.apk?v=1&x=<2>",
    })
  })

  afterAll(async () => {
    await ctx.close()
  })

  it("links to where the operator says the app is", async () => {
    const body = await page("AB12CD34")
    expect(body).toContain('href="https://testflight.apple.com/join/abc"')
    expect(body).toContain('href="https://hearth.example.com/files/hearth.apk?v=1&amp;x=&lt;2&gt;"')
    expect(body).not.toContain("Ask whoever invited you")
  })
})
