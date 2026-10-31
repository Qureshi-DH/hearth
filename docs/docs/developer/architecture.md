---
sidebar_position: 1
title: Architecture
---

Hearth is a monorepo with three packages:

```text
hearth/
├── server/            Fastify 5 + Drizzle + Postgres, the self-hosted API
├── apps/mobile/       Expo SDK 58 / React Native, the iOS & Android app (Ignite-based)
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

### Data model (20 tables)

- `users` and `sessions` hold one session row per (user, device). Refresh
  tokens are hashed and rotated, and push tokens hang off the session, so
  signing a device out also silences it. `users.notification_settings` holds
  what follows a person to every phone, which is the phone's time zone and
  clock, quiet hours and the people they muted.
- `circles`, `circle_members`, `invites`. A _circle_ is a family. Members carry
  a role (`owner` > `admin` > `member`), a per-circle `sharing_state`
  (`precise` / `approximate` / `paused`), notification mutes and per-place
  choices, and a feed-read
  watermark. `circle_removals` records who was removed, so an invite made
  before the removal can't bring them back.
- `location_points` is breadcrumb history, deduped on
  `(user, device, recorded_at)` so retried uploads are idempotent.
- `user_presence` keeps one row per user: the latest fix, plus flags for the
  low-battery / offline alerts, the trip-detector watermark, the wake count,
  the control channel's stamps, the phone's own health report and the device
  the position came from. Reads for the map hit this table, never the history
  table.
- `live_watches` has a row for each person with a member's Live page open,
  until when they hold it and the circle they hold it through. The phone's
  window, `user_presence.watched_until`, is the latest of them, so the last
  viewer out ends it.
- `places`, `place_memberships` and `place_events` cover geofences, who is
  currently inside each one, and the arrive/leave log. A membership also
  carries `settles_at`, until which its last crossing may still be undone, and
  `quiet_until`, for a place somebody keeps leaving and coming back to.
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
   out-of-order retry can't rewind "where are they now". A parked word from
   one device doesn't take the row from another device of the same person
   whose position isn't stale, so a tablet left at home doesn't pull the dot
   back from the road. A device on the move takes it like any fix.
4. Lapse any expired "paused until" state.
5. Replay only the _newly inserted_ fixes through the geofences of circles the
   user shares **precisely** with (`services/geofence.ts`). Places and current
   inside/outside state are loaded once, fixes older than a fence's last
   evaluation are skipped so retries are idempotent, and the arrive/leave log
   is written in one insert. Hysteresis (radius + 40 m to leave) prevents
   boundary flapping, and fixes worse than 250 m accuracy are ignored. A
   network estimate worse than 100 m can still bring somebody into a place,
   but takes them out of one only from more than twice its error away,
   because a phone that answers its pings from the cell network can sit a
   street away for hours.
   Approximate and paused circles learn nothing. An arrival at "Home" is
   precise information. When sharing with a circle becomes precise again,
   `reseedPlaceMemberships` starts its places from the newest fix sharp
   enough, with no events, so nothing that happened in between is announced.

   What the family hears is narrower than what the feed records. A departure
   is pushed once a second fix is clear of the place too, or a minute passes
   with no fix back inside, and a fix back inside before then cancels both.
   From a phone that says it is `still`, one fix outside waits for a second to
   agree, up to 45 minutes, since a phone that has not moved has not left.
   An arrival is pushed at once, unless the phone was doing 5 m/s or more,
   when it waits up to a minute in case the car is driving past. Either wait
   is `settles_at` on the membership and `next_attempt_at` on the row, and a
   fix that settles it early releases the row. An arrival carries its
   journey, worked out from the fixes since the departure it answers
   (`journeyTo`). Places crossed on the same fix push only the smallest one,
   and coming back to a place within 10 minutes of leaving it keeps that
   place to the feed for 15 minutes, so pacing a boundary sends one pair.
   News older than 30 minutes, or from a batch whose newest fix is older than
   15, goes to the feed only.

6. Raise speed and possible-crash alerts, to precisely shared circles only.
7. Raise a low-battery event (≤15 % unless the circle sets its own threshold,
   not charging, 6-hour cooldown) to circles that are not paused.
8. Publish `{type:"location", circleId, userId, raw, fixes}` on the realtime
   bus for every circle the user is in, where `raw` is the unprojected
   presence and `fixes` are the batch's fixes past the old position, sent
   only when this batch moved the dot.

### Privacy projection (`services/presence.ts`)

The map endpoint and the websocket both go through `projectPresence()`, which
decides what _this viewer_ may see of _that member_:

- `paused` → coordinates, battery, activity all `null`
- `approximate` → position snapped to a deterministic 750 m grid, accuracy
  widened to ≥750 m, `recordedAt` floored to five minutes, speed/heading/activity
  hidden, history and trips refused
- _Share my location_ switched off on the phone, as its last health report
  says and no newer fix contradicts → `paused` in a circle that allows
  pausing. A circle that does not keeps the last position, and `issues`
  starts with `sharing_off`
- viewer looking at themselves → always exact

`stale` is a fix older than 15 minutes, or 35 for a phone whose last fix said
`still`, since an iPhone sitting still may answer only a few pings an hour and
a shorter line faded healthy phones in and out.

Because the projection is per viewer, the bus carries the unprojected row and
the websocket layer projects it on each socket. Only a socket whose projection
is precise passes the batch's `fixes` on. Any socket sends a frame only when
its projection changed, and for an approximate viewer that means a new cell
or a new five minutes, so a fix a second while somebody else watches can't
time each step across a grid line.

### Realtime

`lib/bus.ts` is an in-process EventEmitter by default and a Redis pub/sub when
`REDIS_URL` is set. `/api/v1/ws` authenticates with the same JWT (header or
`?access_token=`), primes the client with current presence, then forwards
`location` / `event` / `sos` frames for the circles the user belongs to, and
`nudge` / `control` frames addressed to the user. Heartbeat every 30 s, or
every 2 minutes on a control channel. The app's own `ping` frame is answered
with a `pong`, which is how the app finds a socket that is open on paper only.

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
something from a phone, it calls `sendControl()` first: the ping, the fresh
fix asked for when someone opens the map or a member's page, and Live's
watch. That publishes a `control` frame on the user's bus topic, and whichever
replica holds the socket passes it on. Each frame carries an `ask` id, and the
phone answers `{type:"control", ack}` the moment it lands. Live's watch and a
member's page wait up to 3 s for that answer and push at once without it, so
a socket iOS suspended with the app costs seconds rather than the minute until
the next hold. Otherwise only when no channel is open, its stamp is over five
minutes old, or an earlier ask went unanswered for 20 seconds does the server
fall back to a silent push, which needs the `expo` provider. A `watch` with no
seconds left ends the window, which is how a phone hears that the last viewer
left.

A phone holds the channel only while somebody has the app open, and an
iPhone also for the length of a Live window, whose location session keeps the
app alive. Any other phone is reached by silent push alone, so on a server
with no `expo` provider a phone with Hearth closed can't be asked anything.

### Push (`services/push.ts`)

`enqueuePush()` writes rows to `notification_outbox` inside the caller's
transaction. A trigger on that table raises `NOTIFY hearth_outbox`, which
Postgres delivers only when the transaction commits, and every replica
listens for it and drains straight away. After each pass the drain sets a
timer for the earliest row still waiting, so a row held back for a moment or
a retry goes when it falls due rather than on the next tick. Each replica
keeps its own timer, and the scheduler wakes the drain once on boot, so a
restart picks up whatever was waiting. The drain claims pending rows with
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, the `sos` channel
first and then high priority, which is safe across several API replicas and
against an admin "flush now",
and sends them through the configured `PushDriver` (`none` / `expo` / `ntfy` /
`webpush`) 8 at a time. Claims take turns under an advisory lock, and a row
waits while a sibling for the same recipient and card is still sending, so two
drains never build one card twice. Before sending, it drops a row whose
recipient has left the circle, place news about somebody who no longer
shares precisely with it, and a `device_offline` row whose phone has been heard
since the row was queued (`services/outbox-visibility.ts`). Anything due in
the recipient's quiet hours is moved to when they end, or skipped, as they
chose, except an SOS, its all clear, a possible crash and a test the person
asked for. A departure still waiting when an
arrival elsewhere goes out is skipped, since the arrival names where they came
from. Place news carries the parts it is worded from (`data.wording`, kept off
the phone's payload), and the drain words it again for the recipient, in their
units, with the time on their clock once it is more than 2 minutes late
(`services/place-news.ts`). Each provider call
gets 15 s. A failed send is retried with back-off, and after 6 attempts the row
is marked `failed`. A row on the `sos` channel is the exception. It retries
every 10 s to 3 min, a `sos_started` until the drain drops it as resolved, and
anything else on the channel, a `possible_incident`, for an hour. A
`sos_started` whose alert is resolved or gone is dropped, and so is a
`possible_incident` whose person no longer shares precisely with the circle
or has a newer fix, 250 m or sharper, over 300 m from the stop
(`incidentsMovedOn`). A silent `wake` that ends `failed` takes itself off
`wake_count`, so a wake that never got out is not an unanswered one. A driver
reports a 4xx other than 408 or 429 as `rejected`, and a rejected SOS gets the
ordinary 6 attempts. Every Expo ticket is kept in `push_tickets` with the
session and the token it went to, for the receipt step below. A send that
could not reach the provider at all (no answer, a thrown fetch, a 5xx) marks
the process's `pushProviderFailedSince()`, which the offline sweep reads. The
scheduler tick still drains,
for those retries, dead-token cleanup, and re-queueing of rows a crashed
replica left in `sending`. See [push notifications](../install/push-notifications.md).

News about one person shares a notification (`services/notification-groups.ts`).
A row can carry a group key, `outing:`, `messages:` or `phone:` plus the
person's id, with a title and a one-line version of itself. Through `expo` the
drain builds one card from every due row of the same recipient and key
(`composeCard`), so a backlog lands as one buzz. The card continues the
recipient's thread (two quiet hours start a new one), lists its lines newest
first, and goes out under a `collapseId` on iOS and a `tag` on Android, so the
phone replaces the card it shows. The rows a card carries are sent or retried
together. Android gets no collapse id,
because FCM keeps only four collapse keys for an offline phone. Earlier lines
pass the same membership and sharing checks as the row itself. A line the card
already shows, arriving through a second circle, is skipped. Other providers
send each row's standalone title and body. Every visible push asks Expo for
the default sound, since Android's channels play one for every notification
and a card update is always a new line of news. An SOS still queued after it was
resolved is dropped, so a late retry can't sound the alarm again.

A silent push (`silent: true`, the `wake` and `watch` rows) can only go through
`expo`, and the drain marks it `skipped` for any other provider. It carries a
lifetime, a `ttl` and `expiration` of 300 s for a watch or a wake. A watch only
goes by push when the channel did not take it, often to an iPhone app iOS
has to start again, and one that lands after the viewer left is ended by the
phone's first upload reply.
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
2. Read Expo receipts, at most once a quarter hour, through the driver's
   `readReceipts`. Tickets at least 30 minutes old go to
   `POST /--/api/v2/push/getReceipts` 1 000 at a time, up to five calls a pass.
   A `DeviceNotRegistered` receipt clears the session's token if it still holds
   the token the push went to. Read tickets are deleted, a pass stops at the
   first call that leaves some unanswered or fails, and tickets over a day old
   are deleted in 5 000-row batches.
3. Lapse expired pauses, restoring whatever mode each member had before.
4. Ping every phone (`wakeQuietPhones`). A phone keeps no location request
   of its own between Live windows, so this is its heartbeat. Each phone is
   asked for one fix on the interval of the strictest circle it is in
   (`pingIntervalMs` in `services/reporting.ts`). A circle with no interval
   set, or one that is not a number, counts as the 300 s default, and the
   result is held between two minutes (`PING_MIN_INTERVAL_MS`) and ten
   (`PING_MAX_INTERVAL_MS`) whatever a circle says. Past ten, a phone on the
   move would cross the 15 minute stale line between one ask and the next.
   The upload reply's `policy` carries the same clamped interval
   (`pingIntervalSeconds`). A phone in no circle is not asked, since nobody
   could see its fix, and nor is one whose health report says sharing is
   switched off and that has sent no fix since. A phone whose last fix said
   it was walking, running, cycling or driving is asked a little sooner, on
   `PING_MOVING_INTERVAL_SECONDS` (120 by default, from 120 to 600, and never
   later than its circle's interval). The first ask is measured from when the
   phone was last heard, `greatest(recorded_at, last_heard_at)`, and each one
   after from the ask before (`pingDueAt`), most overdue first.
   `wake_count` counts the asks and resets when the phone uploads anything at
   all. After 12 unanswered asks a phone is asked every 30 minutes, and after
   60 every three hours, for as long as it stays signed in, so a phone that
   was only flat comes back. Each ask goes down the control channel when one
   is open, and otherwise as a silent push if the provider is `expo`, marked
   `ping: true` either way, so the phone can answer the schedule with its last
   fix when its motion classifier has had it still. An ask
   goes on the first tick after it falls due, so with the default tick of a
   minute a five minute interval comes out at five to six. The circle route
   takes an interval from 10 s to 3600 s and stores it clamped to 120 to 600,
   so an app from before the ping offering half a minute or an hour is not
   refused with a 4xx. Migration `0015_ping_interval` moved stored intervals
   under 120 s, or that were not a number, to 300, and those over 600 to 600.
5. Flag offline devices, over 1 h silent, 12 h for a parked phone, or 100
   minutes for a parked phone on an account signed in only on Android phones,
   since Android answers a ping even from Doze (`silentPastCutoff` in
   `services/reporting.ts`). Parked
   means the last fix said "still", or the member is inside a named place, or
   the last fix measured under 1 m/s with an accuracy of 250 m or better. A
   phone the server can push is only called offline once three asks have gone
   unanswered, which is two not counting the newest, since that one may have
   gone out in the same tick. A phone that can't be pushed at all, with no
   token or on a provider other than `expo`, is judged on its silence alone,
   as before. Each circle hears it once per
   outage, with the reason when the phone's own health report gave one, or
   that the battery likely ran out when the last fix was on 5% or less and
   not charging. A circle the member paused,
   or one that allows pausing when the member switched sharing off on the
   phone, hears nothing. The step is withheld entirely when the push provider
   could not be reached in the last 30 minutes, when a server with fewer than
   eight phones counting has at least two not yet announced and none fresh,
   or when at least eight phones count and more of them are quiet than
   reporting. Each of those means the outage was the server's. Holding writes
   the `offline_alerts_held` row of `server_settings`, and the step stays
   withheld for 30 minutes after it, so the first phone back does not expose
   the rest. Each phone is checked again under its lock before it is
   announced. The member is asked once an outage, on every device they are
   signed in on, to open Hearth, since an app the phone stopped comes back
   only when somebody opens it. That push lapses after an hour, and a phone
   whose battery ran out is not asked.
6. Announce returned devices. A circle that was told a phone went quiet gets a
   `device_online` feed line once it reports again. Whoever was sent that
   `device_offline` row, or has it still sending, and does not mute it now
   gets a push on the `alerts` channel in the phone's card.
7. Detect trips, paged over users with a fix in the last 6 hours, one advisory
   lock per user so replicas never double-detect.
8. Prune history: per-circle retention under the server-wide ceiling, in
   5 000-row batches and at most 20 per user per tick, so a big sweep never
   holds locks for minutes.
9. Prune sent, skipped and failed outbox rows after 7 days, in 5 000-row
   batches and at most 20 a pass. A pending row, such as an SOS still being
   retried, is never pruned, nor a `device_offline` row whose phone is still
   in that outage, since it is the list of who to tell when it returns.
10. Prune sessions that have expired, or were revoked over 30 days ago.

The sweep reads the ceiling from `server_settings` on every tick, falling back to
`MAX_HISTORY_RETENTION_DAYS`. Reading the env value instead was the bug: changing
the cap from the app stored a number that then swept nothing. `server-info`
publishes the same ceiling as `maxHistoryRetentionDays`, and creating or
updating a circle stores a longer retention as the ceiling.

### Trip detection (`services/trips.ts`)

Breadcrumbs newer than the per-user watermark and older than the idle gap
(5 min) are split wherever the gap between fixes exceeds 5 min, or wherever
the phone stayed inside 100 m for longer than that. Fixes with source
`heartbeat` are skipped. Only an app from before 1.3.4 sends them, from a
parked phone with the app open, and they would keep a finished drive from
closing. So are network estimates worse than 100 m: one
of them between two fixes at home is otherwise a trip there and back. A gap
is not a split when the fix after it shows the phone travelled through it. A segment with ≥3 points,
≥2 min, ≥250 m of path and real displacement (150 m from where it started)
becomes a `trip`, and its points are tagged with the trip id. A trip names
its ends from the fence's own records in each circle, the first departure
during it and the last arrival it did not leave again, so a trip can never
name a place the arrival did not. A start the fence never saw them leave is
named by `placeAt`, the rule every reader uses, which takes the smallest place
containing the point and then the nearest centre. A trip that ends at a named place goes to
the feed only, because the arrival already carried the journey. One that ends
anywhere else sends one push, "Aisha stopped 4.2 km from Home", up to 30
minutes after it ended.

A journey between two named places is a trip whatever its length, because
the feed has already announced "left" and "arrived" for it. Outside Live the
phone reports only at each ping, so such a journey often reaches the server as
one fix at the origin, a silence, and a fix inside the destination: that
silence, up to 45 minutes, is read as the journey, and the trip starts at the
last fix at the origin. Any other drive outside Live is a few fixes minutes
apart, and a short one may not make a trip at all.

## Mobile app

Ignite conventions with a few deliberate substitutions:

| Concern             | Choice                                                                               | Why                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server state        | TanStack Query                                                                       | cache is written directly by the websocket                                                                                                                                                                                                                                                                                              |
| Client state        | zustand + MMKV                                                                       | synchronous hydration, no flash of empty UI                                                                                                                                                                                                                                                                                             |
| Secrets             | expo-secure-store (`stores/tokenVault.ts`)                                           | refresh tokens never touch MMKV                                                                                                                                                                                                                                                                                                         |
| Map                 | MapLibre RN + OpenFreeMap style                                                      | no Google key, swappable to self-hosted tiles                                                                                                                                                                                                                                                                                           |
| Background location | silent push, then expo-location on iOS and a native service on Android               | the server's ping wakes the app on iOS for its last fix again or one `getCurrentPositionAsync`, and Live and a drive run `startLocationUpdatesAsync` for their length. On Android the push handler in `modules/hearth-motion` answers both, with `HearthTrackingService` or with the last fix, and uploads natively, with no JavaScript |
| Periodic sync       | expo-background-task                                                                 | flushes the offline queue when the OS allows, and takes a fix when the pings have stopped arriving                                                                                                                                                                                                                                      |
| Motion class        | `modules/hearth-motion`, over Core Motion / Play Services activity transitions       | costs no location, so a still phone answers a ping with no fix of its own, and a drive can start crash detection                                                                                                                                                                                                                        |
| Crash sensing       | `modules/hearth-motion` (expo-sensors as fallback) + `packages/shared/src/impact.ts` | runs on a drive where a circle wants crash alerts. Native batched sampling that keeps going with the screen off, and a verdict testable against recorded traces, off the device                                                                                                                                                         |

### Location pipeline on the phone (`services/location/tracker.ts`)

OS fix → `toFix()` (adds battery and the activity label) → `thin()` (drops
near-duplicates on Live) → `useTrackingStore.enqueue()` (MMKV-persisted queue,
capped at 2000) → `flush()` (single-flight, oldest first, 200 per batch).
Network failures keep the queue. A 4xx validation error drops the poison
batch, and the next batch waits on the retry ladder, since a firewall in front
of the server may lock the phone out for a 4xx. A 403 from Hearth itself stops
sharing until the next sign-in. The server's response carries the tracking
policy, and the phone keeps its interval for the foreground heartbeat and the
sync task.

The phone takes its location when somebody asks. The first ask is the ping,
the server's on the circle's interval (background jobs, step 4). The motion
classifier, Play Services' activity transitions on Android and Core Motion's
history on iOS, costs no location and says whether the phone has moved since
its last real fix. A phone it has had still, for under an hour, answers with
that fix again, stamped now and labelled `still`, and turns no location on.
One that moved answers with one `Balanced` fix, Wi-Fi and cell with no GPS. On
Android the push handler in `modules/hearth-motion` answers it natively, with
the last fix or a foreground service up for the seconds the fix takes, and the
session's upload key, and JavaScript is not started. On iOS the silent push
wakes the app for it. A foreground heartbeat answers the same way on the same
interval while the app is open, and the background sync task takes a fix when
the last one is over two intervals old. An ask somebody made, a page opened
or a nudge, always takes a fresh fix. Each fix is labelled with the
classifier's verdict, or failing that from a measured speed or the fix before
it. Moving turns on no tracking, and nothing runs between asks, so the
location indicator stays off at home. The cost is that an iPhone answers only
the pings iOS delivers, that places and trips can be up to one interval
behind, that a departure the classifier missed waits up to an hour for the
next real fix, and that a drive outside Live is a fix every couple of minutes.

The one exception is a drive, where a circle wants crash alerts. On Android
the classifier's in-vehicle transition starts the service on the GPS every
five seconds, with a headless task held open for the detector. On iOS a ping
that finds Core Motion had the phone in a moving vehicle in the last three
minutes starts a `High` accuracy session and Core Motion's live updates. The
drive's fixes stay on the phone for the detector, and a ping during it is
answered with the drive's latest fix. It ends when the classifier has the
phone out of the vehicle, after ten minutes standing, or when crash alerts or
sharing go off.

The second ask is Live, offered for anyone the viewer sees precisely. It runs at
full accuracy and a fix a second, for as long as the page is open and at most
ten minutes past its last hold. Each viewer holds the window on their own. It ends
within seconds of the last one leaving, through the next upload reply and the
control channel, and when the member turns that circle to approximate or
pauses it. A hold on a window already live only moves its end. While live, a
stuck upload gets 4 s before it goes again on a fresh request, and a failed
one waits 2, 5, then 10 s with every fix kept, rather than trying again on
every fix. On Android the watch push brings the service and its notification
up for the window, the service follows the server's `watchedUntil` in each
upload reply, and both go when it ends. If Android refuses the service the
phone answers with one fix. On iOS a location session with no distance filter
runs for the window only.

`reportNow(source)` takes an immediate fix, at high accuracy for a check-in
and the highest for an SOS (once before the alert is sent, and every 20 s on
the SOS screen of a phone that is not on Live), and at `Balanced` for a
_nudge_ arriving over the websocket. While its owner has an SOS open the
phone is on Live for half an hour from when the alert was raised or last
pressed again (`SOS_LIVE_FOR_MS`, `sos_alerts.live_from`). Every upload reply
in that time names a two minute `watchedUntil` (`liveUntil` in
`services/sos.ts`), and the raise sends a watch down the control channel.

### Realtime on the phone (`services/realtime.ts`)

One socket while foregrounded, torn down in the background but not when the
app is only inactive under Control Centre, exponential reconnect, and every
message but a nudge is written into the React Query cache. It pings every
25 s, or every 5 s while a Live page is open, and replaces a socket that
doesn't answer within 10 s, or 4 s. Presence is merged by `recordedAt`, so a
poll answered after a newer frame can't step a dot back. A frame's `fixes` go
to an open Live page's trail, which fills its gaps from `GET .../live-trail`
after a reconnect or a return to the front. The map and the Live page say
they're reconnecting once the socket has been down for 5 s. A nudge goes to
its own store and makes the phone report at once.
Screens just render query data. The control channel
(`services/location/control.ts`) is a separate socket the tracker holds while
the app is open, and on an iPhone during Live, as described above.

## Admin portal (`apps/admin`)

A React app, bundled by esbuild into a handful of static files that the server
serves at its own address with `@fastify/static` (`plugins/portal.ts`).
Any other browser route outside `/api` gets the page, so a bookmark to
`/accounts` works. The image builds it and carries the files beside the server,
and a server run from source finds `apps/admin/dist` in the workspace.
`ENABLE_ADMIN_PORTAL=false` serves nothing.

Hearth can sit at a path, and the path is the one in `PUBLIC_URL`. Fastify's
`rewriteUrl` takes it off any request that carries it, before routing, so a
proxy that strips the path and one that passes it on reach the same routes,
the websocket included. The page is the one file not sent as built. It names
its files relative to a `<base>` the server writes into it, beside a
`hearth-base` meta tag. The portal reads the path from the meta, since its
policy allows no inline script, and puts it in front of its API calls and its
own addresses. The refresh cookie's `Path` carries it too, because the browser
matches the cookie against the address it sees.

It is same-origin with the API in development too: run the server, run
`pnpm --filter @hearth/admin dev` for a watch build, and open
`http://localhost:4000`. Everything it does goes through the admin API, so the
app's admin screen and the portal stay in step.

The access token lives in memory. The refresh token is an `HttpOnly`,
`SameSite=Strict` cookie scoped to the portal's session routes
(`modules/portal.routes.ts`), and a 401 that
means the token ran out renews it once for every call waiting on it, one tab at
a time. The session ends twelve hours after sign-in and renewing does not
extend it. Swagger UI shares the origin, so it is served with its own content
policy. Its pages carry a
Content-Security-Policy that allows `'self'` and nothing else, and
`frame-ancestors 'none'`. It never shows a position: the circles list names
members and settings only, and notification text is the administrator's own.

The overview is a dashboard built from `GET /admin/overview?tz=`, which counts
fixes, active accounts and notifications per day in the viewer's time zone and
lists each account's phone (`services/admin-overview.ts`). The fixes are
counted person by person, so each count is a range over the `(user_id,
recorded_at)` index rather than a scan of the whole table. The charts are
plain SVG and CSS, so the page still loads nothing from anywhere else.

## Security model, briefly

- Access tokens: 15 min, HS256, `{sub, sid}`. The admin flag is read from the
  database per request. Refresh: 60 days, rotated on every use, SHA-256 at
  rest. A spent one presented again is refused, and ends the session if it
  comes more than 30 s after the rotation. The same device gets one retry,
  answered with a fresh pair, within the access token's lifetime or at any
  time while no token issued after the spent one has been used. That is a
  phone whose renewal answer was lost. A thief shows once the phone has used
  the token that replaced the stolen one.
- Upload keys: an Android session's native tracker answers pings and Live with
  `hk1.<session id>.<HMAC>` (`services/uploadKey.ts`), keyed from the JWT
  secret. It opens `POST /locations/batch` and no other route, carries no
  admin rights, has its own rate-limit bucket, and is worth nothing once the
  session is revoked or the account deactivated, since the session row is
  read on every request.
- Passwords: scrypt N=2¹⁵ via `node:crypto`. Login timing is equalised for
  unknown emails.
- Authorisation is always "is the caller a member of this circle with role ≥ X",
  computed from the database per request, never from the token.
- SOS switches a paused sharing state back to precise, in every circle it is
  raised in, and leaves it there.
  Nothing else overrides sharing. Mutes, per-place choices and muting a
  person apply only to the alert types a member may silence
  (`MUTABLE_EVENT_TYPES`), and quiet hours to everything but the safety
  alerts, so an SOS or a possible crash always gets through.
- Invite codes: 8 chars, Crockford base32, rejection-sampled, single
  conditional `UPDATE` to claim a seat.

See [privacy](../privacy.md) for what is stored and for how long.
