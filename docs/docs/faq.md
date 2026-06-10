---
sidebar_position: 3
title: FAQ
---

Questions that come up before and just after somebody sets Hearth up. Each
answer describes what the code actually does today, not what is planned.

## What does it cost to run?

There is no per-user fee and no subscription. Hearth is AGPL-3.0 and the server
is a Docker image you run yourself.

The real costs are the box and the name. A Raspberry Pi 4 or the smallest VPS
you can rent handles a family. Location updates are a few hundred bytes every 30
to 60 seconds per phone, so bandwidth is not what runs out. Disk is the thing to
watch: measured over 200,000 rows, one stored fix costs about 340 bytes with its
indexes, which works out at roughly 14 MB per phone at the default 30 day
retention, or about 170 MB a year per phone with retention switched off
entirely.

Map tiles come from OpenFreeMap by default, which needs no API key. Push costs
nothing on the default setting, because the default is no push provider at all.
The one recurring bill most people end up with is a domain name, and
[remote access](install/remote-access.md) covers the ways to avoid even that.

## Does it work on iPhone and Android?

Both. The app is Expo SDK 55 and React Native 0.83, and the same codebase builds
for each.

It is not on either store yet, so you build it yourself. The app uses native
modules for the map, background location and secure storage, which means Expo Go
will not run it and you need a development build:

```bash
pnpm install
cd apps/mobile
npx expo prebuild
npx expo run:ios        # or run:android
```

`supportsTablet` is false, so this is a phone app. [The mobile
page](developer/mobile.md) has the full build story, including the rules about
plain-HTTP servers on a LAN, which differ per platform and tend to surprise
people at release time.

## Do I need an Apple or Google developer account?

The server needs no relationship with either company. It boots, runs and serves
phones with no vendor account anywhere.

For the app, it depends only on which push provider you choose:

- `none` (the default) and `ntfy`: no vendor account.
- `expo`: a free Expo account, for the project id that `eas init` writes into
  `app.json`.
- Direct APNs, which is not implemented in v1: a paid Apple Developer account
  for the `.p8` key, plus a Firebase project for FCM.

How you sign and install a build on your own iPhone is governed by Apple's
rules, not by anything Hearth does, so budget for that separately.

## Does it work at home with no internet?

Almost entirely. The API, Postgres, object storage, the websocket, geofences,
trips, messages and SOS are all local to your box, and phones on the same
network reach it directly.

Two things reach outside, and neither is required:

- **Map tiles.** The phone fetches them from the style URL your server
  advertises, OpenFreeMap out of the box. With no internet the map data is still
  correct but the background will not draw. Point `MAP_STYLE_URL` at your own
  tile server to fix that permanently. Offline map packs are on the
  [roadmap](roadmap.md) and are not built.
- **Push**, only if you configured a provider that is not on your network.

One catch on a LAN. A production Android build refuses plain HTTP outright, and
a production iOS build allows it only to private address ranges. Building with
`HEARTH_ALLOW_HTTP=1` lifts that, and putting TLS in front of the server makes
the question go away.

## My server goes down. Does the phone lose those positions?

No. Fixes go into a queue in `apps/mobile/app/stores/tracking.ts` that is
persisted to MMKV, so it survives the app being killed or the phone restarting.

The details worth knowing:

- The queue holds 2,000 fixes. Past that the newest are kept and the oldest are
  dropped.
- Uploads are single-flight, oldest first, up to 200 fixes per request.
- A network error, a 5xx or a 429 leaves the batch in the queue for the next
  attempt. A 4xx that is not an auth failure drops that batch, so one malformed
  fix cannot wedge the pipeline forever.
- The server ignores duplicates by device and timestamp, so a retried upload is
  safe.
- A parked phone is in stationary mode and takes no fixes at all, so the queue
  does not fill while nothing is happening.

The background sync task also flushes the queue whenever the OS grants it time,
and takes a fresh fix if the last one is over 30 minutes old.

While the server is down nobody can see anybody, and after 15 minutes without a
fix everyone shows as stale. The job that alerts on a phone going quiet skips
its whole tick when at least four phones are reporting and more than half of
them went silent at once, on the grounds that a simultaneous outage is the
server's fault rather than everyone's, so a reboot does not send the family an
alert each.

## How much battery does it use?

The honest answer is that it depends on how much the phone moves, because the
GPS is what costs, and nobody has published a measured comparison yet.

What the code does to keep it down is worth understanding, because it is most of
the answer. The tracker has two states. **Moving** means continuous OS location
updates, and on Android that is a foreground service with a notification you
cannot dismiss. Once the phone has stayed inside a 60 metre circle for five
minutes it switches to **stationary**: updates stop, the notification
disappears, and a 150 metre exit geofence is armed around where it stopped.
Leaving that circle puts it back into moving. So a phone sitting in a house
overnight is costing you a geofence, not a GPS.

Three other things affect it:

- **Your circles.** The update policy is the strictest of every circle you are
  in, defaulting to one fix per 30 seconds or 60 metres. One circle asking for
  fast updates makes every phone in it report fast.
- **The motion setting.** _Use the phone's motion sensor_ is per device and off
  until you turn it on. It lets the OS classifier call a stop sooner than the
  position watch can, which saves GPS. The server receives the same fixes either
  way.
- **Crash detection**, which samples the accelerometer hard. It runs only when
  the circle has incident alerts on and the phone has the motion setting on, and
  only while the OS says you are in a vehicle.

The single biggest cause of background location dying on Android is the battery
optimiser, which is why the app asks for an exemption during setup.

## Does any location data leave my server?

Coordinates never leave it.

Your server makes exactly one kind of outbound connection, and only if you
configured it: to the push provider. Push payloads carry a title, a body and
identifiers (`{type, circleId, eventId, placeId?, userId?}`), never a position.
The phone fetches the actual location from your server when the notification is
tapped.

The phone itself requests map tiles from the style URL your server advertises,
so that host sees roughly which area is being viewed, as it would with any map.
Self-host tiles and that goes too.

There is no analytics, no crash reporting and no third-party SDK anywhere in the
server or the app. Set `PUSH_PROVIDER=ntfy` against your own ntfy instance, host
your own tiles, and nothing at all leaves your infrastructure.
[Privacy](privacy.md) has the full table of what is stored and who can see it.

## Why are push notifications the awkward part?

Because waking a phone that is asleep in someone's pocket is a hop that belongs
to Apple and Google, and no amount of self-hosting changes that.

Hearth's answer is to make push optional. The default, `PUSH_PROVIDER=none`,
needs no configuration: the app holds a websocket while it is open, so the map
and feed update live, it polls presence every 60 seconds as a fallback in case
that socket is dead, and it shows arrivals and SOS as in-app banners. What you
lose is alerts while the phone is locked.

When you want more, `ntfy` is the fully self-hosted route, `expo` is the
zero-infrastructure one. Either way, alerts are never lost in transit: events
are written to an outbox table in the same transaction as the thing that caused
them and drained by a background worker with back-off, so a broken push provider
delays notifications rather than dropping them.
[Push notifications](install/push-notifications.md) compares all four options
properly.

## What actually happens when somebody pauses sharing?

Sharing is per circle, and there are three modes: precise, approximate and
paused.

Paused means that circle gets nothing. Coordinates come back null, and so do
battery, activity, the last-reported time and which place you are at. Members
see that you paused, which is deliberate: silent invisibility would be a
different feature. The history endpoint refuses outright for anybody who is not
currently sharing precisely.

Two behaviours surprise people:

- **The phone keeps uploading and the server keeps storing your breadcrumbs
  while you are paused.** Pausing hides you from a circle, it does not stop
  collection. To stop collection, turn off _Share my location_ on the phone,
  which stops the OS updates so nothing is captured or queued at all.
- **SOS overrides a pause.** Raising one switches you to precise in that circle
  for the duration and notifies everyone regardless of mutes. See
  [safety](safety.md).

A pause can carry an expiry. It lapses on read, and a background job restores
whatever mode you were in before pausing rather than defaulting you to precise.
A circle owner can turn pausing off entirely, and that setting is visible to
every member.

## Can a circle admin see more than an ordinary member?

No. Roles govern circle management, nothing else. The code that projects
someone's position for a viewer never looks at the viewer's role, so an owner,
an admin and a new member all see exactly what your sharing mode allows. You
always see yourself precisely.

## How much history is kept?

Each circle sets its own window, 30 days out of the box. A user's breadcrumbs
live as long as the most generous circle they belong to asks for, under a
server-wide ceiling: `MAX_HISTORY_RETENTION_DAYS`, 90 by default. Set a circle's
retention to 0 and only the live position is kept.

A circle never sees further back than its own retention, or than the day you
joined it, whichever is later. So accepting an invite does not hand a new circle
your last month.

Trips survive pruning, because they are stored as aggregates: distance,
duration, speeds and endpoints rather than the points they came from.

The prune job runs every `JOB_INTERVAL_SECONDS` (60 by default) in bounded
batches, so a large sweep does not lock the table for minutes.

One wrinkle. An admin can change the ceiling from the app, and once they have,
that stored value wins over the environment variable in both directions. Saving
any server setting in the app writes the whole set, so even renaming the server
pins whatever ceiling was in force at that moment. Clear the field in the app to
hand control back to `.env`.

## What happens to the data when an account is deleted?

`DELETE /api/v1/me` needs the account's password and is irreversible. Every
other table cascades from `users.id`, so breadcrumbs, places, trips, alerts,
messages, sessions and queued notifications all go with it.

Circles need a decision, so the code makes one. A circle you solely own is
deleted with you. A circle with other members survives and ownership transfers
to the longest-standing admin, falling back to the longest-standing member.

The one thing that outlives the cascade is a profile picture already in object
storage, because a database cascade cannot reach a bucket. Nothing points at it
any more and its key is random, so it is unreachable rather than exposed, but an
operator who wants it gone has to delete the object.

Two lighter options exist. `DELETE /api/v1/me/history` erases your breadcrumbs
and keeps the account, and `GET /api/v1/me/export` returns everything the server
holds about you as JSON. Both are in the app under _You, Privacy and data_.

An admin can activate, deactivate or promote an account from the app, but cannot
delete one. Deactivating revokes that account's sessions immediately.

## Somebody forgot their password. What do I do?

There is no answer you will like. v1 has no password reset flow. The server has
no mail dependency at all, so it cannot send a reset link even in principle, and
the admin API can activate, deactivate and promote an account but not reset its
password. Changing a password requires the current one.

Today, recovery means an operator with database access replacing that row's
scrypt hash by hand. Worth knowing before you invite people who will not
remember what they typed.

## How many phones can one server handle?

More than a household needs. One API replica is comfortably enough for a family
several times over, which is why nothing about the default setup is clustered.

If you do want replicas, Redis carries realtime events between them. The
repository ships `docker-compose.redis.yml` as an overlay, and you drop the
`ports:` mapping from the `api` service before scaling or the second replica
cannot bind port 4000.

Postgres is stock. Coordinates are plain double precision columns and there is
no PostGIS extension to install, so Postgres 14 or newer is the only
requirement. [Self-hosting](install/self-hosting.md) covers backups, upgrades
and the health endpoints to point an uptime check at.
