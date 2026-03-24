import type {
  ActivityType,
  CircleRole,
  EventType,
  LocationSource,
  Platform,
  PlaceIcon,
  PushProvider,
  RegistrationMode,
  SharingState,
  WsMessageType,
} from "./constants"

/* ------------------------------------------------------------------ */
/* Server metadata                                                     */
/* ------------------------------------------------------------------ */

/** Unauthenticated. The app fetches this first to configure itself. */
export interface ServerInfo {
  serverName: string
  version: string
  apiVersion: string
  registrationMode: RegistrationMode
  pushProvider: PushProvider
  /** Populated when pushProvider === "webpush". */
  webPushPublicKey?: string | null
  /** Populated when pushProvider === "ntfy". */
  ntfyBaseUrl?: string | null
  /** Must be a MapLibre style URL. */
  mapStyleUrl: string
  mapStyleUrlDark?: string
  mapAttribution: string
  features: {
    places: boolean
    history: boolean
    trips: boolean
    sos: boolean
    checkIns: boolean
  }
}

/* ------------------------------------------------------------------ */
/* Users & auth                                                        */
/* ------------------------------------------------------------------ */

export interface PublicUser {
  id: string
  displayName: string
  avatarColor: string
  avatarUrl: string | null
}

export interface CurrentUser extends PublicUser {
  email: string
  isAdmin: boolean
  locale: string | null
  createdAt: string
  units: "metric" | "imperial"
}

export interface DeviceInfo {
  deviceId: string
  deviceName?: string | null
  /** Absent and null mean the same thing. Clients send whichever is easier. */
  platform?: Platform | null
  appVersion?: string | null
  osVersion?: string | null
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  /** Seconds until `accessToken` expires. */
  expiresIn: number
}

export interface AuthResponse extends AuthTokens {
  user: CurrentUser
}

export interface SessionSummary {
  id: string
  deviceName: string | null
  platform: Platform | null
  appVersion: string | null
  osVersion: string | null
  createdAt: string
  lastUsedAt: string | null
  current: boolean
  pushEnabled: boolean
}

/* ------------------------------------------------------------------ */
/* Circles                                                             */
/* ------------------------------------------------------------------ */

export interface CircleSettings {
  historyRetentionDays: number
  minUpdateIntervalSeconds: number
  distanceFilterMeters: number
  lowBatteryThreshold: number
  allowSharingPause: boolean
  /** Breadcrumb trails, not just live position. */
  allowHistory: boolean
  /** 0 disables the alert. */
  speedAlertKmh: number
  /**
   * Off by default. GPS alone cannot tell a crash from parking abruptly, so
   * this is a prompt to check on someone, never a detection claim.
   */
  incidentDetection: boolean
}

export interface Circle {
  id: string
  name: string
  emoji: string | null
  color: string | null
  role: CircleRole
  memberCount: number
  settings: CircleSettings
  unreadEventCount: number
  createdAt: string
  updatedAt: string
}

export interface MemberNotificationPrefs {
  muted: EventType[]
  /** Silences everything, not just the muted types. ISO timestamp. */
  mutedUntil: string | null
}

export interface CircleMember {
  userId: string
  circleId: string
  user: PublicUser
  role: CircleRole
  nickname: string | null
  sharingState: SharingState
  pausedUntil: string | null
  joinedAt: string
  notifications: MemberNotificationPrefs
}

export interface CircleInvite {
  id: string
  circleId: string
  code: string
  role: CircleRole
  maxUses: number | null
  uses: number
  expiresAt: string | null
  createdAt: string
  createdBy: PublicUser | null
  /** Deep link the app can render as a QR code. */
  url: string
}

export interface InvitePreview {
  code: string
  circleName: string
  circleEmoji: string | null
  memberCount: number
  invitedBy: string | null
  role: CircleRole
  expiresAt: string | null
  valid: boolean
  reason?: "expired" | "revoked" | "exhausted" | "not_found" | "already_member"
}

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

export interface LocationFixInput {
  recordedAt: string
  lat: number
  lon: number
  accuracyMeters?: number | null
  altitudeMeters?: number | null
  altitudeAccuracyMeters?: number | null
  speedMps?: number | null
  headingDegrees?: number | null
  activity?: ActivityType | null
  batteryLevel?: number | null
  isCharging?: boolean | null
  isMoving?: boolean | null
  source?: LocationSource
  deviceId?: string | null
}

export interface LocationBatchRequest {
  points: LocationFixInput[]
}

export interface LocationBatchResponse {
  accepted: number
  rejected: number
  /** Geofence transitions the server derived from this batch. */
  placeEvents: number
  /** Server clock, so the device can correct drift. */
  serverTime: string
  /** The device applies these from now on. They change with circle settings. */
  policy: {
    minUpdateIntervalSeconds: number
    distanceFilterMeters: number
  }
}

export interface MemberPresence {
  userId: string
  lat: number | null
  lon: number | null
  accuracyMeters: number | null
  recordedAt: string | null
  batteryLevel: number | null
  isCharging: boolean | null
  activity: ActivityType | null
  speedMps: number | null
  headingDegrees: number | null
  /** The coordinates have been snapped to a grid. */
  approximate: boolean
  sharingState: SharingState
  /** No fix within DEFAULTS.staleAfterSeconds. */
  stale: boolean
  atPlace: { id: string; name: string; icon: PlaceIcon | null } | null
  sosAlertId: string | null
}

export interface HistoryPoint {
  id: string
  recordedAt: string
  lat: number
  lon: number
  accuracyMeters: number | null
  speedMps: number | null
  activity: ActivityType | null
  batteryLevel: number | null
  tripId: string | null
}

/* ------------------------------------------------------------------ */
/* Places (geofences)                                                  */
/* ------------------------------------------------------------------ */

export interface Place {
  id: string
  circleId: string
  name: string
  icon: PlaceIcon | null
  color: string | null
  lat: number
  lon: number
  radiusMeters: number
  address: string | null
  createdAt: string
  updatedAt: string
  createdBy: PublicUser | null
  /** User ids. */
  membersInside: string[]
}

export interface PlaceEvent {
  id: string
  placeId: string
  placeName: string
  userId: string
  type: "arrive" | "leave"
  occurredAt: string
}

/* ------------------------------------------------------------------ */
/* Activity feed                                                       */
/* ------------------------------------------------------------------ */

export interface FeedEvent {
  id: string
  circleId: string
  type: EventType
  actor: PublicUser | null
  occurredAt: string
  payload: Record<string, unknown>
  /** Pre-rendered and not localised. Clients may re-render from the payload. */
  summary: string
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface CircleMessage {
  id: string
  circleId: string
  author: PublicUser
  body: string
  /** Set when the message came from a quick reply. */
  quickKey: string | null
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Safety                                                              */
/* ------------------------------------------------------------------ */

export interface SosAlert {
  id: string
  circleId: string
  user: PublicUser
  startedAt: string
  resolvedAt: string | null
  resolvedBy: PublicUser | null
  note: string | null
  lastLat: number | null
  lastLon: number | null
  lastFixAt: string | null
}

export interface CheckIn {
  id: string
  circleId: string
  user: PublicUser
  lat: number
  lon: number
  note: string | null
  placeId: string | null
  placeName: string | null
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Trips                                                               */
/* ------------------------------------------------------------------ */

export interface Trip {
  id: string
  userId: string
  startedAt: string
  endedAt: string
  distanceMeters: number
  durationSeconds: number
  maxSpeedMps: number | null
  avgSpeedMps: number | null
  pointCount: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  startPlaceName: string | null
  endPlaceName: string | null
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

export interface PushRegistration {
  provider: PushProvider
  /** Expo push token, ntfy topic, or JSON-encoded Web Push subscription. */
  token: string
}

export interface PushConfig {
  provider: PushProvider
  webPushPublicKey?: string | null
  ntfyBaseUrl?: string | null
  /** Present when the client must derive its own topic. */
  ntfyTopic?: string | null
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export interface ServerSettings {
  serverName: string
  registrationMode: RegistrationMode
  /** Hard cap on stored history, overriding per-circle settings. Null = no cap. */
  maxHistoryRetentionDays: number | null
  allowPublicInvites: boolean
}

export interface AdminUserSummary extends PublicUser {
  email: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string
  lastSeenAt: string | null
  circleCount: number
  deviceCount: number
}

export interface AdminStats {
  users: number
  activeUsers24h: number
  circles: number
  places: number
  locationPoints: number
  oldestPointAt: string | null
  pushQueueDepth: number
  databaseSizeBytes: number | null
  uptimeSeconds: number
  version: string
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

export type WsServerMessage =
  | { type: "hello"; userId: string; serverTime: string }
  | { type: "subscribed"; circleIds: string[] }
  | { type: "location"; circleId: string; presence: MemberPresence }
  | { type: "presence"; circleId: string; presences: MemberPresence[] }
  | { type: "event"; circleId: string; event: FeedEvent }
  | { type: "sos"; circleId: string; alert: SosAlert }
  | { type: "nudge"; circleId: string; fromUserId: string }
  | { type: "message"; circleId: string; message: CircleMessage }
  | { type: "pong"; serverTime: string }
  | { type: "error"; message: string }

export type WsClientMessage = { type: "subscribe"; circleIds: string[] } | { type: "ping" }

export type { WsMessageType }

/* ------------------------------------------------------------------ */
/* Errors & pagination                                                 */
/* ------------------------------------------------------------------ */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface Paginated<T> {
  items: T[]
  nextCursor: string | null
}
