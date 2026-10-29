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
- Outside Live a phone takes a fix only when your server pings it, so while
  the server is down hardly any are taken and the queue barely grows. With the
  app open it takes one at the circle's interval, to keep your own row fresh.

The background sync task also flushes the queue whenever the OS grants it time,
and takes a fresh fix if the last one is more than two intervals old, ten
minutes at the default.

While the server is down nobody can see anybody, and after 15 minutes without a
fix everyone shows as stale, or after 35 for a phone whose last fix said it was
still, since an iPhone sitting still may answer only a few pings an hour. The
job that
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

Nobody has published a measured number yet, so the honest answer is a
description of what the phone does.

Since 1.3.4 a phone takes its location when somebody asks, and not otherwise.
Your server pings each phone on the interval of the strictest circle it is in,
every five minutes out of the box, and every two while its last fix had it on
the move. The phone's motion sensor, which costs no location, says whether it
has moved since its last fix. A phone lying still answers with that fix again
and never turns location on, and one that moved answers with one Wi-Fi grade
fix, which on Android leaves the GPS off. Somebody opening Live on you puts
your phone on the GPS at a fix a second for as long as they watch. Moving
never switches on tracking, so between asks the location indicator stays off.
On Android a ping that needs a fix puts "Updating your location" in the silent
part of the shade for the few seconds it takes, and Android holds that
notification back for about ten seconds, so it often never appears. Live keeps
it up for as long as somebody watches. Earlier versions tracked continuously
and kept the indicator on all day.

The one time the GPS runs by itself is a drive, and only where a circle you are
in has crash alerts on. Crash detection needs the GPS speed either side of a
jolt, so for the drive the location indicator shows, and on Android the
notification says "Crash detection is on for this drive". Those fixes stay on
the phone and are never uploaded. It never runs at home.

What you give up is detail. Between pings the family sees where you were at
the last one, so an arrival or a departure can be up to one interval late,
and a drive is a point every couple of minutes rather than a line along the
road. A still phone takes a real fix at least once an hour, so a departure the
motion sensor missed shows up within the hour.
Speed alerts and the server's hard-stop check need Live's fix a second to see
much. An iPhone answers a ping only when iOS hands the silent push to the
app, and iOS decides how many of those an app gets, so expect an iPhone to
report less often than the interval says. One where Hearth was swiped away in
the app switcher reports nothing until somebody opens it. Live is the answer
when you want to follow somebody right now.

The pings ride on Expo push. On a server without it, a phone with Hearth closed
reports only when the OS gets round to running the app's background task, see
[why push is the awkward part](#why-are-push-notifications-the-awkward-part).

A phone whose last fix said it was still, or that is at a named place, is
expected to be quiet, so the server calls it offline only after twelve hours of
silence. An account signed in only on Android phones gets about 100 minutes,
since Android answers a ping even from Doze. A phone last seen moving is
reported after an hour. Where the server can push, it also waits until three
pings have gone unanswered. A phone that has told the server why it cannot
report, a permission short of Always, which Android calls Allow all the time,
or Location Services off, is shown as that under its name instead. One that
went quiet on 5% battery or less is shown, and reported, as having most likely
run out.

Opening the map asks anyone quiet for a couple of minutes for a fresh fix, and
opening somebody's page asks their phone for one too. Live, offered for anyone
you see precisely, moving or parked, stops within seconds of the last person
watching leaving the page or putting Hearth in the background, and when they
turn your circle to approximate or pause it. An SOS keeps the phone that raised
it on Live for half an hour, and pressing SOS again while the alert is open
starts the half hour over.

Your circles decide the rest. The interval is the strictest of every circle you
are in. A circle admin can choose every 2 minutes, every 5, or 10 as a battery
saver, or anything from 2 to 10, and one circle asking for every 2 minutes
makes every phone in it answer every 2. The server never goes past 10, since a
phone on the move would read as out of date on the map between pings. Without
the motion permission, Motion & Fitness on iOS or physical activity on Android,
every ping takes a Wi-Fi fix and crash detection cannot run.

The single biggest reason pings stop getting through on Android is the battery
optimiser, which is why the app asks for an exemption during setup.

## I'm signed in on a phone and a tablet. Which one is on the map?

You're one dot, and it follows whichever device last had something to say,
with one exception. A device that is lying still doesn't take the dot from
another of yours that is still reporting, so a tablet left at home doesn't
pull you back there at every ping while you're out with your phone. Once a
device is on the move it takes the dot at once. Under _You_, _Signed-in
devices_ marks the one your circles are seeing with _On the map_.

## My family member's phone keeps going quiet on Android

Almost always the phone is keeping Hearth from running in the background to
save battery, so the server's pings stop getting through, and the family is
looking at the last position it sent. Android does this to any app that runs
in the background, and several makers ship a power manager of their own that
does it sooner and without asking. Xiaomi, Redmi and POCO,
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
said that Battery Saver is on, or that background use is Restricted, is shown
as that under their name rather than as offline. A phone that was closed
outright cannot report anything until somebody opens Hearth on it again, and
that is the one case nothing on the server can help with.

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
What you lose is alerts while the phone is locked, and most of the reporting
from a phone with Hearth closed. The server pings phones for their location
through the same push, so without it the server cannot ask a phone where it is
while Hearth is closed, and nobody can watch it on Live then. The phone reports
from its own background check, about every quarter of an hour on Android and
less often on an iPhone, and while Hearth is open. The exception for alerts is
an SOS or a possible crash, which the app rings for itself when it hears one
over its own connection to the server. That connection is held only while
Hearth is open.

When you want more, `ntfy` is the fully self-hosted route. It carries alerts
only and never wakes the Hearth app, so phones report as they would with no
push at all. `expo` is the zero-infrastructure one and the only provider that
can wake the app, but it only fully works in a build you
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
glitch reading 130 km/h for a moment on a town road stays quiet. It needs a
speed the phone measured, though, and outside Live the phone answers a ping
every couple of minutes with a Wi-Fi fix that rarely carries one. The
exception is a drive with crash alerts on, where the ping gets the drive's GPS
fix. Otherwise a speed alert comes from a drive somebody is watching on Live.

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
