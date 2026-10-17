import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  createCircle,
  createPlace,
  joinCircle,
  registerUser,
  startTestApp,
  type TestContext,
} from "../helpers"

/**
 * Calls the app makes on its own while somebody simply uses it. A firewall in
 * front of a home server reads any 4xx as an attack and locks out every phone
 * behind the address, so none of these may answer one.
 */

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

async function family() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const tara = await registerUser(ctx.app, { displayName: "Tara" })
  const circle = await createCircle(ctx.app, alice.headers)
  await joinCircle(ctx.app, tara.headers, circle.invite.code)
  return { alice, tara, circle }
}

describe("asking a phone for a fix when a member's page opens", () => {
  it("answers that it cannot ask for somebody who has just left the circle", async () => {
    const { alice, tara, circle } = await family()
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}`,
      headers: tara.headers,
    })
    expect(left.statusCode).toBe(200)

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}/refresh`,
      headers: alice.headers,
    })
    expect({ status: response.statusCode, body: response.json() as unknown }).toEqual({
      status: 200,
      body: { asked: "unsupported" },
    })
  })
})

describe("the asks the map and a member's page make on every visit", () => {
  // Each one is cheap, because the server already holds each phone to one
  // ask per half minute or ten minutes. A parent going back and forth
  // between the map and the children's pages for ten minutes is not abuse.
  it("answers the map coming back into view every ten seconds for ten minutes", async () => {
    const { alice, circle } = await family()
    const statuses = new Set<number>()
    for (let i = 0; i < 60; i += 1) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/locations/refresh`,
        headers: alice.headers,
      })
      statuses.add(response.statusCode)
    }
    expect([...statuses]).toEqual([200])
  })

  it("answers a member's page opened every five seconds for ten minutes", async () => {
    const { alice, tara, circle } = await family()
    const statuses = new Set<number>()
    for (let i = 0; i < 120; i += 1) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/members/${tara.user.id}/refresh`,
        headers: alice.headers,
      })
      statuses.add(response.statusCode)
    }
    expect([...statuses]).toEqual([200])
  })
})

describe("previewing an invite", () => {
  // The join button is offered on a valid preview, and pressing it would be
  // refused with a 403 for somebody the circle removed.
  it("says somebody who was removed cannot use a code from before their removal", async () => {
    const { alice, tara, circle } = await family()
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}`,
      headers: alice.headers,
    })
    expect(removed.statusCode).toBe(200)

    const preview = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/invites/${circle.invite.code}`,
      headers: tara.headers,
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ valid: false, reason: "removed" })
  })

  it("lets them see a code made for them after the removal as valid", async () => {
    const { alice, tara, circle } = await family()
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}`,
      headers: alice.headers,
    })
    const fresh = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/invites`,
      headers: alice.headers,
      payload: {},
    })
    expect(fresh.statusCode).toBe(201)

    const preview = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/invites/${(fresh.json() as { code: string }).code}`,
      headers: tara.headers,
    })
    expect(preview.json()).toMatchObject({ valid: true })
  })
})

describe("a place somebody else has just deleted", () => {
  // The list on the other phone is minutes old, so its edit and delete
  // buttons still point at the place.
  async function deletedPlace() {
    const { alice, tara, circle } = await family()
    const place = await createPlace(ctx.app, alice.headers, circle.id, {
      name: "Home",
      lat: 51.4545,
      lon: -2.5879,
    })
    const gone = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/places/${place.id}`,
      headers: alice.headers,
    })
    expect(gone.statusCode).toBe(200)
    return { tara, circle, place }
  }

  it("answers a second delete as done, and says it was already gone", async () => {
    const { tara, circle, place } = await deletedPlace()
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/places/${place.id}`,
      headers: tara.headers,
    })
    expect({ status: response.statusCode, body: response.json() as unknown }).toEqual({
      status: 200,
      body: { ok: true, gone: true },
    })
  })

  it("answers an edit by saying the place is gone, and creates nothing", async () => {
    const { tara, circle, place } = await deletedPlace()
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/places/${place.id}`,
      headers: tara.headers,
      payload: { name: "Home sweet home" },
    })
    expect({ status: response.statusCode, body: response.json() as unknown }).toEqual({
      status: 200,
      body: { id: place.id, gone: true },
    })
    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: tara.headers,
    })
    expect(list.json()).toEqual([])
  })
})

describe("signing a device out from the admin portal", () => {
  // The device list is read once, and the phone may have signed out or in
  // again since, which gives it a new session.
  it("answers a device that is already signed out as done", async () => {
    const { alice, tara } = await family()
    const listed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${tara.user.id}/sessions`,
      headers: alice.headers,
    })
    expect(listed.statusCode).toBe(200)
    const [device] = listed.json() as Array<{ id: string }>
    const url = `/api/v1/admin/users/${tara.user.id}/sessions/${device!.id}`

    const first = await ctx.app.inject({ method: "DELETE", url, headers: alice.headers })
    const again = await ctx.app.inject({ method: "DELETE", url, headers: alice.headers })

    expect([first.statusCode, first.json()]).toEqual([200, { ok: true }])
    expect([again.statusCode, again.json()]).toEqual([200, { ok: true, alreadySignedOut: true }])
  })
})

describe("a wrong password when deleting the account", () => {
  // Said as a wrong password, so an app does not mistake it for a token that
  // ran out, renew, and ask again for a second 401.
  it("is a wrong password, not an expired session", async () => {
    const { alice } = await family()
    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/me",
      headers: alice.headers,
      payload: { password: "not-the-password" },
    })
    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: { code: string } }).error.code).toBe("wrong_password")
  })
})

describe("a picture on a server whose storage was switched off", () => {
  it("answers with the empty image a missing picture gets", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/media/avatars/${"ef".repeat(16)}.png`,
    })
    expect([response.statusCode, response.headers["x-hearth-media"]]).toEqual([200, "missing"])
  })
})
