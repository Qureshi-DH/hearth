import type { MemberPresence, SessionSummary } from "@hearth/shared"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  createCircle,
  joinCircle,
  registerUser,
  startTestApp,
  uploadFixes,
  type Fix,
  type TestContext,
} from "../helpers"

/**
 * Somebody with a phone and a tablet has one dot. It follows the device that
 * is going somewhere, and the tablet left on the kitchen table saying every
 * quarter hour that it is still there does not pull the dot back home.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const ROAD = { lat: 51.4712, lon: -2.5601 }
const FURTHER = { lat: 51.4801, lon: -2.5502 }

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

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

async function signInTablet(email: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId: "kitchen-tablet", deviceName: "Kitchen tablet", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
}

async function household() {
  const viewer = await registerUser(ctx.app)
  const member = await registerUser(ctx.app, { deviceId: "pocket-phone" })
  const circle = await createCircle(ctx.app, viewer.headers)
  await joinCircle(ctx.app, member.headers, circle.invite.code)
  const tablet = await signInTablet(member.email)
  const seen = async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/locations`,
      headers: viewer.headers,
    })
    expect(response.statusCode).toBe(200)
    return (response.json() as MemberPresence[]).find((entry) => entry.userId === member.user.id)!
  }
  return { viewer, member, tablet, circle, seen }
}

const driving = (at: { lat: number; lon: number }, ago: number, battery = 0.8): Fix =>
  ({
    ...at,
    recordedAt: secondsAgo(ago),
    accuracyMeters: 8,
    speedMps: 14,
    batteryLevel: battery,
    activity: "driving",
  }) as Fix

const parked = (ago: number, battery = 0.05): Fix =>
  ({
    ...HOME,
    recordedAt: secondsAgo(ago),
    accuracyMeters: 20,
    speedMps: 0,
    batteryLevel: battery,
    activity: "still",
    source: "heartbeat",
  }) as Fix

describe("a person with two devices", () => {
  it("keeps following the phone on the road when the tablet at home says it is still there", async () => {
    const { member, tablet, seen } = await household()
    await uploadFixes(ctx.app, member.headers, [driving(ROAD, 20)])

    await uploadFixes(ctx.app, tablet, [parked(0)])

    const dot = await seen()
    expect(dot).toMatchObject({ lat: ROAD.lat, lon: ROAD.lon, activity: "driving" })
    // The tablet's flat battery is not the phone's.
    expect(dot.batteryLevel).toBe(0.8)
  })

  it("moves with the phone again on its next fix", async () => {
    const { member, tablet, seen } = await household()
    await uploadFixes(ctx.app, member.headers, [driving(ROAD, 40)])
    await uploadFixes(ctx.app, tablet, [parked(20)])
    await uploadFixes(ctx.app, member.headers, [driving(FURTHER, 0)])
    expect(await seen()).toMatchObject({ lat: FURTHER.lat, lon: FURTHER.lon })
  })

  it("follows the tablet once it is the one going somewhere", async () => {
    const { member, tablet, seen } = await household()
    await uploadFixes(ctx.app, member.headers, [parked(60, 0.7)])
    await uploadFixes(ctx.app, tablet, [driving(FURTHER, 0, 0.5)])
    expect(await seen()).toMatchObject({ lat: FURTHER.lat, lon: FURTHER.lon, batteryLevel: 0.5 })
  })

  it("lets the tablet's word stand once the phone has gone quiet", async () => {
    const { member, tablet, seen } = await household()
    // Twenty minutes since the phone's last fix on the road, which is stale on the map.
    await uploadFixes(ctx.app, member.headers, [driving(ROAD, 20 * 60)])
    await uploadFixes(ctx.app, tablet, [parked(0, 0.6)])
    expect(await seen()).toMatchObject({ lat: HOME.lat, lon: HOME.lon, activity: "still" })
  })

  it("names the device the map is following in the list of devices", async () => {
    const { member, tablet } = await household()
    await uploadFixes(ctx.app, member.headers, [driving(ROAD, 20)])
    await uploadFixes(ctx.app, tablet, [parked(0)])

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: member.headers,
    })
    expect(response.statusCode).toBe(200)
    const devices = response.json() as SessionSummary[]
    const byName = new Map(devices.map((device) => [device.deviceName, device]))
    expect(byName.get("Test Phone")?.onMap).toBe(true)
    expect(byName.get("Kitchen tablet")?.onMap).toBe(false)
  })
})
