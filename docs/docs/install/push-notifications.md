---
sidebar_position: 3
title: Push notifications
---

Push is the one part of a family tracking app you can't just run on your own box.
The last hop, waking a phone that's asleep in someone's pocket, belongs to Apple
(APNs) and Google (FCM). This page covers what Hearth does about that, what
your options are, and which one to pick.

## In short

| Provider (`PUSH_PROVIDER`) | Works on                                     | Needs a third party?               | Effort | Privacy                           | Reliability on a sleeping phone                                                                                         |
| -------------------------- | -------------------------------------------- | ---------------------------------- | ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `none` (default)           | iOS, Android                                 | No                                 | Zero   | Best                              | Poor. No pings, so a closed app reports only from its background task, and an SOS rings only on a phone still connected |
| `ntfy`                     | iOS, Android, through the ntfy app           | No, you host ntfy too              | Low    | Best                              | Good for alerts. No pings, so the same reporting as `none`, see below                                                   |
| `expo`                     | iOS, Android, in a build made with your keys | Yes, Expo's relay then APNs or FCM | High   | Titles and bodies transit Expo    | Excellent on Android. An iPhone answers the pings iOS lets through                                                      |
| `webpush`                  | No Hearth client uses it yet                 | Browser vendor's push service      | Medium | Good                              | Not used by the app                                                                                                     |
| Direct APNs + FCM          | Not implemented                              | Yes, Apple and Google accounts     | High   | Payload transits Apple and Google | Would match `expo`                                                                                                      |

Start with `none`, which needs no configuration at all. Move to `ntfy` when you
want alerts on a locked phone without handing anything to a third party. Use
`expo` if you build the app with your own Expo, Firebase and Apple keys and
don't mind Expo relaying the notification text. It's the only option that
gives you the whole app.

Only `expo` wakes the Hearth app itself, and since 1.3.4 a phone's reporting
rests on that. A phone reports its location only when the server pings it, every
five minutes by default, or while somebody watches it on Live. The server
first tries the phone's own connection to it, which the app holds only while
it is open, and on an iPhone during Live. When that line is closed, which for a
phone in a pocket is nearly always, the ping is a silent push, and that has to
arrive through FCM or APNs in the app's own process. With `ntfy` or `none`
there is nothing to carry it. A phone with Hearth closed then reports only
from its own background check, which the operating system runs about every
quarter of an hour on Android, later in Doze, and less often on an iPhone, and
nobody can watch it on Live until it is opened. With `ntfy` the alerts are
still shown by the ntfy app, so the family hears about arrivals and SOS, but
only as often as those reports come in.

## What the app needs from Expo

The iOS and Android apps are built and tested and waiting on App Store and Play
Store review.

Alerts on a locked phone, and the silent pings every phone answers with its
location, both ride on Expo push. A push reaches the app only through
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
tick, and rows are sent eight at a time with the most urgent first. A row held
back for a moment, or waiting to be retried, goes the moment it falls due,
because the worker keeps a timer for the earliest one, and picks it up again
after a restart. An SOS or
a possible crash goes ahead of anything else waiting, however long the queue.
Before a row goes out, the server checks again that the recipient is still in
the circle. An arrival, a departure, a finished trip or a speed alert is
dropped if the person it's about has stopped sharing precisely with that circle
in the meantime. A "phone offline" alert is dropped if the phone has reported
since it was queued.

A broken push provider never fails a user's request. A failed send is retried
after 10 seconds, a minute, 5 minutes, 15 minutes and an hour, and given up
after the sixth attempt. Each call to the provider has 15 seconds to answer.

An SOS is retried for as long as it is open, never more than three minutes
apart, and dropped once it is resolved or no longer exists, so a provider that
is down for an afternoon delays it rather than losing it. A possible crash
alert travels on the SOS channel and is retried the same way for up to an
hour, since nothing marks it resolved and "have not moved since" means less
the later it arrives. It is dropped sooner if the person has since driven on,
or stopped sharing precisely with that circle. A provider that turns a
message down as malformed, with a 4xx other than a rate limit, gets the usual
six tries even for an SOS, because asking again gets the same answer.

When the server can't reach the push provider at all, it holds back its "phone
offline" alerts until half an hour after the last failure. A home server whose
own internet connection is down hears from no phone and reaches no provider,
and without the hold it would tell the family every phone had died as soon as
the connection came back. A ping that never reached the provider doesn't count
as asking the phone. Once the server has held its alerts for an outage, it
keeps holding them for half an hour after it last did, through a restart, so
the other phones can get back through after the first.

Through Expo, the server keeps the ticket each send gets back. Every quarter of
an hour it asks Expo for the receipts of tickets at least half an hour old, a
thousand at a time, and a receipt that says the app is no longer on the phone
(`DeviceNotRegistered`) clears that phone's token, as long as the phone hasn't
registered a new one since. A receipt is read once. Tickets with no receipt
after a day are dropped. A failed call to Expo isn't retried until the next
quarter hour.

A send or a receipt that says `InvalidCredentials` is about the Expo project's
FCM or APNs keys, not the phone, so no token is cleared for it. The send counts
as failed and is retried, and the server logs an error that names the keys to
check.

Every visible notification is queued at high priority. Through Expo, that is
what lets an Android phone in Doze show it at once, and on iOS it asks APNs for
immediate delivery, and every one plays the phone's notification sound. An SOS
or a crash alert goes on its own channel, which is marked time-sensitive on iOS
and is allowed through Do Not Disturb on Android, once the phone has given
Hearth Do Not Disturb access from the setup checklist.
[SOS and crash detection](../safety.md#sos) says what each platform will and
won't do with it. A silent push to an iPhone goes at Apple's background
priority instead, because APNs throttles a background push sent at the higher
one.

## Arrivals, departures and trips

A journey between two named places is at most two notifications.

- **Left.** "Amina left Home", once the departure is real. That takes a second
  fix outside the place, or a minute with no fix back inside, so a Wi-Fi fix
  that jumps down the street doesn't send "left Home" and then "arrived at
  Home". A phone that says it hasn't moved needs that second fix, however
  long it takes. If the phone's next word after leaving is already from
  somewhere named, as it often is when the next ping finds her there, only the
  arrival is sent.
- **Arrived.** "Amina arrived at School, 4.2 km from Home in 14 min", with the
  distance and time worked out from the fixes since she left. It goes as soon
  as the server sees the crossing, usually within a second of the fix. Outside
  Live that fix is the first ping after the crossing, so it can be up to one
  interval late, five minutes at the default. A phone doing
  18 km/h or more might be in a car driving past, so that arrival waits up to
  a minute, and is never sent if the next fix is out the far side.
- **Trip.** A trip that ends at a named place goes to the activity feed only.
  One that ends anywhere else sends "Amina stopped 4.2 km from Home", so you
  still hear that the journey is over.

News that reaches you more than a couple of minutes late says when it
happened, "Amina arrived at School at 8:31", on your phone's clock. Anything
more than half an hour old, or from a backlog the phone uploads long after,
goes to the feed only. Walking into a Home inside a bigger place such as a
neighbourhood is one arrival, at Home. Somebody who keeps leaving and coming
back to a place within minutes gets one pair of notifications, and the rest
of the laps go to the feed.

## What you can turn off

Each circle's notification settings let you choose these.

- which kinds of news you hear, or mute the whole circle for an hour, a day or
  a week,
- for each of the circle's places, whether you hear arrivals, departures, both
  or neither,
- the people whose comings and goings you'd rather not hear about. This covers
  arrivals, departures and trips, wherever you share a circle with them.

Quiet hours hold ordinary news until they end, or drop it, as you choose, and
cover every circle. They follow your phone's clock, which the app sends each
time it starts. Muting a person and quiet hours are stored on your account, so
every phone you sign in on agrees.

None of it reaches an SOS, a possible crash, or the notice that an SOS was
resolved. Those always come through.

When somebody pauses sharing with a circle, the circle is told, "Amina paused
location sharing for 1 hour", unless they turned "Sharing paused" off. A
paused phone is otherwise as silent as one that died.

## One notification per person

Through Expo, news about one person shares one notification, the way you'd
follow their afternoon. When Amina leaves home, gets to the shop and comes back,
her notification grows a line each time rather than three appearing.

- Where somebody went goes under their name: arrivals, departures, trips and
  check-ins.
- Quick messages and location requests go under the name of whoever sent them.
- Low battery and a phone that stopped reporting go under "Amina's phone",
  and so does the line that says it's reporting again.

The newest line comes first, so a collapsed notification shows the news. Five
lines fit, and older ones are counted underneath. After two hours with no news
about someone, the next piece starts a new notification, so one you swiped away
in the morning doesn't come back with the whole morning in it.

A backlog, after the phone or the provider was out of reach for a while,
arrives as one update rather than a buzz for every line in a row.

A trip that ends somewhere unsaved gets its own line. News that reaches you
through two circles you share with the same person is sent once.

An SOS always gets a notification to itself, and the notice that it was
resolved replaces it. An SOS that couldn't be delivered before it was resolved
isn't sent late. Speed and crash alerts always stand alone.

Every update plays the notification sound, on iPhone and Android alike,
because each one is a new line of news. A journey makes two at most. ntfy and
Web Push can't replace a notification, so through them each piece of news
arrives as its own, with the same words.

## What a notification actually contains

Hearth keeps push payloads deliberately boring:

- title: `"Amina"` / `"Amina's phone"` / `"🚨 SOS from Amina"`
- body: `"Arrived at School, 4.2 km from Home in 14 min"` with earlier lines
  under it / `"Battery at 12%"`
- data: `{ type, circleId, eventId }`, plus a `placeId`, `userId` or timestamp
  where the alert needs one. Identifiers and times, nothing more.

Through ntfy and Web Push each notification stands alone, so the wording does
too, as in `"School"` and `"Amina arrived at School, 4.2 km from Home in 14 min"`.

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

You also lose the ping, and with it most reporting. Without a silent push the
server cannot ask a phone where it is while Hearth is closed, and nobody can
watch it on Live then. The phone reports from its own background check, about
every quarter of an hour on Android and less often on an iPhone, and while
Hearth is open.

And you lose alerts while the phone is locked, with one exception. An SOS, or
a possible crash from the server's check, that reaches a phone over its own
connection to the server makes the app ring for it, on the SOS channel, once
per SOS. That connection is open only while Hearth is, so any other phone hears
nothing until the app is opened. Arrivals, low battery and the rest never ring
this way. The setup checklist says the same on a server like this.

The server still records every alert in the activity feed, so nothing is
missed, only heard about later. For a household that mostly opens the app to
_check_ where people are, expect each person's dot to be as old as their
phone's last background report.

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
process can do that, and a notification the ntfy app shows never reaches it.
Since 1.3.4 that matters a lot, because the server's ping is such a push. With
Hearth closed, that means:

- The phone reports only from its own background check, about every quarter
  of an hour on Android and less often on an iPhone.
- Live and a refresh wait for that next report.
- A phone that has gone quiet is not asked again before its family is told it
  stopped reporting.
- "Ask for location" shows its words in ntfy, but no fresh fix is taken.

With Hearth open everything works as it does with `expo`, since the app's own
line to the server carries the asks.

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

The server asks every phone for a fix on its circle's interval, which is the
ping, and again when somebody opens the map, opens that member's page or opens
Live. Each ask goes down the phone's own line to the server if it's open.
Otherwise, and only with `expo`, it becomes a silent push with `data.type` of
`wake`, or `watch` for Live. The scheduled ping's `wake` carries `ping: true`.
Nothing is shown or heard. The app answers in the background, on Android even
from Doze, where the push handler answers without starting the app's
JavaScript. A phone the motion sensor has had lying still since its last fix
answers a ping with that fix again and turns no location on. One that moved,
or any phone asked by somebody opening a page, takes a fresh fix. iOS decides for itself when to hand
a background push to an app and holds some back, so an iPhone answers fewer
pings than it is sent. An iPhone where Hearth was swiped away in the app
switcher gets none until it is opened. The ping goes every interval, five
minutes by default and never under two or over ten whatever a circle says,
and every two minutes by default to a phone whose last fix had it on the move
(`PING_MOVING_INTERVAL_SECONDS`). A
phone that stops answering is asked every half hour once twelve have gone
unanswered, and every three hours once sixty have, for as long as it stays
signed in, so a phone that was only flat comes back. A phone in no circle is
not asked, nor one that said sharing is switched off and has sent no fix
since.

The app registers its push token even when the person turns notifications
down. A silent push needs no alert permission on iOS or Android, so a phone
that declined alerts is still pinged, and only the visible alerts are lost.

A silent push that can't be delivered in time is dropped rather than arriving
late, a watch or a wake after five minutes. A late one would turn on the
GPS for somebody who stopped looking long ago. The server also holds pushes back
so they don't pile up. Opening the map skips any phone that reported in the last
two minutes and pushes each of the others at most once every ten minutes. A
member's page skips a phone that reported in the last half minute and pushes it
at most once a half minute. Before any push for those two, the server waits up
to three seconds for the phone to say it has the ask over its own line, and
pushes at once if it doesn't, so an iPhone iOS has suspended is reached in
seconds. Live pushes again only once the phone has said nothing for 20 seconds
and the last push went 90 seconds ago, and no more than three times in its
ten-minute window.

With `ntfy` or `none`, only the phone's own line carries an ask, and that is
open only while Hearth is. Every other phone waits for its next report from the
background task.

## Ask for location and quick messages

_Ask for location_ and a quick message are the same thing on the wire: an alert
aimed at one member, recorded in the activity feed as `nudge_requested`. A bare
ask arrives as "Location requested" with "Amina asked where you are." A quick
message arrives with the sender's name as the title and the line they sent as
the body. `data` carries the id of the feed entry and who sent it. Tapping it
opens the map, which is where the app plays the message. An account can send
ten in ten minutes, and the app keeps each phone to six and says to wait
rather than send one the server would refuse. The same words to the same person
within a minute are sent once. A quick message reaches somebody who has paused
sharing. A bare ask to them is not sent, and the sender is told they paused.

This one is a visible notification, not a silent push, and that changes what
it can do. With the app open, the phone shows the message and takes a fresh
fix at once, whatever the provider. With `expo` the push also reaches the app
in the background. Android hands every Expo push to the app, where the
native push handler takes the fix and then passes the notification on to be
shown. On an iPhone the request is marked content-available, which asks iOS
to run the app for it as it does for a silent wake. Either way the phone takes
a fix as well as showing the message. iOS decides for itself when to run an app for a push, so
an iPhone may still hold it back. Through `ntfy` the app doesn't run, so the
alert alone doesn't produce a fix. A bare ask to somebody sharing precisely
therefore also asks the phone for a fix the way opening the member's page
does, over its control channel or by a silent wake, and the sender's toast
says which happened, or that no phone of theirs could be woken. Somebody
sharing approximately gets the alert alone, so the sender learns nothing
about their phone that the member's page would not show.

Muting "Nudges from your circle" in a circle's notification settings silences
the notification. The activity feed records it either way, so the line is still
there to find.

## Choosing, in one paragraph

If you build the app with your own Expo, Firebase and Apple keys, use `expo`. It
is one environment variable on the server and it is the only option that gives
you the whole app, including phones that report with Hearth closed. If you care
about privacy above all, or have no such keys, run `ntfy` alongside the server
for alerts and accept the limits under Option 2. That's one extra container and
one extra app on each phone. Either way, `none` is a fine way to get everyone
signed in and on the map, but expect phones to fall behind on it once Hearth is
closed, until push is set up.
