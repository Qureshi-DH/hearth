#!/usr/bin/env node
/**
 * Seeds a demo family on a local Hearth server for store screenshots.
 *
 * Five people in San Francisco on a school day, told through real fixes so
 * the server derives everything the app shows the way it would for a real
 * family: arrivals and departures from the places, trips from the drives,
 * "at School since 8:05" from the geofences. Road geometry comes from OSRM
 * (routes/*.json), so every trail follows a street.
 *
 *   node store-assets/tools/seed-demo.mjs http://127.0.0.1:4100
 *
 * Then `drive-live.mjs` streams David's pickup drive while the Live page is
 * captured. Sarah is the account the simulator signs in as.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const BASE = `${(process.argv[2] ?? "http://127.0.0.1:4100").replace(/\/$/, "")}/api/v1`
export const PASSWORD = "hearth-demo-2026"

export const PLACES = {
  home: { name: "Home", icon: "home", lat: 37.7502, lon: -122.4337, radiusMeters: 120 },
  school: { name: "School", icon: "school", lat: 37.7563, lon: -122.4209, radiusMeters: 150 },
  work: { name: "Work", icon: "work", lat: 37.7825, lon: -122.3965, radiusMeters: 150 },
  grandma: { name: "Grandma's", icon: "friend", lat: 37.7599, lon: -122.4679, radiusMeters: 100 },
  gym: { name: "Gym", icon: "gym", lat: 37.7694, lon: -122.3905, radiusMeters: 100 },
}

const PEOPLE = [
  { key: "sarah", displayName: "Sarah", email: "sarah@hearth.demo" },
  { key: "david", displayName: "David", email: "david@hearth.demo" },
  { key: "maya", displayName: "Maya", email: "maya@hearth.demo" },
  { key: "leo", displayName: "Leo", email: "leo@hearth.demo" },
  { key: "rosa", displayName: "Grandma Rosa", email: "rosa@hearth.demo" },
]

async function call(method, path, token, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // Fastify refuses a JSON content type with no body, which is how an
      // invite acceptance looked.
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

export async function signIn(email) {
  const result = await call("POST", "/auth/login", null, {
    email,
    password: PASSWORD,
    device: { deviceId: `demo-${email}`, deviceName: "Demo phone", platform: "ios" },
  })
  return result.accessToken
}

async function account(person) {
  try {
    const result = await call("POST", "/auth/register", null, {
      email: person.email,
      password: PASSWORD,
      displayName: person.displayName,
      device: { deviceId: `demo-${person.email}`, deviceName: "Demo phone", platform: "ios" },
    })
    return { ...person, token: result.accessToken, id: result.user.id }
  } catch {
    const token = await signIn(person.email)
    const me = await call("GET", "/auth/me", token)
    return { ...person, token, id: me.id }
  }
}

async function avatar(person) {
  const form = new FormData()
  const bytes = readFileSync(join(here, "avatars", `${person.key}.png`))
  form.append("file", new Blob([bytes], { type: "image/png" }), `${person.key}.png`)
  await call("POST", "/auth/me/avatar", person.token, form)
}

const route = (name) =>
  JSON.parse(readFileSync(join(here, "routes", `${name}.json`), "utf8")).routes[0].geometry
    .coordinates

const R = 6_371_008.8
function metres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Positions along a route every `stepSeconds`, at a speed that eases up
 * from a standstill, holds a cruising pace with some variation, and eases
 * down to the kerb: a trail that reads like a drive rather than a ruler.
 */
export function travel(coordinates, { startMs, cruiseMps, stepSeconds, activity, battery }) {
  const legs = []
  let total = 0
  for (let i = 1; i < coordinates.length; i += 1) {
    const length = metres(coordinates[i - 1], coordinates[i])
    legs.push({ from: coordinates[i - 1], to: coordinates[i], start: total, length })
    total += length
  }
  const at = (distance) => {
    const leg = legs.find((l) => distance <= l.start + l.length) ?? legs[legs.length - 1]
    const t = leg.length > 0 ? Math.min(1, (distance - leg.start) / leg.length) : 0
    const lon = leg.from[0] + (leg.to[0] - leg.from[0]) * t
    const lat = leg.from[1] + (leg.to[1] - leg.from[1]) * t
    const heading = (Math.atan2(leg.to[0] - leg.from[0], leg.to[1] - leg.from[1]) * 180) / Math.PI
    return { lat, lon, heading: (heading + 360) % 360 }
  }
  const fixes = []
  let covered = 0
  let clock = startMs
  let step = 0
  while (covered < total) {
    const remaining = total - covered
    const ease = Math.min(1, covered / 120, remaining / 150)
    const wobble = 1 + 0.18 * Math.sin(step / 3.1) + 0.08 * Math.sin(step / 1.3)
    const speed = Math.max(1.5, cruiseMps * Math.max(0.25, ease) * wobble)
    const point = at(covered)
    fixes.push({
      recordedAt: new Date(clock).toISOString(),
      lat: point.lat,
      lon: point.lon,
      accuracyMeters: 5 + (step % 4),
      speedMps: speed,
      headingDegrees: point.heading,
      activity,
      batteryLevel: battery,
      isCharging: false,
      source: "background",
    })
    covered += speed * stepSeconds
    clock += stepSeconds * 1000
    step += 1
  }
  const end = at(total)
  fixes.push({
    recordedAt: new Date(clock).toISOString(),
    lat: end.lat,
    lon: end.lon,
    accuracyMeters: 6,
    speedMps: 0,
    activity: "still",
    batteryLevel: battery,
    isCharging: false,
    source: "significant",
  })
  return fixes
}

/** A parked phone's word every half hour from one spot, jittered a few metres. */
export function stay(place, { fromMs, toMs, battery, everyMinutes = 30 }) {
  const fixes = []
  for (let t = fromMs, i = 0; t <= toMs; t += everyMinutes * 60_000, i += 1) {
    fixes.push({
      recordedAt: new Date(t).toISOString(),
      lat: place.lat + Math.sin(i * 1.7) * 0.00006,
      lon: place.lon + Math.cos(i * 2.3) * 0.00006,
      accuracyMeters: 8 + (i % 5),
      speedMps: 0,
      activity: "still",
      batteryLevel: Math.max(0.05, battery - i * 0.004),
      isCharging: false,
      source: "background",
    })
  }
  return fixes
}

async function upload(person, fixes) {
  const sorted = [...fixes].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
  for (let i = 0; i < sorted.length; i += 200) {
    await call("POST", "/locations/batch", person.token, { points: sorted.slice(i, i + 200) })
  }
}

/** Today at hh:mm local time, in milliseconds. */
function today(hh, mm) {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return d.getTime()
}

async function main() {
  const people = {}
  for (const person of PEOPLE) people[person.key] = await account(person)
  for (const person of Object.values(people))
    await avatar(person).catch((e) => console.warn(e.message))

  const { sarah, david, maya, leo, rosa } = people
  let circle
  const mine = await call("GET", "/circles", sarah.token)
  circle = mine.find((c) => c.name === "Family")
  if (!circle) circle = await call("POST", "/circles", sarah.token, { name: "Family", emoji: "🏡" })
  const detail = await call("GET", `/circles/${circle.id}`, sarah.token)
  const code = circle.invite?.code ?? detail.invite?.code
  for (const person of [david, maya, leo, rosa]) {
    await call("POST", `/invites/${code}/accept`, person.token)
  }

  const existing = await call("GET", `/circles/${circle.id}/places`, sarah.token)
  for (const place of Object.values(PLACES)) {
    if (!existing.some((p) => p.name === place.name)) {
      await call("POST", `/circles/${circle.id}/places`, sarah.token, place)
    }
  }

  const now = Date.now()
  const yesterday = (ms) => ms - 24 * 60 * 60_000

  // David: yesterday's drive home and an evening at the gym, this morning's
  // commute, at work since. drive-live.mjs takes him to school from here.
  await upload(david, [
    ...stay(PLACES.work, {
      fromMs: yesterday(today(9, 0)),
      toMs: yesterday(today(17, 40)),
      battery: 0.9,
    }),
    ...travel(route("work_home"), {
      startMs: yesterday(today(17, 45)),
      cruiseMps: 11.5,
      stepSeconds: 8,
      activity: "driving",
      battery: 0.62,
    }),
    ...stay(PLACES.home, {
      fromMs: yesterday(today(18, 5)),
      toMs: yesterday(today(18, 50)),
      battery: 0.6,
    }),
    ...travel(route("home_gym"), {
      startMs: yesterday(today(19, 0)),
      cruiseMps: 12,
      stepSeconds: 8,
      activity: "driving",
      battery: 0.58,
    }),
    ...stay(PLACES.gym, {
      fromMs: yesterday(today(19, 15)),
      toMs: yesterday(today(20, 20)),
      battery: 0.55,
    }),
    ...stay(PLACES.home, {
      fromMs: yesterday(today(21, 0)),
      toMs: today(7, 50),
      battery: 1,
      everyMinutes: 60,
    }),
    ...travel(route("home_work"), {
      startMs: today(8, 0),
      cruiseMps: 12.5,
      stepSeconds: 8,
      activity: "driving",
      battery: 0.97,
    }),
    ...stay(PLACES.work, { fromMs: today(8, 20), toMs: now - 60_000, battery: 0.94 }),
  ])

  // Sarah: the same drive twenty minutes later. The simulator is her phone
  // from here on, parked at work.
  await upload(sarah, [
    ...stay(PLACES.home, {
      fromMs: yesterday(today(19, 0)),
      toMs: today(8, 15),
      battery: 1,
      everyMinutes: 60,
    }),
    ...travel(route("home_work"), {
      startMs: today(8, 22),
      cruiseMps: 11,
      stepSeconds: 8,
      activity: "driving",
      battery: 0.95,
    }),
    ...stay(PLACES.work, { fromMs: today(8, 42), toMs: now - 90_000, battery: 0.88 }),
  ])

  // Maya: walked to school, at school since.
  const walk = route("home_school")
  await upload(maya, [
    ...stay(PLACES.home, {
      fromMs: yesterday(today(16, 0)),
      toMs: today(7, 40),
      battery: 1,
      everyMinutes: 60,
    }),
    ...travel(walk, {
      startMs: today(7, 44),
      cruiseMps: 1.45,
      stepSeconds: 20,
      activity: "walking",
      battery: 0.92,
    }),
    ...stay(PLACES.school, { fromMs: today(8, 6), toMs: now - 45_000, battery: 0.71 }),
  ])

  // Leo: cycled to the park late morning. The park is not a place, so his
  // profile offers to save it.
  const park = { lat: 37.7596, lon: -122.4269 }
  await upload(leo, [
    ...stay(PLACES.home, {
      fromMs: yesterday(today(18, 0)),
      toMs: today(11, 10),
      battery: 0.8,
      everyMinutes: 60,
    }),
    ...travel(route("home_park"), {
      startMs: today(11, 14),
      cruiseMps: 4.6,
      stepSeconds: 12,
      activity: "cycling",
      battery: 0.44,
    }),
    ...stay(park, { fromMs: today(11, 24), toMs: now - 30_000, battery: 0.38 }),
  ])

  // Grandma: at home, charging.
  await upload(rosa, [
    ...stay(PLACES.grandma, {
      fromMs: yesterday(today(12, 0)),
      toMs: now - 120_000,
      battery: 0.86,
      everyMinutes: 45,
    }).map((fix) => ({ ...fix, isCharging: true })),
  ])

  // A check-in and a quick message, so the feed carries more than arrivals.
  await call("POST", `/circles/${circle.id}/check-in`, maya.token, {
    lat: PLACES.school.lat,
    lon: PLACES.school.lon,
    note: "Made it to school 👋",
  }).catch((e) => console.warn(e.message))
  await call("POST", `/circles/${circle.id}/nudge/${david.id}`, sarah.token, {
    quickKey: "drive_safe",
  }).catch((e) => console.warn(e.message))

  console.log(
    JSON.stringify({ circleId: circle.id, invite: code, sarah: sarah.email, password: PASSWORD }),
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
