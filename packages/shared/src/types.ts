import type {
  ActivityType,
  CircleRole,
  EventType,
  LocationSource,
  Platform,
  PlaceAlerts,
  PlaceIcon,
  PresenceIssue,
  PushProvider,
  RegistrationMode,
  SharingState,
  SosReason,
  QuickMessageKey,
  WsMessageType,
} from "./constants"

/* ------------------------------------------------------------------ */
/* Server metadata                                                     */
/* ------------------------------------------------------------------ */

export interface MapStyle {
  /** What a phone remembers its choice by, so it has to stay put across renames. */
  id: string
  name: string
  /** A MapLibre style URL. */
  url: string
  /** Which of the app's themes the style is drawn under. */
  scheme: "light" | "dark"
}

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
  /**
   * Every style a phone may choose from. mapStyleUrl and mapStyleUrlDark stay
   * the defaults, and servers older than the list leave it out.
   */
  mapStyles?: MapStyle[]
  mapAttribution: string
  features: {
    places: boolean
    history: boolean
    trips: boolean
    sos: boolean
    checkIns: boolean
    /** False when the server has no object storage, so uploads are hidden. */
    avatars: boolean
    /**
     * Per-place choices, muting a person and quiet hours. Older servers leave
     * it out and would ignore or refuse those settings.
     */
    notificationControls?: boolean
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
  /** Absent from servers older than quiet hours. */
  notificationSettings?: NotificationSettings
}

/** "HH:MM" on the phone's own clock. */
export interface QuietHours {
  from: string
  until: string
  /** Hold ordinary news until `until`, or drop it. */
  then: "hold" | "drop"
}

/**
 * Notification settings that follow the person rather than a circle, so every
 * phone they sign in on agrees. SOS, possible crashes and the other safety
 * alerts ignore all of it.
 */
export interface NotificationSettings {
  /** The phone's IANA time zone, which quiet hours and late times are read in. */
  timeZone: string | null
  clock: "12h" | "24h" | null
  quietHours: QuietHours | null
  /** People whose comings and goings this person no longer hears about. */
  mutedPeople: string[]
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

/** What the admin portal holds after signing in. Its refresh token stays in a cookie. */
export type PortalSession = Omit<AuthResponse, "refreshToken">

/**
 * POST /auth/portal/refresh. `{ signedIn: false }` when there is no cookie or
 * its session is over. A server from before this answers those with a 401.
 */
export type PortalRefreshResponse = PortalSession | { signedIn: false }

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
  /**
   * What to hear about each of this circle's places, by place id. A place
   * missing here is heard about both ways. Absent from older servers.
   */
  places?: Record<string, PlaceAlerts>
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
  /**
   * "removed" is for a signed-in viewer the circle removed, holding a code
   * made before that. Joining needs one made since.
   */
  reason?: "expired" | "revoked" | "exhausted" | "not_found" | "already_member" | "removed"
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
  /**
   * The phone should report live until then, because somebody has this
   * member's page open or the member has an SOS open. Null when neither.
   */
  watchedUntil: string | null
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
  /** No fix within DEFAULTS.staleAfterSeconds, or parkedStaleAfterSeconds for a parked phone. */
  stale: boolean
  atPlace: { id: string; name: string; icon: PlaceIcon | null; since: string | null } | null
  sosAlertId: string | null
  /**
   * What the phone itself last said stands between it and reporting. Empty
   * when it said nothing is wrong, or has not said. Family safety apps show these under
   * a member as "Location permissions off"; a quiet phone with one of these
   * is not a mystery.
   */
  issues: PresenceIssue[]
}

export type { PresenceIssue } from "./constants"

/**
 * What POST /circles/:id/members/:userId/watch tells the viewer. `pushed`
 * is what became of the silent push: "held" when one went out recently,
 * "no_device" when the member has no push token, "unsupported" when the
 * server's push provider cannot carry a silent push. The Live page reads
 * the rest to say why a phone is quiet instead of freezing on an old dot.
 */
export interface WatchResponse {
  watching: boolean
  seconds: number
  pushed: "socket" | "sent" | "held" | "no_device" | "unsupported"
  lastFixAt: string | null
  lastHeardAt: string | null
  activity: ActivityType | null
  issues: PresenceIssue[]
}

/** What a phone reports about its own ability to share, see PATCH /me/health. */
export interface DeviceHealth {
  /** "always" is the only level that reports from the background. */
  locationPermission: "always" | "foreground" | "denied" | "unknown"
  locationServices: boolean
  /** False for Android's approximate grant, or iOS with Precise Location off. */
  preciseLocation?: boolean
  /** Motion and activity access. Absent where the phone cannot classify motion. */
  motionPermission?: "granted" | "denied" | "undetermined"
  /** The person's own "Share my location" switch. Off, the phone sends nothing. */
  sharingEnabled?: boolean
  /** iOS Background App Refresh. Absent where it does not exist. */
  backgroundRefresh?: "available" | "denied" | "restricted"
  /** Android: the app is still subject to battery optimisation. */
  batteryOptimised?: boolean
  /**
   * Android: the user set the app's background usage to Restricted, which
   * ends its foreground service the moment the screen locks.
   */
  backgroundRestricted?: boolean
  /** iOS Low Power Mode or Android Battery Saver. Either one starves the tracker. */
  lowPowerMode?: boolean
  /** Which vendor's battery manager the family is up against. */
  manufacturer?: string
  /** Android: the foreground service died without the app asking it to. */
  serviceStopped?: boolean
  reportedAt?: string
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

/**
 * What an edit of a place answers when somebody else deleted it first. A
 * server from before this answers 404 instead.
 */
export interface PlaceGone {
  id: string
  gone: true
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
/* Nudges                                                              */
/* ------------------------------------------------------------------ */

export interface Nudge {
  circleId: string
  from: PublicUser
  /** Null when it is only a request to update their location. */
  body: string | null
  quickKey: QuickMessageKey | null
  sentAt: string
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

/**
 * POST /circles/:circleId/sos. A server from before `reason` ignores it and
 * raises in that circle only.
 */
export interface RaiseSosRequest {
  note?: string | null
  /** "sos" when it is left out. */
  reason?: SosReason
}

/**
 * The alert in the circle the request named, with everything the raise did.
 * 201 when it raised something new, 200 when every alert was already open, so
 * pressing again after a lost reply is safe. A server from before one press
 * covered every circle leaves `alerts` out and answers a repeat with 409.
 */
export interface RaiseSosResponse extends SosAlert {
  /** Everybody it reaches, once each however many circles they share with the raiser. */
  notifiedMembers: number
  /** One per circle the alert is open in, the named circle's included. */
  alerts?: SosAlert[]
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

export interface TripPathPoint {
  recordedAt: string
  lat: number
  lon: number
  speedMps: number | null
}

/**
 * GET /trips/:tripId. With `soft=true` a trip the viewer can no longer see,
 * or one that is gone, comes back as `{ id, visible: false }` instead of a
 * 403 or a 404. A server from before that answer leaves `visible` out.
 */
export type TripDetailResponse =
  (Trip & { visible?: true; path: TripPathPoint[] }) | { id: string; visible: false }

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
  /** Caps every circle's own retention. Null hands the cap back to MAX_HISTORY_RETENTION_DAYS. */
  maxHistoryRetentionDays: number | null
}

export interface AdminUserSummary extends PublicUser {
  email: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string
  lastSeenAt: string | null
  circleCount: number
  deviceCount: number
  /**
   * The longest stretch without a fix in the last day, counting the one
   * still running. How the resting watch is judged on a real phone.
   */
  longestSilenceSeconds: number | null
}

/** A circle on the server, as its operator sees it: who is in it, never where. */
export interface AdminCircleSummary {
  id: string
  name: string
  emoji: string | null
  createdAt: string
  memberCount: number
  placeCount: number
  members: Array<{ userId: string; displayName: string; role: CircleRole }>
  settings: Pick<
    CircleSettings,
    | "historyRetentionDays"
    | "allowHistory"
    | "allowSharingPause"
    | "speedAlertKmh"
    | "incidentDetection"
  >
}

/**
 * What the portal's dashboard draws: how busy the server was each day, what
 * became of its notifications, and whether each person's phone is reporting.
 * Counts and times, never a position.
 */
export interface AdminOverview {
  /**
   * The zone the days are drawn in. The viewer's, or UTC when the database
   * does not know theirs. A server from before this leaves it out.
   */
  timeZone?: string
  /** The window's days in the viewer's time zone, oldest first, as YYYY-MM-DD. */
  days: string[]
  /** Fixes recorded on each day. */
  fixes: number[]
  /** Accounts that recorded at least one fix on each day. */
  activeAccounts: number[]
  /**
   * Notifications queued on each day, by what became of them. Silent wakes are
   * left out. The queue is pruned sooner than the window ends, so its oldest
   * days read zero.
   */
  notifications: { sent: number[]; failed: number[]; skipped: number[]; waiting: number[] }
  /** Each active account and the phone it last used. */
  phones: AdminPhone[]
}

/**
 * How a phone is doing, judged as the server judges it before telling the
 * family it went offline. A parked phone is allowed a much longer silence
 * than one last seen on the move, so "parked" is not a fault.
 */
export type AdminPhoneState = "reporting" | "quiet" | "parked" | "offline" | "never" | "none"

export interface AdminPhone {
  userId: string
  displayName: string
  avatarColor: string
  deviceName: string | null
  platform: Platform | null
  appVersion: string | null
  /** The last time the phone was heard from, with or without a fix. */
  lastHeardAt: string | null
  state: AdminPhoneState
  /** What the phone itself said stands between it and reporting. */
  issues: PresenceIssue[]
  /**
   * The phone is no longer reporting and its last reading was nearly flat,
   * off the charger. What the battery explains is left out of `issues`.
   */
  batteryRanOut?: boolean
}

export type AdminCheckId =
  | "public_address"
  | "registration"
  | "push"
  | "administrators"
  | "failed_notifications"
  | "storage"
  | "api_docs"

/** Something about how the server is set up that its operator should know. */
export interface AdminCheck {
  id: AdminCheckId
  level: "ok" | "info" | "warning"
  title: string
  detail: string
}

export interface AdminAuditEntry {
  id: string
  actorUserId: string | null
  actorName: string | null
  action: string
  targetType: string | null
  targetId: string | null
  /** The account's name when the target is an account. */
  targetName: string | null
  meta: Record<string, unknown> | null
  ip: string | null
  createdAt: string
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
  pushProvider: PushProvider
  version: string
}

/**
 * A notification in the outbox. The title and body are the administrator's
 * own only: running the server is not reading everybody's alerts.
 */
export interface AdminOutboxEntry {
  id: string
  userId: string
  /** Null once the account is gone. */
  userName: string | null
  title: string | null
  body: string | null
  channel: "default" | "alerts" | "sos"
  status: "pending" | "sending" | "sent" | "failed" | "skipped"
  attempts: number
  lastError: string | null
  createdAt: string
  sentAt: string | null
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
  | { type: "nudge"; circleId: string; nudge: Nudge }
  /**
   * Down the phone's control channel: `ready` once it is registered, then
   * `watch` (go live for `seconds`) and `wake` (one fix now) as they are asked.
   */
  | { type: "control"; command: "ready" | "watch" | "wake"; seconds?: number }
  | { type: "pong"; serverTime: string }
  | { type: "error"; message: string }

export type WsClientMessage =
  | { type: "subscribe"; circleIds: string[] }
  | { type: "ping" }
  /** The phone's tracker declaring this socket its control channel. */
  | { type: "control" }

/**
 * What POST /circles/:id/members/:userId/refresh did: the phone was asked
 * over its control channel, or by a silent push, or was heard from within
 * the last half minute and left alone, or was pushed moments ago, or cannot
 * be reached at all.
 */
export interface RefreshMemberResponse {
  asked: "socket" | "pushed" | "held" | "fresh" | "no_device" | "unsupported"
}

/**
 * POST /circles/:circleId/nudge/:userId. A server from before these fields
 * answers `{ ok: true }` alone.
 */
export interface NudgeResponse {
  ok: true
  /**
   * The notification. "held" when the sender asked the same person the same
   * thing moments ago, so they were not notified twice. "paused" when a bare
   * ask for a location went to somebody who paused sharing, and nothing went.
   * "gone" when they are no longer in the circle, and nothing went either.
   */
  notified?: "sent" | "held" | "paused" | "gone"
  /**
   * The ask for a fresh fix that goes with a bare ask for a location, in the
   * words of RefreshMemberResponse. Null for a message, which asks nothing of
   * the phone.
   */
  asked?: RefreshMemberResponse["asked"] | "paused" | null
}

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
