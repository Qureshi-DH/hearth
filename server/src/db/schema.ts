import type {
  ActivityType,
  CircleRole,
  EventType,
  LocationSource,
  Platform,
  PlaceIcon,
  PushProvider,
  SharingState,
} from "@hearth/shared"
import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * Conventions
 * -----------
 * - Every timestamp is `timestamptz`. The server works exclusively in UTC.
 * - String unions are stored as `text` rather than PG enums, so adding a new
 *   event type is a code change rather than a migration and a lock.
 * - Deleting a user or circle cascades. Self-hosters expect "delete" to mean it.
 * - Foreign keys that cascade or null on delete carry a single-column index no
 *   query here reads. It is there for the referential action itself, which
 *   otherwise scans the whole referencing table every time a parent row goes.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** Lower-cased and trimmed copy of `email`. Every lookup goes through it. */
    emailNormalized: text("email_normalized").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    avatarColor: text("avatar_color").notNull(),
    avatarUrl: text("avatar_url"),
    locale: text("locale"),
    units: text("units").$type<"metric" | "imperial">().notNull().default("metric"),
    isAdmin: boolean("is_admin").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("users_email_normalized_key").on(table.emailNormalized)],
)

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the refresh token. The plaintext never touches the database. */
    refreshTokenHash: text("refresh_token_hash").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name"),
    platform: text("platform").$type<Platform>(),
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    pushProvider: text("push_provider").$type<PushProvider>(),
    pushToken: text("push_token"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sessions_refresh_token_hash_key").on(table.refreshTokenHash),
    index("sessions_user_idx").on(table.userId),
    uniqueIndex("sessions_user_device_key").on(table.userId, table.deviceId),
  ],
)

export interface CircleSettingsJson {
  historyRetentionDays: number
  minUpdateIntervalSeconds: number
  distanceFilterMeters: number
  lowBatteryThreshold: number
  allowSharingPause: boolean
  allowHistory: boolean
  /** 0 disables the alert. */
  speedAlertKmh: number
  /** Watch for a hard stop from driving speed and raise a "possible incident". */
  incidentDetection: boolean
}

export const circles = pgTable(
  "circles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    emoji: text("emoji"),
    color: text("color"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    settings: jsonb("settings").$type<CircleSettingsJson>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("circles_created_by_idx").on(table.createdBy)],
)

export interface MemberNotificationPrefsJson {
  muted: EventType[]
  mutedUntil: string | null
}

export const circleMembers = pgTable(
  "circle_members",
  {
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<CircleRole>().notNull().default("member"),
    nickname: text("nickname"),
    sharingState: text("sharing_state").$type<SharingState>().notNull().default("precise"),
    /** When sharingState is "paused", sharing auto-resumes at this time. */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /**
     * What to restore when a pause ends. Without it a pause always resumed to
     * "precise", so someone who was deliberately sharing an approximate
     * location was silently upgraded to an exact one by waiting.
     */
    resumeToState: text("resume_to_state").$type<SharingState>(),
    notifications: jsonb("notifications")
      .$type<MemberNotificationPrefsJson>()
      .notNull()
      .default(sql`'{"muted":[],"mutedUntil":null}'::jsonb`),
    /** Watermark for the unread badge on the activity feed. */
    feedReadAt: timestamp("feed_read_at", { withTimezone: true }),
    joinedAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.circleId, table.userId] }),
    index("circle_members_user_idx").on(table.userId),
  ],
)

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    role: text("role").$type<CircleRole>().notNull().default("member"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("invites_code_key").on(table.code),
    index("invites_circle_idx").on(table.circleId),
  ],
)

/**
 * One row per accepted fix, pruned by the retention job.
 *
 * A user has a single location stream and circles control who may read it.
 * That mirrors how people think about it. You share your location, not your
 * location with circle A and, separately, with circle B.
 */
export const locationPoints = pgTable(
  "location_points",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    accuracyMeters: real("accuracy_meters"),
    altitudeMeters: real("altitude_meters"),
    altitudeAccuracyMeters: real("altitude_accuracy_meters"),
    speedMps: real("speed_mps"),
    headingDegrees: real("heading_degrees"),
    activity: text("activity").$type<ActivityType>(),
    batteryLevel: real("battery_level"),
    isCharging: boolean("is_charging"),
    isMoving: boolean("is_moving"),
    source: text("source").$type<LocationSource>().notNull().default("background"),
    tripId: uuid("trip_id"),
  },
  (table) => [
    index("location_points_user_recorded_idx").on(table.userId, table.recordedAt.desc()),
    index("location_points_trip_idx").on(table.tripId),
    // Devices retry batches after a flaky upload. Dedupe rather than double-count.
    uniqueIndex("location_points_dedupe_key").on(table.userId, table.deviceId, table.recordedAt),
  ],
)

/** Denormalised "where is everyone right now", so the map view is one cheap read. */
export const userPresence = pgTable("user_presence", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastPointId: bigint("last_point_id", { mode: "number" }),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  accuracyMeters: real("accuracy_meters"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }),
  speedMps: real("speed_mps"),
  headingDegrees: real("heading_degrees"),
  activity: text("activity").$type<ActivityType>(),
  batteryLevel: real("battery_level"),
  isCharging: boolean("is_charging"),
  /** Set when a low-battery event has already fired, cleared once charged again. */
  lowBatteryNotifiedAt: timestamp("low_battery_notified_at", { withTimezone: true }),
  /** Cooldown marker so a long motorway drive raises one alert, not fifty. */
  speedAlertedAt: timestamp("speed_alerted_at", { withTimezone: true }),
  /** Consecutive over-threshold fixes, so a single GPS spike cannot alert. */
  overSpeedCount: integer("over_speed_count").notNull().default(0),
  incidentFlaggedAt: timestamp("incident_flagged_at", { withTimezone: true }),
  offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
  /** Watermark for the trip detector, so it never re-scans old breadcrumbs. */
  tripsProcessedUntil: timestamp("trips_processed_until", { withTimezone: true }),
  updatedAt: updatedAt(),
})

export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon").$type<PlaceIcon>(),
    color: text("color"),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    radiusMeters: integer("radius_meters").notNull(),
    address: text("address"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("places_circle_idx").on(table.circleId)],
)

/** Current inside/outside state per (place, user), the input to hysteresis. */
export const placeMemberships = pgTable(
  "place_memberships",
  {
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isInside: boolean("is_inside").notNull().default(false),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.placeId, table.userId] }),
    index("place_memberships_user_idx").on(table.userId),
  ],
)

export const placeEvents = pgTable(
  "place_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"arrive" | "leave">().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    pointId: bigint("point_id", { mode: "number" }),
  },
  (table) => [
    index("place_events_circle_occurred_idx").on(table.circleId, table.occurredAt.desc()),
    index("place_events_place_idx").on(table.placeId, table.occurredAt.desc()),
    index("place_events_user_idx").on(table.userId),
  ],
)

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").$type<EventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    summary: text("summary").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_circle_occurred_idx").on(table.circleId, table.occurredAt.desc()),
    index("events_actor_idx").on(table.actorUserId),
  ],
)

export const sosAlerts = pgTable(
  "sos_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("sos_alerts_circle_idx").on(table.circleId, table.startedAt.desc()),
    index("sos_alerts_user_active_idx").on(table.userId, table.resolvedAt),
  ],
)

export const checkIns = pgTable(
  "check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    note: text("note"),
    placeId: uuid("place_id").references(() => places.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("check_ins_circle_idx").on(table.circleId, table.createdAt.desc()),
    index("check_ins_user_idx").on(table.userId),
    index("check_ins_place_idx").on(table.placeId),
  ],
)

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    distanceMeters: doublePrecision("distance_meters").notNull(),
    maxSpeedMps: real("max_speed_mps"),
    avgSpeedMps: real("avg_speed_mps"),
    pointCount: integer("point_count").notNull(),
    startLat: doublePrecision("start_lat").notNull(),
    startLon: doublePrecision("start_lon").notNull(),
    endLat: doublePrecision("end_lat").notNull(),
    endLon: doublePrecision("end_lon").notNull(),
    startPlaceId: uuid("start_place_id").references(() => places.id, { onDelete: "set null" }),
    endPlaceId: uuid("end_place_id").references(() => places.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("trips_user_started_idx").on(table.userId, table.startedAt.desc()),
    index("trips_start_place_idx").on(table.startPlaceId),
    index("trips_end_place_idx").on(table.endPlaceId),
  ],
)

/**
 * Notifications are written here inside the same transaction as the event that
 * caused them, then drained by a background worker. A push provider that is
 * down, or not configured at all, can never fail a user-facing request.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    circleId: uuid("circle_id").references(() => circles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    channel: text("channel").$type<"default" | "alerts" | "sos">().notNull().default("default"),
    priority: text("priority").$type<"normal" | "high">().notNull().default("normal"),
    status: text("status")
      .$type<"pending" | "sending" | "sent" | "failed" | "skipped">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("notification_outbox_pending_idx").on(table.status, table.nextAttemptAt),
    index("notification_outbox_user_idx").on(table.userId),
    index("notification_outbox_session_idx").on(table.sessionId),
  ],
)

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_log_created_idx").on(table.createdAt.desc()),
    index("audit_log_actor_idx").on(table.actorUserId),
  ],
)

/** Settings an admin can change at runtime, without a restart. */
export const serverSettings = pgTable("server_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type Circle = typeof circles.$inferSelect
export type CircleMember = typeof circleMembers.$inferSelect
export type Invite = typeof invites.$inferSelect
export type LocationPoint = typeof locationPoints.$inferSelect
export type NewLocationPoint = typeof locationPoints.$inferInsert
export type Presence = typeof userPresence.$inferSelect
export type Place = typeof places.$inferSelect
export type PlaceEvent = typeof placeEvents.$inferSelect
export type FeedEventRow = typeof events.$inferSelect
export type SosAlertRow = typeof sosAlerts.$inferSelect
export type TripRow = typeof trips.$inferSelect
export type OutboxRow = typeof notificationOutbox.$inferSelect
