import type {
  ActivityType,
  CircleRole,
  DeviceHealth,
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

/** A refresh token a session rotated away from, kept to tell a retry from a theft. */
export interface SpentRefreshJson {
  /** SHA-256 of the spent token. */
  h: string
  /** When it was spent, as an ISO timestamp. */
  at: string
  /** Whether it has already been answered once as a retry. */
  retried: boolean
  /**
   * A live token a retry replaced. Its answer never reached the phone, so it
   * is refused when presented, but it is no evidence of a theft.
   */
  displaced?: boolean
}

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the refresh token. The plaintext never touches the database. */
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /**
     * The last few hashes this session rotated away from. A presented token
     * that matches one is either a phone retrying a response it never
     * received, or a stolen token being replayed, and those are told apart by
     * the device, how long ago it was spent, and whether it was retried once
     * already. Remembering more than one is what catches a thief who rotated
     * twice before the phone next refreshed.
     */
    spentRefresh: jsonb("spent_refresh").$type<SpentRefreshJson[]>().notNull().default([]),
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
    index("sessions_spent_refresh_idx").using("gin", table.spentRefresh),
    // One live session per device. Signing in again revokes the old row and
    // starts a new one, so nothing bound to the old session id survives it.
    uniqueIndex("sessions_user_device_live_key")
      .on(table.userId, table.deviceId)
      .where(sql`revoked_at is null`),
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
     * When the current stretch of precise sharing began, or null when the
     * member has shared precisely ever since joining. The phone keeps
     * uploading while paused or approximate, so history, trips and trip
     * announcements are bounded by this: switching back to precise must not
     * hand the circle the trail recorded while it was not allowed to see it.
     */
    preciseSince: timestamp("precise_since", { withTimezone: true }),
    /**
     * What to restore when a pause ends. Without it a pause always resumed to
     * "precise", so someone who was deliberately sharing an approximate
     * location was silently upgraded to an exact one by waiting.
     */
    resumeToState: text("resume_to_state").$type<SharingState>(),
    /**
     * Per-circle alert latches. The equivalents on user_presence are shared by
     * every circle the member belongs to, so the first circle to be told spent
     * the cooldown for all of them, and a circle whose own threshold was
     * stricter, or that was paused when the alert fired, was never told at all.
     */
    speedAlertedAt: timestamp("speed_alerted_at", { withTimezone: true }),
    lowBatteryNotifiedAt: timestamp("low_battery_notified_at", { withTimezone: true }),
    lowBatteryNotifiedLevel: real("low_battery_notified_level"),
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

/**
 * Somebody an owner or admin removed from a circle. An invite created before
 * the removal no longer admits them, so a link still sitting in the family
 * chat cannot bring them straight back. A new invite, made on purpose after
 * the removal, can.
 */
export const circleRemovals = pgTable(
  "circle_removals",
  {
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    removedAt: timestamp("removed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.circleId, table.userId] })],
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
  /** The level that latch fired at, so a circle with a lower threshold of its own can still be told. */
  lowBatteryNotifiedLevel: real("low_battery_notified_level"),
  /** Cooldown marker so a long motorway drive raises one alert, not fifty. */
  speedAlertedAt: timestamp("speed_alerted_at", { withTimezone: true }),
  /** Consecutive over-threshold fixes, so a single GPS spike cannot alert. */
  overSpeedCount: integer("over_speed_count").notNull().default(0),
  incidentFlaggedAt: timestamp("incident_flagged_at", { withTimezone: true }),
  offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
  /**
   * When the phone last uploaded anything at all, accepted or not. A fix can
   * be old, a duplicate or a replay and the phone that sent it is still
   * alive, so silence is measured from here as much as from recordedAt.
   */
  lastHeardAt: timestamp("last_heard_at", { withTimezone: true }),
  /** When a silent push last asked a quiet phone for a fix. */
  wakeRequestedAt: timestamp("wake_requested_at", { withTimezone: true }),
  /** Wakes sent since the phone was last heard. Two unanswered is the bar for "offline". */
  wakeCount: integer("wake_count").notNull().default(0),
  /**
   * Until when somebody has a page open on this member. The phone reads it
   * off its own upload reply, so a watch reaches a moving phone on its next
   * fix whether or not the silent push got through.
   */
  watchedUntil: timestamp("watched_until", { withTimezone: true }),
  /**
   * When the phone's control channel last said it was open. An ask goes
   * down the channel while this is fresh, and by push otherwise.
   */
  controlSeenAt: timestamp("control_seen_at", { withTimezone: true }),
  /**
   * When an ask first went down the channel without an upload or a heartbeat
   * since. A phone that took it answers within seconds, so one left standing
   * longer is a channel that died without a close.
   */
  controlAskedAt: timestamp("control_asked_at", { withTimezone: true }),
  /** The phone's own account of what stands between it and reporting, see PATCH /me/health. */
  health: jsonb("health").$type<DeviceHealth>(),
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
    /**
     * When the row appeared, which is not when it happened. A backlog uploaded
     * after an outage carries old occurredAt values and the feed orders by
     * those, but the unread badge counts what is new to the reader.
     */
    createdAt: createdAt(),
  },
  (table) => [
    index("events_circle_occurred_idx").on(table.circleId, table.occurredAt.desc()),
    index("events_circle_created_idx").on(table.circleId, table.createdAt.desc()),
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
    priority: text("priority").$type<"normal" | "high">().notNull().default("high"),
    /** No banner, no sound. Exists only to wake the app. */
    silent: boolean("silent").notNull().default(false),
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
