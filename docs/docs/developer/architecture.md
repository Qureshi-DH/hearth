---
sidebar_position: 1
title: Architecture
---

Hearth is a monorepo with three packages:

```text
hearth/
├── server/            Fastify 5 + Drizzle + Postgres, the self-hosted API
├── apps/mobile/       Expo SDK 55 / React Native, the iOS & Android app (Ignite-based)
└── packages/shared/   Dependency-free TypeScript: API contract types, constants,
                    geo math, and the crash heuristic both sides reason about
```

`packages/shared` is consumed as raw TypeScript by both sides (bundled by tsup
on the server, by Metro in the app), so a change to a response shape is a type
error in both places at once.

## Server

### Request path

```text
phone ──HTTPS──▶ reverse proxy ──▶ Fastify
                                    ├─ helmet / cors / rate-limit (per account)
                                    ├─ @fastify/jwt   (15-minute access tokens)
                                    ├─ zod validation (fastify-type-provider-zod)
                                    └─ modules/*.routes.ts ──▶ services/* ──▶ Drizzle ──▶ Postgres
```

Every route lives under `/api/v1`. Routes are thin: validate, authorise via
`requireMembership(circleId, minRole)`, call a service, serialise. Services hold
the domain logic and are unit-testable with a real database.

### Data model (17 tables)

- `users` and `sessions` hold one session row per (user, device). Refresh
  tokens are hashed and rotated, and push tokens hang off the session, so
  signing a device out also silences it.
- `circles`, `circle_members`, `invites`. A _circle_ is a family. Members carry
  a role (`owner` > `admin` > `member`), a per-circle `sharing_state`
  (`precise` / `approximate` / `paused`), notification mutes, and a feed-read
  watermark.
- `location_points` is breadcrumb history, deduped on
  `(user, device, recorded_at)` so retried uploads are idempotent.
- `user_presence` keeps one row per user: the latest fix, plus flags for the
  low-battery / offline alerts and the trip-detector watermark. Reads for the
  map hit this table, never the history table.
- `places`, `place_memberships` and `place_events` cover geofences, who is
  currently inside each one, and the arrive/leave log.
- `events` is the activity feed. Everything the family sees as a line item,
  including a quick message, which is a feed row, a push and a live frame rather
  than a stored conversation. There is no chat table, because nothing would ever
  read one back.
- `sos_alerts`, `check_ins` and `trips` are the safety features and derived
  journeys.
- `notification_outbox` is the durable push queue (see below).
- `audit_log` and `server_settings` record admin actions and runtime-editable
  settings. A `server_settings` value wins over the environment variable it
  shadows, so an admin can change the server name, the registration mode and the
  history ceiling without a redeploy.

Profile pictures are the one thing that is not a row. They live in S3 compatible
object storage (`services/storage.ts`), the bucket is created on first upload,
and `modules/media.routes.ts` streams them back out under a random key so the
bucket itself never faces the internet. With no storage configured the whole
feature switches off and `/server-info` says so.

A user has _one_ location stream shared into all their circles, and the circle
decides how much of it a viewer may see. That mirrors how people think about it
and keeps the ingest path free of per-circle fan-out.

### Location ingest (`services/locations.ts`)

1. Normalise and reject implausible fixes (future timestamps, >7 days old,
   NaN, out-of-range) without failing the batch.
2. Bulk insert with `ON CONFLICT DO NOTHING`.
3. Advance `user_presence`, only ever forwards in time (`setWhere`), so an
   out-of-order retry can't rewind "where are they now".
4. Replay only the _newly inserted_ fixes through the geofences of circles the
   user shares **precisely** with (`services/geofence.ts`). Places and current
   inside/outside state are loaded once, fixes older than a fence's last
   evaluation are skipped so retries are idempotent, and transitions are
   written in bulk. Hysteresis (radius + 40 m to leave) prevents boundary
   flapping, and fixes worse than 250 m accuracy are ignored. Approximate and
   paused circles learn nothing. An arrival at "Home" is precise information.
5. Raise a low-battery event (≤15 %, not charging, 6-hour cooldown) to circles
   that are not paused.
6. Lapse any expired "paused until" state.
7. Publish `{type:"location", circleId, userId}` on the realtime bus.

### Privacy projection (`services/presence.ts`)

The map endpoint and the websocket both go through `projectPresence()`, which
decides what _this viewer_ may see of _that member_:

- `paused` → coordinates, battery, activity all `null`
- `approximate` → position snapped to a deterministic 750 m grid, accuracy
  widened to ≥750 m, speed/heading/activity hidden, history and trips refused
- viewer looking at themselves → always exact

Because the projection is per viewer, the bus never carries coordinates. The
websocket layer re-projects on each socket.

### Realtime

`lib/bus.ts` is an in-process EventEmitter by default and a Redis pub/sub when
`REDIS_URL` is set. `/api/v1/ws` authenticates with the same JWT (header or
`?access_token=`), primes the client with current presence, then forwards
`location` / `event` / `sos` / `nudge` frames for the circles
the user belongs to. Heartbeat every 30 s.

A `location` message carries the moving member's _unprojected_ presence row,
which never leaves the server-internal bus. Each socket projects it for its own
viewer in memory, so N connected phones cost zero extra queries per fix.
Membership is re-read every 60 s and immediately on a `member_removed` /
`member_left` event about the socket's user, so being kicked from a circle stops
its coordinates within seconds rather than at reconnect.

A `nudge` goes to the recipient's own topic rather than the circle's, so it
arrives already addressed and no other socket has to filter it out. The feed
entry behind it still reaches everyone in the circle.

### Push (`services/push.ts`)

`enqueuePush()` writes rows to `notification_outbox` inside the caller's
transaction. A trigger on that table raises `NOTIFY hearth_outbox`, which
Postgres delivers only when the transaction commits, and every replica
listens for it and drains straight away. The drain claims pending rows with
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, high priority first,
which is safe across several API replicas and against an admin "flush now",
and sends them through the configured `PushDriver` (`none` / `expo` / `ntfy` /
`webpush`) a few at a time. The scheduler tick still drains, for retries with
exponential back-off, dead-token cleanup, and re-queueing of rows a crashed
replica left in `sending`. See [push notifications](../install/push-notifications.md).

### Background jobs (`jobs/scheduler.ts`, every `JOB_INTERVAL_SECONDS`)

drain push → lapse pauses → wake quiet phones (a silent push after a
quarter hour on Android, half an
hour of silence, once per silence) → flag offline devices (>1 h silent, once per
outage, and withheld entirely when at least eight phones have reported at some
point and none of them has reported recently, which means the outage was the
server's) → detect
trips (paged over active users, one advisory lock per user so replicas never
double-detect) → prune history (per-circle retention under the server-wide
ceiling, in 5 000-row batches so a big sweep never holds locks for minutes) →
prune outbox → prune dead sessions. Each step is isolated. One failure never
stops the rest.

The sweep reads the ceiling from `server_settings` on every tick, falling back to
`MAX_HISTORY_RETENTION_DAYS`. Reading the env value instead was the bug: changing
the cap from the app stored a number that then swept nothing.

### Trip detection (`services/trips.ts`)

Breadcrumbs newer than the per-user watermark and older than the idle gap
(5 min) are split wherever the gap between fixes exceeds 5 min. Heartbeat fixes
are skipped, since a parked phone with the app open sends them on a timer and
they would keep a finished drive from closing. A segment with
≥3 points, ≥2 min, ≥400 m and real displacement becomes a `trip`, and its points
are tagged with the trip id. Start and end are matched to places for
"Home → School".

## Mobile app

Ignite conventions with a few deliberate substitutions:

| Concern             | Choice                                                                  | Why                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Server state        | TanStack Query                                                          | cache is written directly by the websocket                                                                                   |
| Client state        | zustand + MMKV                                                          | synchronous hydration, no flash of empty UI                                                                                  |
| Secrets             | expo-secure-store (`stores/tokenVault.ts`)                              | refresh tokens never touch MMKV                                                                                              |
| Map                 | MapLibre RN + OpenFreeMap style                                         | no Google key, swappable to self-hosted tiles                                                                                |
| Background location | expo-location + expo-task-manager                                       | `startLocationUpdatesAsync` with a foreground service on Android                                                             |
| Periodic sync       | expo-background-task                                                    | flushes the offline queue when the OS allows                                                                                 |
| Motion class        | a small native module over Core Motion / Play Services                  | on whenever tracking is, so the GPS can sleep without polling                                                                |
| Crash sensing       | `modules/hearth-motion` (expo-sensors as fallback) + `shared/impact.ts` | native batched sampling that keeps going with the screen off, and a verdict testable against recorded traces, off the device |

### Location pipeline on the phone (`services/location/tracker.ts`)

OS fix → `toFix()` (adds battery) → `thin()` (drops near-duplicates) →
`useTrackingStore.enqueue()` (MMKV-persisted queue, capped at 2000) →
`flush()` (single-flight, oldest first, 200 per batch). Network failures keep
the queue. A 4xx validation error drops the poison batch. The server's response
carries the tracking policy (interval / distance), which is applied live.

`reportNow(source)` takes an immediate high-accuracy fix for check-ins, SOS
(every 20 s while active), and _nudges_ arriving via websocket or push.

The tracker is a two-state machine with a live tier on top. Moving means
continuous updates and, on Android, the foreground-service notification that
comes with them. Once the phone has held still for a few minutes it goes
stationary: the GPS goes off, the service and its notification go with it,
and an exit geofence around the stopping point is what brings it back.
Android keeps a cheap request the OS answers a few times an hour; an iPhone
runs nothing at all and sleeps until the fence or a push wakes it, which is
why it shows no location indicator. The server's silent push is a parked
phone's heartbeat: the wake after half an hour of quiet, the map being
opened, and somebody watching. Watching, somebody having the member's page
open, is the live tier: full accuracy every few seconds for ten minutes,
the only time the GPS runs on a phone nobody is driving. The OS motion
classifier, which runs whenever tracking does, makes the moving and
stationary switch happen sooner in both directions, and a phone that refused
the permission falls back to working stops out from position.

### Realtime on the phone (`services/realtime.ts`)

One socket while foregrounded, torn down in the background because push takes
over, exponential reconnect, and every message is written into the React Query
cache. Screens just render query data.

## Security model, briefly

- Access tokens: 15 min, HS256, `{sub, sid, adm}`. Refresh: 60 days, single-use,
  SHA-256 at rest.
- Passwords: scrypt N=2¹⁵ via `node:crypto`. Login timing is equalised for
  unknown emails.
- Authorisation is always "is the caller a member of this circle with role ≥ X",
  computed from the database per request, never from the token.
- SOS switches a paused sharing state back to precise and leaves it there, and
  bypasses notification mutes. Nothing else does.
- Invite codes: 8 chars, Crockford base32, rejection-sampled, single
  conditional `UPDATE` to claim a seat.

See [privacy](../privacy.md) for what is stored and for how long.
