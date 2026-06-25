import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * An unresolved SOS stops handing a circle the live position of somebody who
 * has since left it.
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

/** A school and a hospital, both real places in Bristol, ~3.1 km apart. */
const SCHOOL = { lat: 51.4636, lon: -2.5952 }
const HOSPITAL = { lat: 51.4784, lon: -2.5586 }

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

async function createCircle(headers: Record<string, string>, name = "Family") {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number
    batteryLevel?: number
  }>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number }
}

interface SosRow {
  id: string
  user: { id: string }
  resolvedAt: string | null
  lastLat: number | null
  lastLon: number | null
  lastFixAt: string | null
}

async function activeSos(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=true`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as SosRow[]
}

describe("sos", () => {
  it("stops sharing an alert's live position with a circle the member has left", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    const joined = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: bob.headers,
    })
    expect(joined.statusCode).toBe(200)

    // Bob is at the school, phone reporting an ordinary urban fix.
    await uploadFixes(bob.headers, [
      { ...SCHOOL, recordedAt: iso(-120), accuracyMeters: 9, batteryLevel: 0.62 },
    ])

    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: bob.headers,
      payload: { note: "Someone is following me" },
    })
    expect(raised.statusCode).toBe(201)

    // He leaves the circle himself. The alert is never resolved.
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${bob.user.id}`,
      headers: bob.headers,
    })
    expect(left.statusCode).toBe(200)

    // His phone keeps working and uploads a later fix from 3 km away.
    await uploadFixes(bob.headers, [
      { ...HOSPITAL, recordedAt: iso(-30), accuracyMeters: 14, batteryLevel: 0.58 },
    ])

    // The map's own endpoint no longer knows him at all.
    const locations = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/locations`,
        headers: alice.headers,
      })
    ).json() as Array<{ userId: string }>
    expect(locations.map((row) => row.userId)).not.toContain(bob.user.id)

    // Bob cannot switch the alert off himself any more: resolving needs
    // membership, so the only people who can end it are the ones watching.
    const bobCannotResolve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${raised.json().id}/resolve`,
      headers: bob.headers,
    })
    expect(bobCannotResolve.statusCode).toBe(403)

    // The SOS list is what the map polls while an alert is lit.
    const rows = await activeSos(alice.headers, circle.id)
    const bobRow = rows.find((row) => row.user.id === bob.user.id)

    // The alert itself is the circle's own record and may stay in the list.
    // Its live coordinates are Bob's, and Bob is not in this circle.
    expect(bobRow).toBeDefined()
    expect(bobRow?.lastLat ?? null).toBeNull()
    expect(bobRow?.lastLon ?? null).toBeNull()
  })

  it("does not serve a former member's position on the plain history list either", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: bob.headers,
    })

    await uploadFixes(bob.headers, [
      { ...SCHOOL, recordedAt: iso(-300), accuracyMeters: 11, batteryLevel: 0.44 },
    ])
    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: bob.headers,
      payload: {},
    })
    expect(raised.statusCode).toBe(201)

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${bob.user.id}`,
      headers: bob.headers,
    })
    expect(left.statusCode).toBe(200)

    await uploadFixes(bob.headers, [
      { ...HOSPITAL, recordedAt: iso(-20), accuracyMeters: 14, batteryLevel: 0.41 },
    ])

    const history = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/sos`,
        headers: alice.headers,
      })
    ).json() as SosRow[]
    const bobRow = history.find((row) => row.user.id === bob.user.id)
    expect(bobRow?.lastLat ?? null).toBeNull()
    expect(bobRow?.lastLon ?? null).toBeNull()
  })
})
