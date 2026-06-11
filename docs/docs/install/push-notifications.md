---
sidebar_position: 3
title: Push notifications
---

Push is the one part of a family tracking app you can't just run on your own box.
The last hop, waking a phone that's asleep in someone's pocket, belongs to Apple
(APNs) and Google (FCM). This document covers what Hearth does about that, what
your options are, and which one to pick.

## In short

| Provider (`PUSH_PROVIDER`) | Works on                                       | Needs a third party?            | Effort | Privacy                        | Reliability on a sleeping phone                                                            |
| -------------------------- | ---------------------------------------------- | ------------------------------- | ------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `none` (default)           | iOS, Android                                   | No                              | Zero   | Best                           | None. Alerts appear when the app is opened, and the map still updates live while it's open |
| `ntfy`                     | Android fully, iOS via the ntfy app            | No, you host ntfy too           | Low    | Best                           | Excellent on Android (UnifiedPush), good on iOS                                            |
| `expo`                     | iOS, Android                                   | Yes, Expo's relay then APNs/FCM | Low    | Payload metadata transits Expo | Excellent                                                                                  |
| `webpush`                  | Browsers, Android via UnifiedPush distributors | Browser vendor's push service   | Medium | Good                           | Good in browsers, not for the native app                                                   |
| Direct APNs + FCM          | iOS, Android                                   | Yes, Apple + Google accounts    | High   | Payload transits Apple/Google  | Excellent                                                                                  |

Start with `none`, which needs no configuration at all. Move to `ntfy` when you
want real background alerts without handing anything to a third party. Use
`expo` if you'd rather have zero infrastructure and don't mind Expo relaying the
notification text, which is short and not sensitive.

All providers share the same server-side pipeline. Events are written to a
durable `notification_outbox` table in the same transaction as the thing that
caused them, and a background worker drains it with exponential back-off. A
broken push provider never fails a user's request and never loses an alert. It
just delays it.

## What a notification actually contains

Hearth keeps push payloads deliberately boring:

- title: `"Home"` / `"Low battery"` / `"🚨 SOS from Amina"`
- body: `"Amina arrived at Home"` / `"Their phone is at 12%."`
- data: `{ type, circleId, eventId, placeId?, userId? }`, identifiers only

**Coordinates are never included in a push.** The phone fetches the actual
position from _your_ server when the notification is tapped. So even the
third-party options below only ever see a name and a place label, not where
anyone is. If that's still too much for your threat model, use `ntfy`.

## Option 1: `none` (no background push)

Set nothing. The app still holds a websocket to your server while it's in the
foreground, so the map and activity feed update in real time. It also polls
presence on a slow timer in case that socket is dead, and shows
arrive/leave/SOS as in-app banners while open.

What you lose is alerts while the phone is locked. For a household that mostly
opens the app to _check_ where people are, that's often fine.

## Option 2: `ntfy` / UnifiedPush (recommended self-hosted path)

[ntfy](https://ntfy.sh) is a small open-source pub/sub server. The phone holds a
long-lived connection to _your_ ntfy instance, or on Android a single shared
connection via the UnifiedPush distributor, and messages arrive instantly even
from a locked screen.

How Hearth uses it:

1. `PUSH_PROVIDER=ntfy`, `NTFY_BASE_URL=https://ntfy.your-domain.example`.
2. When a device registers, the server derives an unguessable per-device topic
   (`hearth-<sha256(secret + sessionId)>`), so clients can't choose a topic
   someone else could subscribe to.
3. The app shows the user the topic and a "Subscribe in ntfy" button. The ntfy
   app (F-Droid / Play / App Store) handles background delivery.
4. Hearth publishes to `NTFY_INTERNAL_URL` (e.g. `http://ntfy:80` inside the
   compose network) if set, else to `NTFY_BASE_URL`.

Lock it down. Run ntfy with `NTFY_AUTH_DEFAULT_ACCESS=deny-all`, create a user
for Hearth with write access to `hearth-*`, and give the phones read-only access
tokens. The compose overlay `docker-compose.ntfy.yml` in the repository starts
ntfy with auth enabled, and its comments carry the `ntfy user add` and
`ntfy access` commands. Put `NTFY_TOKEN` in `.env` so the server authenticates
when publishing. `NTFY_TOPIC_PREFIX` renames the `hearth-` part if you are
sharing an ntfy instance with something else.

Android is the good case here. UnifiedPush is battery-friendly and instant. iOS
works through the ntfy iOS app, which itself uses APNs via ntfy's public
instance for the wake-up signal _unless_ you configure your ntfy server's
`upstream-base-url`, so read ntfy's iOS docs first. The _content_ still comes
from your server either way. The real cost is that everyone installs a second
app, which for a family is a one-time setup step.

## Option 3: `expo` (Expo's hosted push relay)

The Hearth app is built with Expo, so `expo-notifications` can hand you an
`ExponentPushToken[...]`. Your server POSTs to `https://exp.host/--/api/v2/push/send`
and Expo relays to APNs/FCM using credentials attached to your Expo project.

Setup, if you are building the app yourself:

1. `cd apps/mobile && eas init` for an Expo project id. The free tier is fine.
2. For Android, create a Firebase project, add an Android app with the package
   name from `app.json`, and put the downloaded `google-services.json` in
   `apps/mobile/`. It is gitignored on purpose, so a build from a fork registers
   devices in that fork's Firebase project rather than somebody else's.
   `google-services.example.json` shows the shape. Then upload the FCM V1
   service account key to Expo with `eas credentials -p android`. Without that
   upload, tokens register and nothing is ever delivered.
3. For iOS, `eas credentials -p ios` and let EAS hold the APNs key.
4. Set `PUSH_PROVIDER=expo` on the server, plus `EXPO_ACCESS_TOKEN` if you
   enabled enhanced push security on your Expo account.

Both the project id and `google-services.json` are compiled into the build, so
a build made before you configured them cannot deliver push no matter what the
server is set to. The service account key and the APNs key are the two real
secrets here and neither belongs in the repository.

You get zero infrastructure and the best out-of-the-box reliability on both
platforms. The price is that Expo sits in the delivery path and sees the device
token, title, body and the id-only `data` field. It doesn't see coordinates.
Expo does not charge for push at the volumes a family generates, though
that is their pricing to change and not something this project controls.

## Option 4: `webpush` (VAPID Web Push)

Standard Web Push with your own VAPID key pair. The server is fully
self-contained (`npx web-push generate-vapid-keys`), but delivery still goes
through the browser vendor's push service (Mozilla, Google, Apple). It's the
right transport for a future **web client**, and it also works with UnifiedPush
distributors on Android that speak Web Push. The native app doesn't use it.

## Option 5: direct APNs + FCM (not implemented in v1)

You can bypass Expo and talk to Apple and Google yourself. APNs wants
token-based auth with a `.p8` key from a paid Apple Developer account, over
HTTP/2 to `api.push.apple.com`. FCM HTTP v1 wants a Firebase project and a
service account JSON, with OAuth2 to `fcm.googleapis.com`.

That gets Expo out of the path. What it costs you is two vendor accounts,
credential rotation, and platform-specific payload formats. The `PushDriver`
interface in `server/src/services/push.ts` is small, one `send()` method, so
`apns` and `fcm` drivers are the natural next additions and are on the roadmap.
If you need this today, the cleanest route is a UnifiedPush-style bridge or
ntfy.

## Silent pushes and "nudges"

When a member taps _Ask for location_, the server queues a high-priority push
with `data.type = "nudge"`. On receipt the app takes a fresh high-accuracy fix
and uploads it. Whether that wakes a backgrounded app depends on the provider:

- `expo`: yes on both platforms (`priority: high`).
- `ntfy`: yes on Android. On iOS the user must tap the notification.
- `none`: only if the app is in the foreground, via the websocket.

## Choosing, in one paragraph

If you're running Hearth on a NAS for your own family and you care about privacy
above all, run `ntfy` alongside it. That's one extra container and one extra app
on each phone. If you'd rather never think about it, `expo` is one environment
variable and works everywhere. Either way, start with `none`, get everyone on
the map, and add push once the basics are solid.
