/**
 * Demo data for local development.
 *
 *   pnpm seed            # adds the demo family (safe to re-run)
 *   pnpm seed --reset    # wipes every table first
 *
 * Creates a circle with four members walking real routes around Bristol, plus
 * places, breadcrumb history, trips and a populated feed, so the map has
 * something on it the moment you sign in.
 */
import { sql } from "drizzle-orm"

import { closeDb, getDb } from "./client"
import {
  circleMembers,
  circles,
  events,
  locationPoints,
  places,
  userPresence,
  users,
} from "./schema"
import { getConfig } from "../env"
import { avatarColorFor, normalizeEmail } from "../lib/ids"
import { hashPassword } from "../lib/password"
import { createInvite } from "../services/invites"
import { evaluateGeofenceBatch } from "../services/geofence"
import { detectTripsForUser } from "../services/trips"

const PASSWORD = "hearth-demo-passphrase"

const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }
const WORK = { lat: 51.4521, lon: -2.597 }

interface Member {
  email: string
  name: string
  role: "owner" | "admin" | "member"
  /** Waypoints walked over the last few hours, oldest first. */
  route: Array<{ lat: number; lon: number }>
  battery: number
  charging: boolean
}

const MEMBERS: Member[] = [
  {
    email: "amina@hearth.local",
    name: "Amina",
    role: "owner",
    route: [HOME, HOME, WORK, WORK],
    battery: 0.82,
    charging: true,
  },
  {
    email: "yusuf@hearth.local",
    name: "Yusuf",
    role: "admin",
    route: [HOME, { lat: 51.4589, lon: -2.5915 }, SCHOOL, SCHOOL],
    battery: 0.46,
    charging: false,
  },
  {
    email: "sami@hearth.local",
    name: "Sami",
    role: "member",
    route: [SCHOOL, SCHOOL, { lat: 51.4601, lon: -2.5901 }, HOME],
    battery: 0.12,
    charging: false,
  },
  {
    email: "layla@hearth.local",
    name: "Layla",
    role: "member",
    route: [HOME, HOME, HOME, HOME],
    battery: 0.67,
    charging: false,
  },
]

/**
 * A completed journey followed by a settled arrival.
 *
 * A gap longer than the trip detector's idle threshold separates the two, so
 * the journey closes into a real trip while the recent fixes keep everyone
 * live on the map rather than stale.
 */
function breadcrumbs(route: Member["route"], now: number) {
  const points: Array<{ lat: number; lon: number; at: Date; moving: boolean }> = []
  const legs = route.length - 1
  const perLeg = 12 // one fix per minute

  let minutesAgo = 180
  for (let leg = 0; leg < legs; leg += 1) {
    const from = route[leg]!
    const to = route[leg + 1]!
    for (let step = 0; step < perLeg; step += 1) {
      const t = step / perLeg
      points.push({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + (to.lon - from.lon) * t,
        at: new Date(now - minutesAgo * 60_000),
        moving: true,
      })
      minutesAgo -= 1
    }
  }

  const destination = route[route.length - 1]!
  for (const ago of [6, 4, 2, 0.5]) {
    points.push({ ...destination, at: new Date(now - ago * 60_000), moving: false })
  }

  return points
}

async function main() {
  const config = getConfig()
  if (config.isProduction) {
    throw new Error("Refusing to seed a production database.")
  }

  const db = getDb()
  const now = Date.now()

  if (process.argv.includes("--reset")) {
    await db.execute(sql`
      truncate table
        audit_log, notification_outbox, trips, check_ins, sos_alerts, events,
        place_events, place_memberships, places, user_presence, location_points,
        invites, circle_members, circles, sessions, server_settings, users
      restart identity cascade
    `)
    console.log("• database reset")
  }

  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.emailNormalized} = ${normalizeEmail(MEMBERS[0]!.email)}`)
  if ((existing?.count ?? 0) > 0) {
    console.log("• demo family already present; pass --reset to rebuild")
    await closeDb()
    return
  }

  const passwordHash = await hashPassword(PASSWORD)
  const created: Array<{ id: string; member: Member }> = []

  for (const member of MEMBERS) {
    const normalized = normalizeEmail(member.email)
    const [row] = await db
      .insert(users)
      .values({
        email: member.email,
        emailNormalized: normalized,
        passwordHash,
        displayName: member.name,
        avatarColor: avatarColorFor(normalized),
        // The owner doubles as the server admin so you can see the admin screen.
        isAdmin: member.role === "owner",
        lastSeenAt: new Date(),
      })
      .returning({ id: users.id })
    created.push({ id: row!.id, member })
  }

  const owner = created[0]!
  const [circle] = await db
    .insert(circles)
    .values({
      name: "The Khans",
      emoji: "🏠",
      createdBy: owner.id,
      settings: {
        historyRetentionDays: 30,
        minUpdateIntervalSeconds: 30,
        distanceFilterMeters: 60,
        lowBatteryThreshold: 0.15,
        allowSharingPause: true,
        allowHistory: true,
        // Bristol demo drive peaks around 5 km/h walking, so a 100 km/h alert
        // stays quiet unless you deliberately test it.
        speedAlertKmh: 100,
        incidentDetection: false,
      },
    })
    .returning()

  for (const { id, member } of created) {
    await db.insert(circleMembers).values({
      circleId: circle!.id,
      userId: id,
      role: member.role,
      feedReadAt: new Date(now - 60 * 60_000),
      // Layla demonstrates the approximate-sharing mode on the map.
      sharingState: member.name === "Layla" ? "approximate" : "precise",
    })
  }

  for (const place of [
    { name: "Home", icon: "home" as const, ...HOME, radiusMeters: 150 },
    { name: "School", icon: "school" as const, ...SCHOOL, radiusMeters: 200 },
    { name: "Work", icon: "work" as const, ...WORK, radiusMeters: 180 },
  ]) {
    await db.insert(places).values({
      circleId: circle!.id,
      name: place.name,
      icon: place.icon,
      lat: place.lat,
      lon: place.lon,
      radiusMeters: place.radiusMeters,
      createdBy: owner.id,
    })
  }

  for (const { id, member } of created) {
    const points = breadcrumbs(member.route, now)
    await db.insert(locationPoints).values(
      points.map((point, index) => ({
        userId: id,
        deviceId: `seed-${member.name.toLowerCase()}`,
        recordedAt: point.at,
        lat: point.lat,
        lon: point.lon,
        accuracyMeters: 8 + (index % 5),
        speedMps: point.moving ? 1.4 : 0,
        activity: point.moving ? ("walking" as const) : ("still" as const),
        batteryLevel: member.battery,
        isCharging: member.charging,
        source: "background" as const,
      })),
    )

    const last = points[points.length - 1]!
    await db.insert(userPresence).values({
      userId: id,
      lat: last.lat,
      lon: last.lon,
      accuracyMeters: 9,
      recordedAt: last.at,
      speedMps: 0,
      activity: "still",
      batteryLevel: member.battery,
      isCharging: member.charging,
    })

    // Replay the route so places, arrive/leave events and the feed are real.
    await evaluateGeofenceBatch(
      db,
      id,
      points.map((point) => ({
        lat: point.lat,
        lon: point.lon,
        accuracyMeters: 9,
        recordedAt: point.at,
      })),
      { visibleCircleIds: member.name === "Layla" ? [] : [circle!.id] },
    )
    await detectTripsForUser(db, id)
  }

  await db.insert(events).values({
    circleId: circle!.id,
    actorUserId: created[3]!.id,
    type: "check_in",
    payload: { note: "Home safe" },
    summary: "Layla checked in at Home",
    occurredAt: new Date(now - 25 * 60_000),
  })

  const invite = await createInvite(db, {
    circleId: circle!.id,
    createdBy: owner.id,
    expiresInHours: 24 * 30,
  })

  console.log(
    [
      "",
      "  Demo family seeded.",
      "",
      `  Circle:   ${circle!.name}  ·  invite code ${invite.code}`,
      `  Password: ${PASSWORD}   (same for every account)`,
      "",
      ...created.map(
        ({ member }) =>
          `  ${member.email.padEnd(24)} ${member.name.padEnd(7)} ${member.role}${member.name === "Layla" ? "  (shares approximate location)" : ""}`,
      ),
      "",
    ].join("\n"),
  )

  await closeDb()
}

main().catch(async (error: unknown) => {
  console.error("Seed failed:", error)
  await closeDb().catch(() => {})
  process.exit(1)
})
