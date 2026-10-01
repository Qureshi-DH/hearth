---
sidebar_position: 3
title: Push notifications
---

Push is the one part of a family tracking app you can't just run on your own box.
The last hop, waking a phone that's asleep in someone's pocket, belongs to Apple
(APNs) and Google (FCM). This page covers what Hearth does about that, what
your options are, and which one to pick.

## In short

| Provider (`PUSH_PROVIDER`) | Works on                                     | Needs a third party?               | Effort | Privacy                           | Reliability on a sleeping phone                                                            |
| -------------------------- | -------------------------------------------- | ---------------------------------- | ------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `none` (default)           | iOS, Android                                 | No                                 | Zero   | Best                              | None. Alerts appear when the app is opened, and the map still updates live while it's open |
| `ntfy`                     | iOS, Android, through the ntfy app           | No, you host ntfy too              | Low    | Best                              | Good for alerts. Never wakes the Hearth app, see below                                     |
| `expo`                     | iOS, Android, in a build made with your keys | Yes, Expo's relay then APNs or FCM | High   | Titles and bodies transit Expo    | Excellent                                                                                  |
| `webpush`                  | No Hearth client uses it yet                 | Browser vendor's push service      | Medium | Good                              | Not used by the app                                                                        |
| Direct APNs + FCM          | Not implemented                              | Yes, Apple and Google accounts     | High   | Payload transits Apple and Google | Would match `expo`                                                                         |

Start with `none`, which needs no configuration at all. Move to `ntfy` when you
want alerts on a locked phone without handing anything to a third party. Use
`expo` if you build the app with your own Expo, Firebase and Apple keys and
don't mind Expo relaying the notification text. It's the only option that
gives you the whole app.

Only `expo` wakes the Hearth app itself. When the server wants a fresh fix from
a phone, it first tries the phone's own connection to the server. An iPhone
keeps that line open whenever it's sharing, because its parked location session
keeps the app alive. An Android phone keeps it only while it's moving. An ask
that goes down that line needs no push. When the line is closed, which on a
parked Android phone is always, the fallback is a silent push, and that has to
arrive through FCM or APNs in the app's own process. With `ntfy` the alerts are
shown by the ntfy app, so the family still hears about arrivals and SOS, but a
phone whose line is closed waits for its own next report rather than being
woken.

## What the app needs from Expo

The iOS and Android apps are built and tested and waiting on App Store and Play
Store review.

Alerts on a locked phone, and the silent wakes that bring a parked Android phone
back to reporting, both ride on Expo push. A push reaches the app only through
the Expo project, Firebase project and Apple push key it was built with, and
every push to that build goes out under those accounts, whichever server sends
it. That is why a store build cannot ship with personal keys that any server on
the internet would be sending through.

So today:

- **With your own Expo account, Firebase project and Apple developer account**,
  build the app with your keys as Option 3 describes, and push works fully
  against your server.
- **Without them**, Hearth still works. Use `ntfy` for alerts, with the limits
  under Option 2, or no push at all.

A Hearth organisation with its own Expo, Firebase and Apple accounts, and a
small relay in front of Expo that passes only Hearth's own notifications, would
let the store builds push for any server. It is on the
[roadmap](../roadmap.md) and needs funding.

## How a notification is sent

All providers share the same server-side pipeline. Events are written to a
durable `notification_outbox` table in the same transaction as the thing that
caused them. Postgres wakes the worker the moment that transaction commits, so
an alert is on its way within milliseconds rather than on the next scheduler
tick, and rows are sent eight at a time with the most urgent first. Before a
row goes out, the server checks again that the recipient is still in the
circle. An arrival, a departure, a finished trip or a speed alert is dropped if
the person it's about has stopped sharing precisely with that circle in the
meantime.

A broken push provider never fails a user's request. A failed send is retried
after 10 seconds, a minute, 5 minutes, 15 minutes and an hour, and given up
after the sixth attempt. Each call to the provider has 15 seconds to answer.

Every visible notification is queued at high priority. Through Expo, that is
what lets an Android phone in Doze show it at once, and on iOS it asks APNs for
immediate delivery. An SOS or a crash alert goes on its own channel, which
plays a sound, is marked time-sensitive on iOS and is allowed through Do Not
Disturb on Android. A silent push to an iPhone goes at Apple's background
priority instead, because APNs throttles a background push sent at the higher
one.

## One notification per person

Through Expo, news about one person shares one notification, the way you'd
follow their afternoon. When Amina leaves home, gets to the shop and comes back,
her notification grows a line each time rather than three appearing.

- Where somebody went goes under their name: arrivals, departures, trips and
  check-ins.
- Quick messages and location requests go under the name of whoever sent them.
- Low battery and a phone that stopped reporting go under "Amina's phone".

The newest line comes first, so a collapsed notification shows the news. Five
lines fit, and older ones are counted underneath. After two hours with no news
about someone, the next piece starts a new notification, so one you swiped away
in the morning doesn't come back with the whole morning in it.

A backlog, after the phone or the provider was out of reach for a while,
arrives as one update rather than a buzz for every line in a row.

A trip that ends at a saved place doesn't send a notification of its own,
because the arrival already did. Its distance is added to the arrival line and
shows with the next update. A trip that ends somewhere unsaved gets its own
line. News that reaches you through two circles you share with the same person
is sent once.

An SOS always gets a notification to itself, and the notice that it was
resolved replaces it. An SOS that couldn't be delivered before it was resolved
isn't sent late. Speed and crash alerts always stand alone.

Every update still makes the phone buzz. There are fewer buzzes because a
finished trip no longer adds one. ntfy and Web Push can't replace a
notification, so through them each piece of news still arrives as its own.

## What a notification actually contains

Hearth keeps push payloads deliberately boring:

- title: `"Amina"` / `"Amina's phone"` / `"🚨 SOS from Amina"`
- body: `"Arrived at Home"` with earlier lines under it / `"Battery at 12%"`
- data: `{ type, circleId, eventId }`, plus a `placeId`, `userId` or timestamp
  where the alert needs one. Identifiers and times, nothing more.

Through ntfy and Web Push each notification stands alone, so the wording does
too: `"Home"` and `"Amina arrived at Home"`.

**Coordinates are never included in a push.** The phone fetches the actual
position from _your_ server when the notification is tapped. So the
third-party options below see names, place labels and the words of an alert,
not where anyone is. The words include an SOS note or a quick message, since
those are the body of their notification. If that's still too much for your
threat model, use `ntfy`.

## Option 1: `none` (no background push)

Set nothing. The app still holds a websocket to your server while it's in the
foreground, so the map, the activity feed and an active SOS update in real
time. It also polls presence every minute in case that socket is dead.

What you lose is alerts while the phone is locked. The server still records
every alert in the activity feed, so nothing is missed, only heard about later.
For a household that mostly opens the app to _check_ where people are, that's
often fine.

## Option 2: `ntfy` (self-hosted alerts)

[ntfy](https://ntfy.sh) is a small open-source pub/sub server. The phone holds a
long-lived connection to _your_ ntfy instance, or on Android a single shared
connection via the UnifiedPush distributor, and messages arrive instantly even
from a locked screen.

How Hearth uses it:

1. `PUSH_PROVIDER=ntfy`, `NTFY_BASE_URL=https://ntfy.your-domain.example`.
2. When a device registers, the server derives an unguessable topic for that
   account on that phone, `hearth-` followed by 32 hex characters of a SHA-256
   over the server's secret, the account and the device. Clients can't choose a
   topic someone else could subscribe to.
3. The app's notification settings show the topic, which copies when tapped,
   and the ntfy server's address. Each person subscribes to their topic in the
   ntfy app (F-Droid, Play or App Store), which handles background delivery.
4. Hearth publishes to `NTFY_INTERNAL_URL` (e.g. `http://ntfy:80` inside the
   compose network) if set, else to `NTFY_BASE_URL`.

Lock it down. Run ntfy with `NTFY_AUTH_DEFAULT_ACCESS=deny-all`, create a user
for Hearth with write access to `hearth-*`, and give the phones read-only access
tokens. The compose overlay `docker-compose.ntfy.yml` in the repository starts
ntfy with auth enabled, and you create the accounts yourself with `ntfy user add`
and `ntfy access` inside the running container. Put `NTFY_TOKEN` in `.env` so the
server authenticates when publishing. `NTFY_TOPIC_PREFIX` renames the `hearth-`
part if you are sharing an ntfy instance with something else.

**ntfy is not a full replacement for Expo.** It carries the alerts, but it
cannot wake Hearth itself. Only a push through FCM or APNs to the app's own
process can do that, and a notification the ntfy app shows never reaches it. On
a parked Android phone that means:

- Live and a refresh wait for the phone's next report, up to a quarter of an
  hour, or until it moves.
- A phone that has gone quiet is not woken before its family is told it stopped
  reporting.
- "Ask for location" shows its words in ntfy, but no fresh fix is taken.

Tracking itself carries on. The geofence, the activity transitions, the location
service on a journey and the quarter-hourly report all run without push. iPhones
feel this less, because their parked location session keeps the app's own line
to the server open, and asks go down that instead.

For alerts, Android is the good case. The ntfy app keeps one battery-friendly
connection and shows them at once. iPhones are weaker, because iOS won't let the
ntfy app hold a connection of its own. A self-hosted ntfy server reaches an
iPhone only if you set its `upstream-base-url` to ntfy's public server, which
passes a poll request carrying the message's id on to APNs. The iPhone then
fetches the message itself from your server. Without that setting, messages
wait until the ntfy app next checks in. Read ntfy's iOS docs first. The real
cost is that everyone installs a second app, which for a family is a one-time
setup step.

## Option 3: `expo` (Expo's hosted push relay)

The Hearth app is built with Expo, so `expo-notifications` can hand you an
`ExponentPushToken[...]`. Your server POSTs to `https://exp.host/--/api/v2/push/send`
and Expo relays to APNs or FCM using credentials attached to your Expo project.

Setup, if you are building the app yourself:

1. `apps/mobile/app.json` carries the maintainer's Expo account in `owner` and
   the maintainer's project in `extra.eas.projectId`. Delete both, then run
   `cd apps/mobile && npx eas-cli@latest init`, which creates a project under
   your account and writes its id back. The free tier is fine.
2. For Android, create a Firebase project, add an Android app with the package
   name from `app.json`, and put the downloaded `google-services.json` in
   `apps/mobile/`. It is gitignored on purpose, so a build from a fork registers
   devices in that fork's Firebase project rather than somebody else's.
   `google-services.example.json` shows the shape. Then upload the FCM V1
   service account key to Expo with `npx eas-cli@latest credentials -p android`.
   Without that upload, tokens register and nothing is ever delivered.
3. For iOS, change `ios.bundleIdentifier` in `app.json` to one on your own Apple
   team, since the one in the repository belongs to the maintainer's. Then run
   `npx eas-cli@latest credentials -p ios` and let EAS hold the APNs key.
4. Set `PUSH_PROVIDER=expo` on the server, plus `EXPO_ACCESS_TOKEN` if you
   enabled enhanced push security on your Expo account.

Both the project id and `google-services.json` are compiled into the build, so
a build made before you configured them cannot deliver push no matter what the
server is set to. The service account key and the APNs key are the two real
secrets here and neither belongs in the repository.

You get zero infrastructure and the best reliability on both platforms. The
price is that Expo sits in the delivery path and sees the device token, the
title, the body and the id-only `data` field. It doesn't see coordinates. Expo
does not charge for push at the volumes a family generates, though that is
their pricing to change and not something this project controls.

## Option 4: `webpush` (VAPID Web Push)

Standard Web Push with your own VAPID key pair. The server is fully
self-contained (`npx web-push generate-vapid-keys`), but delivery still goes
through the browser vendor's push service (Mozilla, Google, Apple). The server
can send it, and it's there for a future **web client**. No Hearth client uses
it today. The native app turns it down and says to use its own transport, so on
a server set to `webpush` the phones get no push at all.

## Option 5: direct APNs + FCM (not implemented)

You could bypass Expo and talk to Apple and Google yourself. APNs wants
token-based auth with a `.p8` key from a paid Apple Developer account, over
HTTP/2 to `api.push.apple.com`. FCM HTTP v1 wants a Firebase project and a
service account JSON, with OAuth2 to `fcm.googleapis.com`.

That gets Expo out of the path. What it costs you is two vendor accounts,
credential rotation, and platform-specific payload formats. It doesn't change
the key problem above, either: a push still reaches only a build made with the
Firebase project and Apple key it was sent with. The `PushDriver` interface in
`server/src/services/push.ts` is small, one `send()` method, so `apns` and
`fcm` drivers are the natural next additions and are on the roadmap. Until
then, `ntfy` is the way to keep Expo out, with the limits under Option 2.

## Silent pushes and asks

The server asks a phone for a fresh fix when somebody opens the map, when
somebody opens that member's page, when somebody opens Live, and when a phone
has gone quiet. Each ask goes down the phone's own line to the server if it's
open. Otherwise, and only with `expo`, it becomes a silent push with
`data.type` of `wake`, or `watch` for Live. Nothing is shown or heard. The app
takes the fix in the background, on Android even from Doze. iOS decides for
itself when to hand a background push to an app and may hold one back, which is
why the open line matters more on an iPhone.

A silent push that can't be delivered in time is dropped rather than arriving
late: a watch after a minute, a wake after five. A late one would turn on the
GPS for somebody who stopped looking long ago. The server also holds pushes back
so they don't pile up. Opening the map skips any phone that reported in the last
two minutes and pushes each of the others at most once every ten minutes. A
member's page skips a phone that reported in the last half minute and pushes it
at most once a half minute. Live sends a new watch no sooner than every 90
seconds, and no more than three in its ten-minute window.

With `ntfy` or `none`, only the phone's own line carries an ask. That reaches
any iPhone that's sharing and any Android phone that's moving. A parked Android
phone waits for its next report.

## Ask for location and quick messages

_Ask for location_ and a quick message are the same thing on the wire: an alert
aimed at one member, recorded in the activity feed as `nudge_requested`. A bare
ask arrives as "Location requested" with "Amina asked where you are." A quick
message arrives with the sender's name as the title and the line they sent as
the body. `data` carries the id of the feed entry and who sent it. Tapping it
opens the map, which is where the app plays the message. A sender can send six
in ten minutes.

This one is a visible notification, not a silent push, and that changes what
it can do. With the app open, the phone shows the message and takes a fresh
fix at once, whatever the provider. With the app in the background, the system
shows the notification and the app doesn't run, so the ask alone doesn't
produce a fix. In practice the sender asks from the member's page, and opening
that page has already asked the phone for a fix, as described above.

Muting "Nudges from your circle" in a circle's notification settings silences
the notification. The activity feed records it either way, so the line is still
there to find.

## Choosing, in one paragraph

If you build the app with your own Expo, Firebase and Apple keys, use `expo`. It
is one environment variable on the server and it is the only option that gives
you the whole app. If you care about privacy above all, or have no such keys,
run `ntfy` alongside the server for alerts and accept the limits under Option 2.
That's one extra container and one extra app on each phone. Either way, start
with `none`, get everyone on the map, and add push once the basics are solid.
