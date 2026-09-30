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
                    geo and speed math, and the phone's crash heuristic
```

`packages/shared` is consumed as raw TypeScript by both sides (bundled by tsup
on the server, by Metro in the app), so a change to a response shape is a type
error in both places at once.

## Server

### Request path

```text
phone ──HTTPS──▶ reverse proxy ──▶ Fastify
                                    ├─ helmet / cors / rate-limit (per account, else per IP)
                                    ├─ @fastify/jwt   (15-minute access tokens)
                                    ├─ zod validation (fastify-type-provider-zod)
                                    └─ modules/*.routes.ts ──▶ services/* ──▶ Drizzle ──▶ Postgres
```

Every API route lives under `/api/v1`. Only the health probes (`/healthz`,
`/readyz`), the invite landing page (`/join/:code`) and the Swagger UI at
`/docs` sit outside it. Routes are thin: validate, authorise via
`requireMembership(request, circleId, minRole)`, call a service, serialise.
Services hold the domain logic and are unit-testable with a real database.

### Data model (18 tables)

- `users` and `sessions` hold one session row per (user, device). Refresh
  tokens are hashed and rotated, and push tokens hang off the session, so
  signing a device out also silences it.
- `circles`, `circle_members`, `invites`. A _circle_ is a family. Members carry
  a role (`owner` > `admin` > `member`), a per-circle `sharing_state`
  (`precise` / `approximate` / `paused`), notification mutes, and a feed-read
  watermark. `circle_removals` records who was removed, so an invite made
  before the removal can't bring them back.
- `location_points` is breadcrumb history, deduped on
  `(user, device, recorded_at)` so retried uploads are idempotent.
- `user_presence` keeps one row per user: the latest fix, plus flags for the
  low-battery / offline alerts, the trip-detector watermark, the wake count,
  the control channel's stamps and the phone's own health report. Reads for
  the map hit this table, never the history table.
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

1. Normalise and reject implausible fixes (more than 5 minutes in the future,
   over 7 days old, NaN) without failing the batch. Coordinates out of range
   fail the request schema before that.
2. Bulk insert. A duplicate changes nothing, except that a re-report saying
   `still` adopts that activity (`onConflictDoUpdate` with a `setWhere`).
3. Advance `user_presence`, only ever forwards in time (`setWhere`), so an
   out-of-order retry can't rewind "where are they now".
4. Lapse any expired "paused until" state.
5. Replay only the _newly inserted_ fixes through the geofences of circles the
   user shares **precisely** with (`services/geofence.ts`). Places and current
   inside/outside state are loaded once, fixes older than a fence's last
   evaluation are skipped so retries are idempotent, and the arrive/leave log
   is written in one insert. Hysteresis (radius + 40 m to leave) prevents
   boundary flapping, and fixes worse than 250 m accuracy are ignored. A
   network estimate worse than 100 m can still bring somebody into a place,
   but takes them out of one only from more than twice its error away,
   because a parked Android phone answered from the cell network can sit a
   street away for hours.
   Approximate and paused circles learn nothing. An arrival at "Home" is
   precise information.
6. Raise speed and possible-crash alerts, to precisely shared circles only.
7. Raise a low-battery event (≤15 % unless the circle sets its own threshold,
   not charging, 6-hour cooldown) to circles that are not paused.
8. Publish `{type:"location", circleId, userId, raw}` on the realtime bus for
   every circle the user is in, where `raw` is the unprojected presence.

### Privacy projection (`services/presence.ts`)

The map endpoint and the websocket both go through `projectPresence()`, which
decides what _this viewer_ may see of _that member_:

- `paused` → coordinates, battery, activity all `null`
- `approximate` → position snapped to a deterministic 750 m grid, accuracy
  widened to ≥750 m, speed/heading/activity hidden, history and trips refused
- viewer looking at themselves → always exact

Because the projection is per viewer, the bus carries the unprojected row and
the websocket layer projects it on each socket.

### Realtime

`lib/bus.ts` is an in-process EventEmitter by default and a Redis pub/sub when
`REDIS_URL` is set. `/api/v1/ws` authenticates with the same JWT (header or
`?access_token=`), primes the client with current presence, then forwards
`location` / `event` / `sos` frames for the circles the user belongs to, and
`nudge` / `control` frames addressed to the user. Heartbeat every 30 s, or
every 2 minutes on a control channel.

A `location` message carries the moving member's _unprojected_ presence row,
which never leaves the server. With Redis the frames are sealed with
AES-256-GCM under a key derived from `JWT_SECRET`, so Redis itself never reads
a coordinate. Each socket projects the row for its own viewer in memory, so N
connected phones cost zero extra queries per fix.
Membership is re-read every 60 s and immediately on a `member_removed` /
`member_left` event about the socket's user, so being kicked from a circle stops
its coordinates within seconds rather than at reconnect.

A `nudge` goes to the recipient's own topic rather than the circle's, so it
arrives already addressed and no other socket has to filter it out. The feed
entry behind it still reaches everyone in the circle.

### Control channel (`services/control.ts`)

The phone's tracker opens a second socket to `/api/v1/ws` and sends
`{type:"control"}`, which makes that socket its control channel. Every answered
heartbeat refreshes `user_presence.control_seen_at`. When the server wants
something from a phone, it calls `sendControl()` first: the sweep's wake, the
fresh fix asked for when someone opens the map or a member's page, and Live's
watch. That publishes a `control` frame on the user's bus topic, and whichever
replica holds the socket passes it on. Only when no channel is open, its stamp
is over five minutes old, or an earlier ask went unanswered for 20 seconds does
the server fall back to a silent push, which needs the `expo` provider.

An iPhone keeps the channel open whenever sharing is on, because its parked
location session keeps the app alive. An Android phone holds it only while
moving, so a parked Android phone is reached by silent push alone.

### Push (`services/push.ts`)

`enqueuePush()` writes rows to `notification_outbox` inside the caller's
transaction. A trigger on that table raises `NOTIFY hearth_outbox`, which
Postgres delivers only when the transaction commits, and every replica
listens for it and drains straight away. The drain claims pending rows with
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, high priority first,
which is safe across several API replicas and against an admin "flush now",
and sends them through the configured `PushDriver` (`none` / `expo` / `ntfy` /
`webpush`) 8 at a time. Before sending, it drops a row whose recipient has left
the circle, and place news about somebody who no longer shares precisely with
it. Each provider call gets 15 s. A failed send is retried with back-off, and
after 6 attempts the row is marked `failed`. The scheduler tick still drains,
for those retries, dead-token cleanup, and re-queueing of rows a crashed
replica left in `sending`. See [push notifications](../install/push-notifications.md).

A silent push (`silent: true`, the `wake` and `watch` rows) can only go through
`expo`, and the drain marks it `skipped` for any other provider. It carries a
lifetime: `ttl` and `expiration` of 60 s for a watch and 300 s for a wake.
Without one FCM and APNs hold a message for up to four weeks, and a wake that
Doze held back is then delivered out of context, so the phone fires its GPS at
a random moment to answer a question nobody is asking. On iOS a
content-available push travels at normal priority (APNs 5), which is what Apple
documents for a background push. Sending it at 10 is an error condition and
gets throttled. Android stays high, since that is what carries a data message
through Doze. The per-phone guards that decide whether a silent push went
recently (`recentSilentPushes`) count only rows that are `pending`, `sending`
or `sent`: a row skipped for want of a token or failed at the provider never
reached the phone, so it neither counts as an attempt nor holds the next one
back.

### Background jobs (`jobs/scheduler.ts`, every `JOB_INTERVAL_SECONDS`)

The first pass runs 5 s after boot. Each step is isolated, so one failure never
stops the rest, and a tick that comes round while the last pass is still
running is skipped.

1. Drain push, after putting back rows a crashed replica left in `sending` for
   over 10 minutes.
2. Lapse expired pauses, restoring whatever mode each member had before.
3. Wake quiet phones, on a schedule measured from when the phone was last
   heard, `greatest(recorded_at, last_heard_at)`. A phone last seen moving is
   asked at 10, 20 and 40 minutes, a parked one every half hour up to three
   times, and `wake_count` resets when the phone uploads anything at all. Each
   ask goes down the control channel when one is open, and otherwise as a
   silent push if the provider is `expo`.
4. Flag offline devices, over 1 h silent or 12 h for a parked phone. Parked
   means the last fix said "still", or the member is inside a named place, or
   the last fix measured under 1 m/s with an accuracy of 250 m or better. A
   phone the server can push is only called offline once two wakes have gone
   unanswered. Each circle hears it once per outage, with the reason when the
   phone's own health report gave one. The step is withheld entirely when at
   least eight phones count and more of them are quiet than reporting, which
   means the outage was the server's.
5. Announce returned devices. A circle that was told a phone went quiet gets a
   `device_online` feed line, with no push, once it reports again.
6. Detect trips, paged over users with a fix in the last 6 hours, one advisory
   lock per user so replicas never double-detect.
7. Prune history: per-circle retention under the server-wide ceiling, in
   5 000-row batches and at most 20 per user per tick, so a big sweep never
   holds locks for minutes.
8. Prune sent, skipped and failed outbox rows after 7 days.
9. Prune sessions that have expired, or were revoked over 30 days ago.

The sweep reads the ceiling from `server_settings` on every tick, falling back to
`MAX_HISTORY_RETENTION_DAYS`. Reading the env value instead was the bug: changing
the cap from the app stored a number that then swept nothing.

### Trip detection (`services/trips.ts`)

Breadcrumbs newer than the per-user watermark and older than the idle gap
(5 min) are split wherever the gap between fixes exceeds 5 min, or wherever
the phone stayed inside 100 m for longer than that. Heartbeat fixes are
skipped, since a parked phone sends them on a timer and they would keep a
finished drive from closing. So are network estimates worse than 100 m: one
of them between two fixes at home is otherwise a trip there and back. A gap
is not a split when the fix after it shows the phone travelled through it. A segment with ≥3 points,
≥2 min, ≥250 m of path and real displacement (150 m from where it started)
becomes a `trip`, and its points are tagged with the trip id. Start and end
are matched to places for "Home → School".

A journey between two named places is a trip whatever its length, because
the feed has already announced "left" and "arrived" for it. The tracker
cannot see a move shorter than its fence around the parking spot, so such a
journey often reaches the server as one fix at the origin, a silence, and a
fix inside the destination: that silence, up to 45 minutes, is read as the
journey, and the trip starts at the last fix at the origin.

## Mobile app

Ignite conventions with a few deliberate substitutions:

| Concern             | Choice                                                                               | Why                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server state        | TanStack Query                                                                       | cache is written directly by the websocket                                                                                                                                                                           |
| Client state        | zustand + MMKV                                                                       | synchronous hydration, no flash of empty UI                                                                                                                                                                          |
| Secrets             | expo-secure-store (`stores/tokenVault.ts`)                                           | refresh tokens never touch MMKV                                                                                                                                                                                      |
| Map                 | MapLibre RN + OpenFreeMap style                                                      | no Google key, swappable to self-hosted tiles                                                                                                                                                                        |
| Background location | expo-location + expo-task-manager, and a native service on Android                   | `startLocationUpdatesAsync` on iOS and for a parked Android phone. A moving Android phone runs `HearthTrackingService` from `modules/hearth-motion`, which a manifest receiver can start before the JavaScript is up |
| Periodic sync       | expo-background-task                                                                 | flushes the offline queue when the OS allows                                                                                                                                                                         |
| Motion class        | `modules/hearth-motion`, over Core Motion / Play Services                            | on whenever tracking is, so the GPS can sleep without polling                                                                                                                                                        |
| Crash sensing       | `modules/hearth-motion` (expo-sensors as fallback) + `packages/shared/src/impact.ts` | native batched sampling that keeps going with the screen off, and a verdict testable against recorded traces, off the device                                                                                         |

### Location pipeline on the phone (`services/location/tracker.ts`)

OS fix → `toFix()` (adds battery) → `thin()` (drops near-duplicates) →
`useTrackingStore.enqueue()` (MMKV-persisted queue, capped at 2000) →
`flush()` (single-flight, oldest first, 200 per batch). Network failures keep
the queue. A 4xx validation error drops the poison batch. The server's response
carries the tracking policy (interval / distance), which is applied live.

`reportNow(source)` takes an immediate high-accuracy fix for check-ins, SOS
(every 20 s while the SOS screen is open), and a _nudge_ arriving over the
websocket.

The tracker is a two-state machine with a live tier on top. Moving means
continuous updates and, on Android, the foreground-service notification that
comes with them. Once the phone has held still for a few minutes it goes
stationary: the GPS goes off, the service and its notification go with it,
and an exit geofence around the stopping point is what brings it back.
Android keeps a Wi-Fi grade request the OS answers a few times an hour. An
iPhone keeps a cell-only session, which keeps the app alive to report once a
quarter of an hour and to hold the control channel open. The server's asks
are a parked phone's other heartbeat: the wake after half an hour of quiet,
the map or a member's page being opened, and Live. Live, offered while the
member is on the move, is the live tier: full accuracy, a fix a second, for
ten minutes. A parked Android phone answers it with one fix instead, because a
live request brings the service and its notification with it. The OS motion
classifier, which runs whenever tracking does, makes the moving and
stationary switch happen sooner in both directions, and a phone that refused
the permission falls back to working stops out from position.

### Realtime on the phone (`services/realtime.ts`)

One socket while foregrounded, torn down in the background, exponential
reconnect, and every message but a nudge is written into the React Query
cache. A nudge goes to its own store and makes the phone report at once.
Screens just render query data. The control channel
(`services/location/control.ts`) is a separate socket the tracker holds in the
background, as described above.

## Security model, briefly

- Access tokens: 15 min, HS256, `{sub, sid}`. The admin flag is read from the
  database per request. Refresh: 60 days, rotated on every use, SHA-256 at
  rest. A spent one presented again is refused, and ends the session if it
  comes more than 30 s after the rotation. The same device gets one retry
  within the access token's lifetime, answered with a fresh pair.
- Passwords: scrypt N=2¹⁵ via `node:crypto`. Login timing is equalised for
  unknown emails.
- Authorisation is always "is the caller a member of this circle with role ≥ X",
  computed from the database per request, never from the token.
- SOS switches a paused sharing state back to precise and leaves it there.
  Nothing else overrides sharing. Mutes apply only to the alert types a member
  may silence (`MUTABLE_EVENT_TYPES`), so an SOS or a possible crash always
  gets through.
- Invite codes: 8 chars, Crockford base32, rejection-sampled, single
  conditional `UPDATE` to claim a seat.

See [privacy](../privacy.md) for what is stored and for how long.
