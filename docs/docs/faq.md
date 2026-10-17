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

Three things reach outside, and none is required.

- **Map tiles.** The phone fetches them from the style URL your server
  advertises, OpenFreeMap out of the box. With no internet the map data is still
  correct but the background will not draw. Point `MAP_STYLE_URL` and
  `MAP_STYLE_URL_DARK` at your own tile server to fix that for good. Offline map packs are on the
  [roadmap](roadmap.md) and are not built.
- **Street names.** The phone asks its own geocoder, Apple's or Google's, for
  the street under a member or a trip. With no internet the street is left out.
  _Street names_ under _You_ turns it off.
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
  fix cannot wedge the pipeline forever, and the next batch waits half a minute
  rather than going straight after it. A firewall that locks out an address
  after a failed request is the reason.
- The server ignores duplicates by device and timestamp, so a retried upload is
  safe.
- A parked phone in the background is in stationary mode and takes one cheap
  fix a quarter of an hour, so the queue barely grows while nothing is
  happening. With the app open it takes one at the circle's interval, to keep
  your own row fresh.

The background sync task also flushes the queue whenever the OS grants it time,
and takes a fresh fix if the last one is over 15 minutes old.

While the server is down nobody can see anybody, and after 15 minutes without a
fix everyone shows as stale, or after 35 for a phone that said it had parked,
since a parked phone only reports every quarter of an hour. The job that
alerts on a phone going quiet holds its alerts back when the outage looks like
the server's own. That is when it couldn't reach the push provider in the last
half hour, when a family-sized server has two or more phones and not one of
them is reporting, or when at least eight phones count and most of them have
gone quiet at once, and for half an hour after any of those last held, so the
other phones have time to get back through after the first. A simultaneous
outage is the server's fault rather than everyone's, so a reboot or a dead home
connection does not send the family an alert each. A server with a single
phone can't tell the difference, and still says when that phone goes quiet. An
alert held back by a push outage is dropped if the phone reports before it
goes out.

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
back into moving. A phone allowed only approximate location gets no geofence,
because neither Android nor iOS arms one for it, so it parks without one and
leaves on the classifier's word or on a fix far enough away to say so. The
member's page then says precise location is off. So a phone sitting in a house
overnight is costing you a few cheap fixes an hour, not a GPS. A parked iPhone
is expected to be quiet, because iOS holds back the silent pushes that would
wake it, so the server only calls it offline after twelve hours of silence. A
parked Android phone reports every quarter of an hour and answers those pushes,
so it is called offline once it has let three of them go, about 100 minutes
after it was last heard. A phone last seen
moving is reported after an hour, and the server asks it for a fix before
that. A phone that has told the server why it cannot report, a permission short
of Always, which Android calls Allow all the time, or Location Services off, is
shown as that under its name instead.
One that went quiet on 5% battery or less is shown, and reported, as having
most likely run out.
Opening the map asks anyone quiet for a couple of minutes for a fresh fix, and
opening somebody's page asks their phone for one too. Live, offered for anyone
you see precisely, moving or parked, has their phone send a fix a second for as
long as you watch. It stops within seconds of the last person watching leaving
the page or putting Hearth in the background, and when they turn your circle to
approximate or pause it. On Android the location service's notification shows
for that time, parked or not.

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

## I'm signed in on a phone and a tablet. Which one is on the map?

You're one dot, and it follows whichever device last had something to say,
with one exception. A device that is lying still doesn't take the dot from
another of yours that is still reporting, so a tablet left at home doesn't
pull you back there every quarter of an hour while you're out with your
phone. Once a device is on the move it takes the dot at once. Under _You_,
_Signed-in devices_ marks the one your circles are seeing with _On the map_.

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

Coordinates never leave it. The phone sends some to its own geocoder for street
names, as below.

Apart from its own object storage, your server makes one kind of outbound
connection, and only if you configured it: to the push provider. Push payloads
carry a title, a body and identifiers such as `type`, `circleId` and `eventId`.
The title and body can name a person and a place, but never a position. The
phone fetches the actual location from your server when the notification is
tapped.

The phone itself requests map tiles from the style URL your server advertises,
so that host sees roughly which area is being viewed, as it would with any map.
Self-host tiles and that goes too.

Street names under members and trips come from the phone's own geocoder,
Apple's on iPhone and Google's on most Android phones, and the phone sends it
the coordinates of each spot it names. They are on out of the box. Turn _Street
names_ off under _You_ and those coordinates stay on the phone.

There is no analytics, no crash reporting and no advertising or tracking SDK
anywhere in the server or the app. Set `PUSH_PROVIDER=ntfy` against your own
ntfy instance, host your own tiles and turn street names off, and two things
still leave your infrastructure, neither with a position in it. For iPhones,
ntfy passes a poll request through its public server to APNs, which carries a
message id and no content. And an Android build that includes Firebase, which
Expo push needs, registers the phone with Google's Firebase Cloud Messaging
when it starts, whichever provider your server uses.
[Privacy](privacy.md) has the full table of what is stored and who can see it.

## Why are push notifications the awkward part?

Because waking a phone that is asleep in someone's pocket is a hop that belongs
to Apple and Google, and no amount of self-hosting changes that.

Hearth's answer is to make push optional. The default, `PUSH_PROVIDER=none`,
needs no configuration: the app holds a websocket while it is open, so the map
and feed update live, it polls presence every 60 seconds as a fallback in case
that socket is dead, and an active SOS shows as a banner on the circle's map.
What you lose is alerts while the phone is locked. The exception is an SOS or a
possible crash, which the app rings for itself when it hears one over its own
connection to the server. An iPhone keeps that connection while it shares its
location, and an Android phone while it's on the move.

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
times over about an hour and twenty minutes before it is given up. An SOS is
the exception. It is tried every few minutes for as long as it is open, and a
possible crash alert the same way for up to an hour.
[Push notifications](install/push-notifications.md) compares all four options
properly.

## Will an SOS get through silent mode or Do Not Disturb?

Mostly, and not everywhere.

On an iPhone an SOS is a Time Sensitive notification. It gets through Do Not
Disturb and any other Focus that allows time sensitive notifications, but the
ring/silent switch still silences it. The kind of alert that sounds on a
silenced iPhone is a Critical Alert, which needs an entitlement Apple grants on
request, and Hearth doesn't have one. Keep Time Sensitive Notifications on for
Hearth in its notification settings and in each Focus you use.

On Android an SOS goes on a channel set to override Do Not Disturb, and Android
honours that only for an app that has been given Do Not Disturb access. The
setup checklist has an optional step for it. Without the access an SOS still
arrives at the highest importance, but Do Not Disturb keeps it quiet.

[SOS and crash detection](safety.md#sos) has the detail.

## When does a speed alert go off?

Only once a circle admin sets a speed for it in circle settings. It's off until
then. The choices are in km/h or mph, whichever the admin's phone uses, and
the server keeps them in km/h. After that the circle is told when somebody's phone stays over the speed
for at least 15 seconds of the drive. One fast reading never counts, and
neither do two in a row on Live, which sends a fix a second. That's how a GPS
glitch reading 130 km/h for a moment on a town road stays quiet. A phone that
reports once a minute on the motorway still counts, because two fixes a minute
apart over the limit cover a minute of driving.

The speed quoted is the fastest that two neighbouring fixes agree on, and never
faster than the ground between two sharp fixes allows. The trip card uses the
same rule, so the two never disagree. The alert reaches only circles the driver
shares precisely with, at most once every half hour per circle, and a drive
that uploads late goes in the feed without a notification.

The check that tells a circle to look in on somebody who stopped hard is a
different thing, and
[SOS and crash detection](safety.md#the-server-side-check-which-is-a-different-thing)
explains it.

## What actually happens when somebody pauses sharing?

Sharing is per circle, and there are three modes: precise, approximate and
paused.

Paused means that circle gets nothing. Coordinates come back null, and so do
battery, activity, the last-reported time and which place you are at. Members
see that you paused, and get a notification that says so and for how long,
unless they turned "Sharing paused" off. That is deliberate. Silent
invisibility would be a different feature. The history and trips endpoints answer an empty list for
anybody who is not currently sharing precisely.

Two behaviours surprise people:

- **The phone keeps uploading and the server keeps storing your breadcrumbs
  while you are paused.** Pausing hides you from a circle, it does not stop
  collection. To stop collection, turn off _Share my location_ on the phone,
  which stops the OS updates so nothing is captured or queued at all. The
  phone tells the server it did. A circle that allows pausing sees that as a
  pause, and a circle that has pausing turned off sees "Turned off location
  sharing" under your name with your last position, so a switch on the phone
  cannot get round a circle's rule unnoticed. Your own map says the switch is
  off until you turn it back on.
- **SOS overrides a pause.** Raising one switches you to precise in every
  circle you're in, including ones you had paused or set to approximate, and
  notifies everyone in them regardless of mutes. Your phone reports live, a fix
  a second, until shortly after you resolve it. Resolving it does not put the
  pause back. See [safety](safety.md).

A pause can carry an expiry. It lapses on read, and a background job restores
whatever mode you were in before pausing rather than defaulting you to precise.
Sharing precisely again starts the circle's places from where you are then, so
the circle isn't told you left home hours after you did.
A circle owner or admin can turn pausing off entirely, and that setting is
visible to every member.

Quick messages still reach somebody who has paused, since a message says
nothing about where they are. A bare _Ask for location_ isn't sent to them, and
the person asking is told they paused.

## Can a circle admin see more than an ordinary member?

No. Roles govern circle management, nothing else. The code that projects
someone's position for a viewer never looks at the viewer's role, so an owner,
an admin and a new member all see exactly what your sharing mode allows. You
always see yourself precisely.

## How much history is kept?

Each circle sets its own window, 30 days out of the box. A user's breadcrumbs
live as long as the most generous circle they belong to asks for, under a
server-wide ceiling, `MAX_HISTORY_RETENTION_DAYS`, 90 by default. The app
offers nothing longer than the ceiling and says why, and a circle that asks for
more is kept at the ceiling. Set a circle's
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
hand control back to `.env`. Server-info carries the ceiling as
`maxHistoryRetentionDays`.

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
