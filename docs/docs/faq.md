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

The store builds are built and tested and waiting on App Store and Play Store
review. Until they're out you build it yourself, and push only fully works in a
build you make yourself anyway, as the next answer explains. The app uses native
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
- `expo`: your own Expo account, your own Firebase project for Android, and a
  paid Apple Developer account for the iOS push key. Every push to a build goes
  out under the keys it was built with, so the store builds can't carry the
  maintainer's, and push only fully works in a build you make yourself with
  yours. [Push notifications](install/push-notifications.md) has the details.

How you sign and install a build on your own iPhone is governed by Apple's
rules, not by anything Hearth does, so budget for that separately.

## Does it work at home with no internet?

Almost entirely. The API, Postgres, object storage, the websocket, geofences,
trips, nudges and SOS are all local to your box, and phones on the same
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
- A parked phone in the background is in stationary mode and takes one cheap
  fix a quarter of an hour, so the queue barely grows while nothing is
  happening. With the app open it takes one at the circle's interval, to keep
  your own row fresh.

The background sync task also flushes the queue whenever the OS grants it time,
and takes a fresh fix if the last one is over 15 minutes old.

While the server is down nobody can see anybody, and after 15 minutes without a
fix everyone shows as stale. The job that alerts on a phone going quiet holds
its alerts back when at least eight phones count and most of them have gone
quiet at once, on the grounds that a simultaneous outage is the server's fault
rather than everyone's, so a reboot does not send the family an alert each.

## How much battery does it use?

The honest answer is that it depends on how much the phone moves, because the
GPS is what costs, and nobody has published a measured comparison yet.

What the code does to keep it down is worth understanding, because it is most of
the answer. The tracker has two states. **Moving** means continuous OS location
updates, and on Android that is a foreground service with a notification. It
stays out of the status bar and sits in the silent part of the shade, and
Android 13 and later let you swipe it away. Once the phone has stayed inside a
90 metre circle for five minutes it switches to **stationary**: the GPS goes
off, the service and its notification go with it, and an exit geofence is
armed around where it stopped, 150 metres on Android and 200 on iOS. On
Android a Wi-Fi grade request stays, which the OS answers a few times an hour.
An iPhone keeps a cell-only location session, which costs almost nothing and
keeps the app alive to report once a quarter of an hour. That 90 metres is one
and a half times the distance filter and never less than 60, so a circle that
asks for coarser updates waits out a wider stop. Leaving the geofence puts it
back into moving. So a phone sitting in a house overnight is costing you a few
cheap fixes an hour, not a GPS. A parked phone is expected to be quiet, so the
server only calls it offline after twelve hours of silence. A phone last seen
moving is reported after an hour, and the server asks it for a fix before
that. A phone that has told the server why it cannot report, a permission not
set to Always, Location Services off, is shown as that under its name instead.
Opening the map asks anyone quiet for a couple of minutes for a fresh fix, and
opening somebody's page asks their phone for one too. Live, offered while
somebody is on the move, has their phone send a fix a second for ten minutes.

Three other things affect it:

- **Your circles.** The update policy is the strictest of every circle you are
  in, defaulting to one fix per 30 seconds or 60 metres. One circle asking for
  fast updates makes every phone in it report fast.
- **The motion permission.** Motion and Fitness on iOS, or physical activity
  on Android, asked for during setup. With it granted the OS classifier calls a
  stop sooner than the position watch can and ends one the instant you move,
  which saves GPS. Refused, the phone works it out from position and spends
  more battery doing so. The server receives the same fixes either way.
- **Crash detection**, which samples the accelerometer hard. It runs only when
  a circle you are in has incident alerts on, and only while the OS says you are
  in a vehicle.

The single biggest cause of background location dying on Android is the battery
optimiser, which is why the app asks for an exemption during setup.

## My family member's phone keeps going quiet on Android

Almost always the phone closed Hearth to save battery, and the family is
looking at the last position it sent before that. Android does this to any
app that runs in the background, and several makers ship a power manager of
their own that does it sooner and without asking. Xiaomi, Redmi and POCO,
Huawei and Honor, OPPO, realme and OnePlus, vivo and iQOO, Samsung, Infinix,
Tecno and itel, and ASUS all need settings changed by hand. Pixels and most
Motorola phones do not.

Open Hearth on that phone and go to _You → Tracking status_. On those makes
there is a row, _Keep Hearth running in the background_, which opens a page
with that phone's steps and a button that takes you to the maker's own
settings. The same page shows whether background use is set to Restricted
and whether the battery optimiser still applies, which are the two things
Android will admit to. The short version, per maker:

- **Xiaomi, Redmi, POCO.** Manage apps > Hearth: Autostart on, Battery saver
  set to No restrictions. Lock Hearth's card in Recents.
- **Huawei, Honor.** Apps > Hearth > Battery > App launch: turn off Manage
  automatically and turn on all three switches under it.
- **OPPO, realme, OnePlus.** App management > Hearth > Battery usage: allow
  background activity and auto-launch. Battery optimisation: Don't optimise.
  Turn off Sleep standby optimisation.
- **vivo, iQOO.** Battery > Background power consumption management: allow
  Hearth. i Manager > App manager > Autostart manager: Hearth on.
- **Samsung.** Apps > Hearth > Battery: Unrestricted. Battery and device care >
  Battery > Background usage limits: turn off Put unused apps to sleep and add
  Hearth to Never sleeping apps.
- **Infinix, Tecno, itel.** Phone Master > Auto-start management: Hearth on.
  Phone Master > Power saving > App battery management: allow it in the
  background.
- **ASUS.** Mobile Manager > PowerMaster > Auto-start manager: allow Hearth.
  Battery-saving options: turn off Clean up in suspend.
- **Everything else.** Settings > Apps > Hearth > Battery: Unrestricted, and
  leave Battery Saver off or exempt Hearth from it.

The wording moves around between versions, and some of these settings switch
themselves back after a system update. When a phone goes quiet again, the
first thing to do is open the same page and check.

The phone reports its own state to the server, so a member whose phone has
said that Battery Saver is on, that background use is Restricted, or that the
location service was stopped is shown as that under their name rather than as
offline. A phone that was closed outright cannot report anything until
somebody opens Hearth on it again, and that is the one case nothing on the
server can help with.

## Does any location data leave my server?

Coordinates never leave it.

Apart from its own object storage, your server makes one kind of outbound
connection, and only if you configured it: to the push provider. Push payloads
carry a title, a body and identifiers such as `type`, `circleId` and `eventId`.
The title and body can name a person and a place, but never a position. The
phone fetches the actual location from your server when the notification is
tapped.

The phone itself requests map tiles from the style URL your server advertises,
so that host sees roughly which area is being viewed, as it would with any map.
Self-host tiles and that goes too.

There is no analytics, no crash reporting and no advertising or tracking SDK
anywhere in the server or the app. Set `PUSH_PROVIDER=ntfy` against your own
ntfy instance and host your own tiles, and nothing leaves your infrastructure
except, for iPhones, the poll request ntfy passes through its public server to
APNs, which carries a message id and no content.
[Privacy](privacy.md) has the full table of what is stored and who can see it.

## Why are push notifications the awkward part?

Because waking a phone that is asleep in someone's pocket is a hop that belongs
to Apple and Google, and no amount of self-hosting changes that.

Hearth's answer is to make push optional. The default, `PUSH_PROVIDER=none`,
needs no configuration: the app holds a websocket while it is open, so the map
and feed update live, it polls presence every 60 seconds as a fallback in case
that socket is dead, and an active SOS shows as a banner on the circle's map.
What you lose is alerts while the phone is locked.

When you want more, `ntfy` is the fully self-hosted route. It carries alerts
only and never wakes the Hearth app. `expo` is the zero-infrastructure one and
the only provider that can wake the app, but it only fully works in a build you
make yourself with your own Expo project, Firebase project and Apple developer
account. The store builds can't carry personal push keys. A Hearth organisation
that would let them push for any server is on the [roadmap](roadmap.md) and
needs funding.

Whichever you pick, events are written to an outbox table in the same
transaction as the thing that caused them and drained by a background worker
with back-off, so a broken push provider delays notifications rather than
dropping them at the first failure. A send that keeps failing is tried six
times over about an hour and twenty minutes before it is given up.
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
  and notifies everyone regardless of mutes. Resolving it does not put the
  pause back. See [safety](safety.md).

A pause can carry an expiry. It lapses on read, and a background job restores
whatever mode you were in before pausing rather than defaulting you to precise.
A circle owner or admin can turn pausing off entirely, and that setting is
visible to every member.

## Can a circle admin see more than an ordinary member?

No. Roles govern circle management, nothing else. The code that projects
someone's position for a viewer never looks at the viewer's role, so an owner,
an admin and a new member all see exactly what your sharing mode allows. You
always see yourself precisely.

## How much history is kept?

Each circle sets its own window, 30 days out of the box. A user's breadcrumbs
live as long as the most generous circle they belong to asks for, under a
server-wide ceiling: `MAX_HISTORY_RETENTION_DAYS`, 90 by default. Set a circle's
retention to 0 and that circle sees only the live position. The breadcrumbs
themselves go once every circle the member is in is at 0.

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

`DELETE /api/v1/me` needs the account's password and is irreversible. The rows
that belong to you cascade from `users.id`, so breadcrumbs, trips, SOS alerts,
check-ins, place history, sessions and queued notifications all go with it.
Rows that only credit you, like who created a place or wrote a feed line, lose
the link to your account instead. A feed line keeps the text it was written
with, which usually names you. [Privacy](privacy.md) lists them.

Circles need a decision, so the code makes one. A circle you solely own is
deleted with you. A circle with other members survives and ownership transfers
to the longest-standing admin, falling back to the longest-standing member.

A profile picture already in object storage outlives the cascade too, because a
database cascade cannot reach a bucket. Nothing points at it any more and its
key is random, but anyone who already has its link can still load it until the
operator deletes the object.

Two lighter options exist. `DELETE /api/v1/me/history` erases your breadcrumbs
and the trips made from them and keeps the account, and `GET /api/v1/me/export`
returns your profile, circles, breadcrumbs, trips, check-ins and the places you
created as JSON. Both are in the app under _You → Privacy & data_.

An admin can activate, deactivate or promote an account from the app or the
admin portal, but cannot delete one. Deactivating revokes that account's
sessions immediately.

## Somebody forgot their password. What do I do?

An administrator sets a new one. Open the server's address in a browser, sign in
to the admin portal, find the account under Accounts and choose _Set a new
password_. The portal asks for your own password first. Every device on that
account is signed out, and you tell them the new password yourself. The server
has no mail dependency at all, so there is no reset link, and the audit log
records that the password was set, never what it was.

If the forgotten password is the only administrator's, an operator with database
access has to replace that row's scrypt hash by hand, which is one reason to make
a second person an administrator.

## How many phones can one server handle?

More than a household needs. One API replica is comfortably enough for a family
several times over, which is why nothing about the default setup is clustered.

If you do want replicas, Redis carries realtime events between them. The
repository ships `docker-compose.redis.yml` as an overlay, and it unpublishes
the `api` host port for you, since only one replica could bind it. Your reverse
proxy routes to the `api` service on the compose network instead.

Postgres is stock. Coordinates are plain double precision columns and there is
no PostGIS extension to install, so Postgres 14 or newer is the only
requirement. [Self-hosting](install/self-hosting.md) covers backups, upgrades
and the health endpoints to point an uptime check at.
