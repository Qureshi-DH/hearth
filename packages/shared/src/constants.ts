/**
 * Shared constants for the Hearth API contract.
 *
 * This package has no dependencies, so the Node server and the React Native
 * app can both consume it as raw TypeScript with no build step.
 */

export const API_PREFIX = "/api/v1"

/** Ordered least to most privileged. */
export const CIRCLE_ROLES = ["member", "admin", "owner"] as const
export type CircleRole = (typeof CIRCLE_ROLES)[number]

export const ROLE_RANK: Record<CircleRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
}

export function roleAtLeast(role: CircleRole, required: CircleRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required]
}

/**
 * "approximate" snaps coordinates to a COARSE_GRID_METERS grid. "paused"
 * shares nothing, optionally until a timestamp.
 */
export const SHARING_STATES = ["precise", "approximate", "paused"] as const
export type SharingState = (typeof SHARING_STATES)[number]

export const COARSE_GRID_METERS = 750

export const LOCATION_SOURCES = [
  "background",
  "foreground",
  "significant",
  "geofence",
  "manual",
  "sos",
  "nudge",
] as const
export type LocationSource = (typeof LOCATION_SOURCES)[number]

/** Best effort, from the OS or derived from speed. */
export const ACTIVITY_TYPES = [
  "unknown",
  "still",
  "walking",
  "running",
  "cycling",
  "driving",
] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export const PLATFORMS = ["ios", "android", "web", "other"] as const
export type Platform = (typeof PLATFORMS)[number]

/** See docs/PUSH-NOTIFICATIONS.md for the trade-offs of each. */
export const PUSH_PROVIDERS = ["none", "expo", "ntfy", "webpush"] as const
export type PushProvider = (typeof PUSH_PROVIDERS)[number]

export const EVENT_TYPES = [
  "member_joined",
  "member_left",
  "member_removed",
  "role_changed",
  "place_created",
  "place_updated",
  "place_deleted",
  "place_arrive",
  "place_leave",
  "check_in",
  "sos_started",
  "sos_resolved",
  "low_battery",
  "device_offline",
  "device_online",
  "sharing_paused",
  "sharing_resumed",
  "nudge_requested",
  "trip_completed",
  "speed_alert",
  "possible_incident",
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const MUTABLE_EVENT_TYPES = [
  "place_arrive",
  "place_leave",
  "check_in",
  "low_battery",
  "device_offline",
  "sharing_paused",
  "trip_completed",
  "speed_alert",
] as const satisfies readonly EventType[]

export type MutableEventType = (typeof MUTABLE_EVENT_TYPES)[number]

export const PLACE_ICONS = [
  "home",
  "work",
  "school",
  "gym",
  "store",
  "restaurant",
  "hospital",
  "park",
  "airport",
  "mosque",
  "church",
  "friend",
  "pin",
] as const
export type PlaceIcon = (typeof PLACE_ICONS)[number]

export const REGISTRATION_MODES = ["open", "invite", "closed"] as const
export type RegistrationMode = (typeof REGISTRATION_MODES)[number]

/**
 * A family tracker usually needs a short, urgent nudge rather than a
 * conversation, so these are one tap away and free text is the fallback.
 */
export const QUICK_MESSAGES = [
  { key: "slow_down", body: "Please slow down." },
  { key: "call_me", body: "Call me when you can." },
  { key: "on_my_way", body: "On my way." },
  { key: "where_are_you", body: "Where are you?" },
  { key: "arrived_safe", body: "Arrived safe." },
  { key: "drive_safe", body: "Drive safe." },
] as const
export type QuickMessageKey = (typeof QUICK_MESSAGES)[number]["key"]

/** Most of these are overridable per circle or via env. */
export const DEFAULTS = {
  historyRetentionDays: 30,
  minUpdateIntervalSeconds: 30,
  distanceFilterMeters: 60,
  staleAfterSeconds: 15 * 60,
  offlineAfterSeconds: 60 * 60,
  /** A fraction, not a percentage. */
  lowBatteryThreshold: 0.15,
  minPlaceRadiusMeters: 50,
  maxPlaceRadiusMeters: 5000,
  defaultPlaceRadiusMeters: 150,
  /**
   * Leaving requires clearing the radius plus this, or a phone resting on the
   * boundary emits arrive and leave forever.
   */
  geofenceExitBufferMeters: 40,
  geofenceMaxAccuracyMeters: 250,
  tripIdleGapSeconds: 5 * 60,
  tripMinDistanceMeters: 400,
  tripMinDurationSeconds: 120,
  sosPingIntervalSeconds: 20,
  maxLocationBatchSize: 200,
  maxMessageLength: 500,
  /** Off until a circle opts in. A motorway commute would alert every day. */
  defaultSpeedAlertKmh: 0,
  /** So one GPS spike cannot raise an alert. */
  speedAlertConsecutiveFixes: 2,
  speedAlertCooldownSeconds: 30 * 60,
  /**
   * Incident heuristic. Travelling at least incidentMinSpeedMps, then dropping
   * to incidentStoppedSpeedMps inside the deceleration window and staying put.
   */
  incidentMinSpeedMps: 9.7,
  incidentStoppedSpeedMps: 1,
  incidentDecelerationWindowSeconds: 90,
  incidentStillnessSeconds: 180,
} as const

/** Indexed by a hash of the user id, so reordering changes existing avatars. */
export const AVATAR_COLORS = [
  "#E8734A",
  "#3F8CFF",
  "#22A06B",
  "#B15CD1",
  "#E0B33A",
  "#E05C7E",
  "#2FB3B3",
  "#7A6BE8",
] as const

export const WS_MESSAGE_TYPES = [
  "hello",
  "subscribed",
  "location",
  "presence",
  "event",
  "sos",
  "nudge",
  "message",
  "ping",
  "pong",
  "error",
] as const
export type WsMessageType = (typeof WS_MESSAGE_TYPES)[number]
