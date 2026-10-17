---
sidebar_position: 2
title: API
---

Every endpoint lives under `/api/v1` and returns JSON. The authoritative,
always-current reference is the OpenAPI document the running server serves
itself: Swagger UI at `GET /docs`, raw OpenAPI JSON at `GET /docs/json`. Both
sit at the root rather than under `/api/v1`, and `ENABLE_SWAGGER=false` turns
them off.

Request bodies and parameters are validated with zod. A failure comes back as
`400 { error: { code: "validation_error", details: [{ path, message }] } }`,
and every error shares the shape `{ error: { code, message, details? } }`.

## Authentication

```text
POST /auth/register   { email, password, displayName, inviteCode?, device }
POST /auth/login      { email, password, device }
POST /auth/refresh    { refreshToken, deviceId? }   # single-use, rotates
POST /auth/logout
```

`device` is `{ deviceId, deviceName?, platform?, appVersion?, osVersion? }`.
Responses carry `{ accessToken, refreshToken, expiresIn, user }`. Send the
access token as `Authorization: Bearer <token>`. It's good for 15 minutes by
default (`ACCESS_TOKEN_TTL_SECONDS`).

Every distinct `deviceId` sent to `/auth/login` or `/auth/register` is a row
on that account's Signed-in devices screen until it is signed out or its
refresh token expires (`REFRESH_TOKEN_TTL_DAYS`, 60 by default). A session you
opened from curl or from Swagger's "Try it out" is one of those rows, so call
`POST /auth/logout` with it when you are done.

A refresh token works once. Presenting a spent one again ends the session,
because a token replayed minutes after it was rotated is in somebody else's
hands. The exception is the device the session belongs to, inside one access
token's lifetime: a phone on the road whose refresh reached the server but
whose answer was lost to the network still holds the spent token, and
presents it again at its next upload. That is a retry, and it is answered
with a fresh pair. The pair nobody received is spent by it. The grace is
counted from the rotation the phone missed, not from each retry, and a spent
token is answered this way once. A spent token from any other device, or
from a request that names no device, is refused. Presented more than thirty
seconds after the rotation, it also ends the session. Send `deviceId` with
the refresh so the server can tell these apart.

The admin portal signs in through its own three routes, for administrators
only:

```text
POST /auth/portal/login     { email, password, deviceId }
POST /auth/portal/refresh   { deviceId }
POST /auth/portal/logout
```

The body carries the access token and the user, never the refresh token. That
goes into an `HttpOnly`, `SameSite=Strict` cookie named `hearth_portal`, scoped
to `/api/v1/auth/portal`, and `Secure` when the request is HTTPS or reached the
https public address. The session ends twelve hours after sign-in, and renewing
does not extend it. Refresh reads and rotates the cookie, refuses a request
whose `Origin` names another site, and ends the session if the account is no
longer an administrator. Every open of the portal asks, so with no cookie, or
one whose session is over, it answers `200` with `{ signedIn: false }` and
clears the cookie, rather than a `401`. A tab that signs out, or finds the
session over, tells the browser's other tabs, so they stop without each
learning it from a refused request. Logout needs
only the cookie and refuses another site's `Origin` too. A non-administrator
gets a `403` from login and no session is created. Each sign-in is written to
the audit log.

`POST /admin/users/:id/password` takes `{ password, currentPassword }`, where
`currentPassword` is the administrator's own. A wrong password, here, at
`POST /auth/password` and at `DELETE /me`, answers `401` with the code
`wrong_password`, so a client
can tell it from a session that ran out (`unauthorized`). Ten wrong guesses in a
quarter of an hour answer `429` until the quarter is up.

## Endpoint map

| Area      | Endpoints                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System    | `GET /server-info` (public capabilities), `GET /media/*` (stored images), `GET /healthz`, `GET /readyz` and `GET /join/:code` (root, not under `/api/v1`)                                                                                                                                                                                                                                             |
| Account   | `GET/PATCH /auth/me`, `POST/DELETE /auth/me/avatar`, `POST /auth/password`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all`, `GET /me/export`, `DELETE /me`, `GET /me/stats`, `DELETE /me/history`, `PATCH /me/health` ([what the phone says about itself](mobile.md#what-the-phone-says-about-itself))                                                           |
| Circles   | `GET/POST /circles`, `GET/PATCH/DELETE /circles/:id`, `GET /circles/:id/members`, `PATCH/DELETE /circles/:id/members/:userId`, `PATCH /circles/:id/sharing`, `PATCH /circles/:id/notifications`                                                                                                                                                                                                       |
| Invites   | `GET/POST /circles/:id/invites` (list omits revoked, `expiresInHours: null` = never expires), `DELETE /circles/:id/invites/:inviteId`, `GET /invites/:code` (public preview), `POST /invites/:code/accept`                                                                                                                                                                                            |
| Locations | `POST /locations/batch`, `GET /circles/:id/locations`, `POST /circles/:id/locations/refresh`, `GET /circles/:id/members/:userId/history`, `POST /circles/:id/members/:userId/refresh`, `POST /circles/:id/members/:userId/watch`                                                                                                                                                                      |
| Places    | `GET/POST /circles/:id/places`, `PATCH/DELETE /circles/:id/places/:placeId`, `GET /circles/:id/places/:placeId/events`                                                                                                                                                                                                                                                                                |
| Events    | `GET /circles/:id/events?limit&cursor`, `POST /circles/:id/events/read`, `GET /circles/:id/events/unread-count`                                                                                                                                                                                                                                                                                       |
| Nudges    | `POST /circles/:id/nudge/:userId` (one member, no history)                                                                                                                                                                                                                                                                                                                                            |
| Safety    | `POST /circles/:id/sos` ([one press, every circle](#raising-an-sos)), `POST /sos/:alertId/resolve`, `GET /circles/:id/sos?activeOnly=true`, `POST /circles/:id/check-in`, `GET /circles/:id/check-ins`                                                                                                                                                                                                |
| Trips     | `GET /circles/:id/members/:userId/trips`, `GET /me/trips`, `GET /trips/:tripId`                                                                                                                                                                                                                                                                                                                       |
| Push      | `GET /push/config`, `POST/DELETE /push/register`, `POST /push/test`                                                                                                                                                                                                                                                                                                                                   |
| Admin     | `GET/PATCH /admin/settings`, `GET /admin/users`, `PATCH /admin/users/:id`, `GET /admin/users/:id/sessions`, `DELETE /admin/users/:id/sessions/:sessionId`, `POST /admin/users/:id/sessions/revoke-all`, `POST /admin/users/:id/password`, `GET /admin/circles`, `GET /admin/checks`, `GET /admin/overview`, `GET /admin/stats`, `GET /admin/push/queue`, `POST /admin/push/drain`, `GET /admin/audit` |

`PATCH /admin/settings` takes `serverName`, `registrationMode` and
`maxHistoryRetentionDays`. Whatever it stores overrides the matching environment
variable from then on, with no redeploy. It writes the whole set rather than the
fields you sent, so saving one field pins the current value of the others.

Avatar uploads are `multipart/form-data` with one image field: JPEG, PNG or
WebP, at most 2 MB, and the content type is decided by sniffing the bytes rather
than by trusting the part header. They return `400` on a server with no object
storage configured, which `GET /server-info` reports as `features.avatars`.

A quick message goes to one person, never to the circle.

```text
POST /circles/:circleId/nudge/:userId    { quickKey?, body? }
```

The `:userId` in the path has to be another member of that circle. The text is
either a `quickKey` from `QUICK_MESSAGES` in `packages/shared` ("Please slow
down.", "On my way.") or a short line of your own. With neither, it is a bare
ask for a location. Sending one records a `nudge_requested` event in the
circle's activity feed, queues a visible alert on the `alerts` channel for the
recipient alone, and publishes a `nudge` frame on the recipient's own topic.
Nothing is kept as a conversation, so there is no endpoint to list them back.
The feed entry names the sender and quotes the line, so this is a short word in
front of the family rather than a private channel.

A bare ask also asks the phone for a fix, the same way
[opening the member's page](#asking-one-phone-for-a-fix) does, because a
visible alert moves only an app that gets to run when it lands. The reply is a
`NudgeResponse`.

```json
{ "ok": true, "notified": "sent", "asked": "pushed" }
```

`notified` is `sent`, or `held` when the same sender sent the same words, or
the same bare ask, to the same person within the last minute, in which case
nothing is sent twice. `asked` takes the refresh route's words, which are
`socket`, `pushed`, `held`, `fresh`, `no_device` and `unsupported`. It is
`null` for a message, which asks nothing of the phone. Only a member sharing
precisely has their phone asked. For one sharing approximately the alert goes
and `asked` is `unsupported`, as on the refresh route, because the rest would
say whether their phone is connected or reported a moment ago.

A message reaches a member who has paused sharing, since it says nothing about
where they are. A bare ask to them sends nothing and answers
`{ ok: true, notified: "paused", asked: "paused" }` rather than a refusal.
Somebody no longer in the circle, whose page may still be open, is sent
nothing and answered `notified: "gone"`. A server from before these fields
answers `{ ok: true }` alone.

The route takes `DEFAULTS.maxNudgesPerTenMinutes` per account, nudges and
messages together. The app keeps to `DEFAULTS.phoneNudgesPerTenMinutes` from
each phone and tells the person to wait rather than send one the server would
refuse. See [push notifications](../install/push-notifications.md) for what the
alert does on each provider.

## Uploading location

```http
POST /api/v1/locations/batch
{
  "points": [
    {
      "recordedAt": "2026-09-06T10:15:02.000Z",
      "lat": 51.4545, "lon": -2.5879,
      "accuracyMeters": 12, "speedMps": 1.2, "headingDegrees": 84,
      "batteryLevel": 0.71, "isCharging": false,
      "activity": "walking", "source": "background"
    }
  ]
}
```

Response:

```json
{
  "accepted": 1,
  "rejected": 0,
  "placeEvents": 1,
  "serverTime": "2026-09-06T10:15:03.412Z",
  "policy": { "minUpdateIntervalSeconds": 30, "distanceFilterMeters": 60 },
  "watchedUntil": null
}
```

Points are deduplicated on `(user, device, recordedAt)`, so retrying a failed
upload is safe. The one re-report that is taken is a stop: a fix that arrives
with the same timestamp as one already stored and `activity: "still"` has
its activity and source adopted, because the park fix is taken in the same
tick as the fix that settled the phone and shares its timestamp. Implausible
points (future, >7 days old, out of range) get counted in `rejected` without
failing the whole batch. `policy` is the strictest setting across the
caller's circles, and the device is expected to apply it. `watchedUntil` is
set while somebody has the member's page open, see [watching](#watching-a-member),
and while the member has an SOS open, see [raising an SOS](#raising-an-sos).

Every authenticated upload, whatever it carried, records that the phone was
heard (`user_presence.last_heard_at`). The offline sweep, the wake schedule
and the refresh route measure silence from the later of the last fix and the
last upload, so a phone draining old fixes, or retrying a batch, is a phone
that is alive.

`source` is one of `LOCATION_SOURCES` in `packages/shared` and defaults to
`background`. `heartbeat` marks a fix the app takes on a timer while it is open
and the phone is parked: presence, places, the speed alert and the battery
alert treat it as any other fix. Trip detection ignores it, and so does the
possible-incident check, because a parked phone reporting on a timer says
nothing about how it came to a stop.

## Presence

`GET /circles/:id/locations` returns one `MemberPresence` per member, already
projected for the caller (see `packages/shared/src/types.ts`). `lat`/`lon` are
`null` for paused members. `approximate: true` means the coordinates were
snapped to a coarse grid.

## Watching a member

```http
POST /api/v1/circles/:id/members/:userId/watch
```

Called while someone has a member's Live page open, and every minute after to
hold the window. The member's phone is asked to report at full accuracy, a fix
a second, for `DEFAULTS.watchWindowSeconds`: over its control channel when it
has one open (see the websocket section), by a silent push otherwise, and by
its next upload reply either way. A parked phone goes live too. The reply is a
`WatchResponse`.

```json
{
  "watching": true,
  "seconds": 600,
  "pushed": "sent",
  "lastFixAt": "2026-09-17T14:27:10.000Z",
  "lastHeardAt": "2026-09-17T14:27:11.204Z",
  "activity": "driving",
  "issues": []
}
```

`pushed` says what became of the ask: `socket` when the phone's control
channel carried it, `sent` when this call queued a silent push, `held` when
the phone was pushed moments ago or has uploaded since,
`no_device` when the member has no push token, and `unsupported` when the
push provider cannot carry a silent push. A phone that has not uploaded since
the first push is pushed again after 90 s, three times per window at most.
`lastFixAt` is the last position, `lastHeardAt` the last upload of any kind,
`activity` what the phone last called itself, and `issues` what the phone
itself reported stands between it and reporting, or between it and reporting
well, such as precise location or motion access being off (`PRESENCE_ISSUES`
in the shared package). A member sharing approximately or paused cannot be watched,
so `watching` is false and every other field is empty.

## Asking one phone for a fix

```http
POST /api/v1/circles/:id/members/:userId/refresh
```

Called when someone opens a member's page. The phone is asked for one fix
now, over its control channel when it has one open and by silent push
otherwise, at most once per half minute per phone whoever is looking. The
reply is `{ asked }`: `socket`, `pushed`, `held` (pushed moments ago),
`fresh` (heard from in the last half minute, left alone), `no_device` or
`unsupported`. A member who isn't sharing precisely gets `unsupported`, and so
does somebody who has just left the circle, since the page asks on every
visit.

`POST /circles/:id/locations/refresh` does the same for a whole circle when the
map opens. It asks every member not heard from for two minutes, skips anyone
who has paused, and pushes any one phone at most once every ten minutes. The
reply is `{ asked }`, the number of phones it asked.

## Raising an SOS

```http
POST /api/v1/circles/:id/sos
{ "note": "Hit on Gloucester Rd", "reason": "sos" }
```

One press raises the caller's alert in every circle they are in. With
`reason: "incident"`, which the crash prompt sends when nobody answers it, it
goes to the circles that turned crash alerts on and to the one in the path,
and the app always sends it through one that has them on. Leaving `reason` out
means `"sos"`, except for the exact note an older app's crash prompt sends,
"Possible collision detected automatically. No answer from the phone.", which
is taken as `"incident"`. Every other member of those circles gets
one push, however many of the circles they share with the sender, and each
circle gets a `sos_started` entry. The sender's sharing goes back to precise in
each of them.

The reply is a `RaiseSosResponse`, which is the path circle's `SosAlert` with
`notifiedMembers` added and `alerts`, one `SosAlert` per circle it is open in.
It is `201` when something new was raised and `200` when everything was
already open. A press on an open alert writes nothing and pushes nothing, so a
client retries freely after a lost reply. The route takes 60 requests per
account per ten minutes, and a sixth fresh alert inside ten minutes, raised
after five that were resolved, is answered `429`.

While an alert is open the sender's phone is on Live. Every upload reply names
`watchedUntil` two minutes ahead, and the raise sends a `watch` down the
phone's control channel when one is open. The window never shortens or moves
the one a viewer's [watch](#watching-a-member) holds, and the phone falls back
to its own cadence within two minutes of the alert being resolved.

`POST /sos/:alertId/resolve` from the person who raised it closes their alert
in every circle, each with its own `sos_resolved` entry, and everyone in those
circles gets one notice naming the alert their alarm named. An admin closes the
alert in their own circle only. From the person who raised it, an alert an
admin already closed still closes the rest of theirs, so an app that only
knows that one's id can end the emergency. A resolve with nothing left open
answers `{ ok: true, alreadyResolved: true }`.

## Websocket

```text
GET /api/v1/ws?access_token=<jwt>     (or Authorization: Bearer …)
```

Server → client messages (`WsServerMessage` in the shared package):

| type         | payload                                                      |
| ------------ | ------------------------------------------------------------ |
| `hello`      | `{ userId, serverTime }`                                     |
| `subscribed` | `{ circleIds }`                                              |
| `presence`   | `{ circleId, presences[] }`, sent once per circle on connect |
| `location`   | `{ circleId, presence }`, one member moved                   |
| `event`      | `{ circleId, event }`, new activity-feed entry               |
| `sos`        | `{ circleId, alert }`, an alert raised or resolved           |
| `nudge`      | `{ circleId, nudge }`, on the recipient's own topic          |
| `control`    | `{ command, seconds? }`, to the phone's control channel only |
| `pong`       | `{ serverTime }`                                             |
| `error`      | `{ message }`, the socket could not honour what you sent     |

Client → server: `{ type: "ping" }`, `{ type: "subscribe", circleIds }`,
which may only narrow to circles the user belongs to, and
`{ type: "control" }`, which the phone's tracker sends to declare the socket
its control channel. The server answers `{ type: "control", command: "ready" }`
and from then on delivers `watch` (go live for `seconds`) and `wake` (one fix
now) down that socket and no other, the moment a viewer or the sweep asks.
The server pings on-screen sockets every 30 s and a declared control socket
every 2 minutes, since a phone in a pocket wakes its radio for every answer,
and drops a socket that hasn't answered one ping by the time the next is due.
Each answered ping renews the channel's stamp on the presence row, valid for 5
minutes, which is what the routes read to choose the channel over a push.

`subscribed` is sent again whenever the circles a socket gets change, which is
when the user joins one, is removed from one, or one they were in is deleted. A client
that never narrows its subscription can read it as the whole of its
membership, and the app asks for its circles list again when the two differ,
so it stops polling a circle it is no longer in.

A socket is closed with `4401` when its token or session is no longer good,
which tells the client to get a fresh token before reconnecting. An account
holds at most twelve sockets, and opening another closes the oldest with
`4429`.

## Roles

`PATCH /circles/:id/members/:userId` is decided by the _target's_ current rank,
not only the requested one. Admins may set anyone's nickname but can't change
a role. The owner's role changes only by transfer, and only the owner can
grant `admin` or demote an admin.
`{ role: "owner" }` performs an atomic transfer, promoting the target and
demoting the caller to admin in one transaction. A transfer to a non-member is
a `404` and changes nothing.

## Answers in place of refusals

A home server often sits behind a firewall that blocks an address for a while
after any `4xx`, and every phone in the house shares that address. So a request
the app makes in ordinary use, from a screen that was right a minute ago, is
answered `200` with what became of it. Bad input, a wrong password and a
missing session are still errors.

- `GET /circles/:id/members/:userId/trips` and `.../history` answer `[]` for a
  member sharing approximately or paused, in a circle with history off, or who
  has left the circle.
- `GET /trips/:tripId?soft=true` answers `{ id, visible: false }` for a trip
  the caller can no longer see, or one that is gone because a late backlog
  folded it into its neighbour. Without `soft=true` those stay `403` and `404`,
  which is what older apps handle. A trip that is served carries
  `visible: true`.
- `PATCH /circles/:id/places/:placeId` answers `{ id, gone: true }` for a place
  somebody else deleted, and `DELETE` answers `{ ok: true, gone: true }`.
- `GET /media/*` answers a picture that is no longer stored with one transparent
  pixel, `x-hearth-media: missing` and `cache-control: no-store`. Other phones
  hold the old address until their roster refreshes. Storage that is failing
  answers `503` instead, since a phone keeps an image under its address and
  would go on showing the blank once storage is back.
- `POST /circles/:id/nudge/:userId` answers `notified: "gone"` for somebody no
  longer in the circle.
- `GET /invites/:code` says `reason: "removed"` to a signed-in viewer the circle
  removed, holding a code made before that, so the app never offers a join
  that would be refused.
- `GET /admin/overview?tz=` draws a zone the database does not know in UTC and
  says so in `timeZone`.
- `DELETE /admin/users/:id/sessions/:sessionId` answers a device that already
  signed out with `{ ok: true, alreadySignedOut: true }`.
- `DELETE /me` with a wrong password answers `wrong_password`, so the app does
  not mistake it for a token that ran out and send it twice.
- `POST /auth/portal/refresh` and the nudge and refresh routes are described in
  their own sections above.

The app does its share. It renews and resends only on a `401` whose code is
`unauthorized`, never retries a `4xx` other than a `408`, stops asking about a
circle once its circles list no longer holds it, and asks for that list again,
at most once in half a minute, when a circle's query is answered `403`. It
keeps nudges, exports, test notifications and the map's asks for fresh fixes
under the routes' limits and tells the person to wait instead.

## Pagination

The activity feed is the one list with a cursor. `GET /circles/:id/events`
takes `limit` (1 to 200, 50 by default) and `cursor`, and returns
`{ items, nextCursor }` (`Paginated<T>` in the shared package), newest first.
Pass `nextCursor` back as `cursor` for the next page. It is `null` on the last
one. Every other list returns a plain array, capped by `limit` where the route
takes one. History and trips also take `from` and `to`, and history covers the
last 24 hours when neither is given.

## Rate limits

Default is 300 requests/minute per account, set by `RATE_LIMIT_MAX` and
`RATE_LIMIT_WINDOW`. The limiter decodes the bearer token itself, so a shared
NAT doesn't throttle a whole household, and unauthenticated calls are counted
per IP. `/healthz` and `/readyz` are exempt, so an uptime check can poll as
hard as it likes.

Routes with their own budget:

| Route                                                                                                | Limit                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/password`, `DELETE /me` | 30 per minute, or `RATE_LIMIT_MAX / 20` if that is more |
| `POST /locations/batch`                                                                              | 240 per minute                                          |
| `POST /circles/:id/locations/refresh`                                                                | 120 per 10 min                                          |
| `POST /circles/:id/members/:userId/refresh`                                                          | 180 per 10 min                                          |
| `POST /circles/:id/members/:userId/watch`                                                            | 60 per 10 min                                           |
| `GET /media/*`                                                                                       | 600 per minute                                          |
| `GET /join/:code`                                                                                    | 60 per minute                                           |
| `POST /auth/me/avatar`                                                                               | 10 per minute                                           |
| `GET /me/export`                                                                                     | 3 per 10 min                                            |
| `POST /circles/:id/nudge/:userId`                                                                    | 10 per 10 min, and the app keeps to 6 per phone         |
| `POST /circles/:id/sos`                                                                              | 60 per 10 min, and 5 fresh alerts                       |
| `POST /push/test`                                                                                    | 5 per 5 min                                             |

Sign-in is also held to 8 attempts per 5 minutes for one email from one
address, and 100 per hour for one email from anywhere. Exceeding a limit
returns `429`.

The `access_token` query parameter is honoured **only** on the websocket
upgrade, and it's redacted from request logs. Every other route requires the
`Authorization` header.
