---
sidebar_position: 2
title: API
---

Every endpoint lives under `/api/v1` and returns JSON. The authoritative,
always-current reference is the OpenAPI document the running server serves
itself: Swagger UI at `GET /docs`, raw OpenAPI JSON at `GET /docs/json`.

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
access token as `Authorization: Bearer <token>`. It's good for 15 minutes.

Every distinct `deviceId` sent to `/auth/login` or `/auth/register` is a row
on that account's Signed-in devices screen until it is signed out or its
refresh token expires (`REFRESH_TOKEN_TTL_DAYS`, 60 by default). A session you
opened from curl or from Swagger's "Try it out" is one of those rows, so call
`POST /auth/logout` with it when you are done.

A refresh token works once. Presenting a spent one again ends the session,
because a token replayed minutes after it was rotated is in somebody else's
hands. The exception is a replay from the device the session belongs to
inside one access token's lifetime: an Android phone can run two JavaScript
runtimes, and whichever refreshes second presents a token its twin already
spent. Send `deviceId` with the refresh so the server can tell the two apart.

## Endpoint map

| Area      | Endpoints                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System    | `GET /server-info` (public capabilities), `GET /media/*` (stored images), `GET /healthz`, `GET /readyz` and `GET /join/:code` (root, not under `/api/v1`)                                                                              |
| Account   | `GET/PATCH /auth/me`, `POST/DELETE /auth/me/avatar`, `POST /auth/password`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all`, `GET /me/export`, `DELETE /me`, `GET /me/stats`, `DELETE /me/history` |
| Circles   | `GET/POST /circles`, `GET/PATCH/DELETE /circles/:id`, `GET /circles/:id/members`, `PATCH/DELETE /circles/:id/members/:userId`, `PATCH /circles/:id/sharing`, `PATCH /circles/:id/notifications`                                        |
| Invites   | `GET/POST /circles/:id/invites` (list omits revoked, `expiresInHours: null` = never expires), `DELETE /circles/:id/invites/:inviteId`, `GET /invites/:code` (public preview), `POST /invites/:code/accept`                             |
| Locations | `POST /locations/batch`, `GET /circles/:id/locations`, `GET /circles/:id/members/:userId/history`                                                                                                                                      |
| Places    | `GET/POST /circles/:id/places`, `PATCH/DELETE /circles/:id/places/:placeId`, `GET /circles/:id/places/:placeId/events`                                                                                                                 |
| Events    | `GET /circles/:id/events?limit&cursor`, `POST /circles/:id/events/read`, `GET /circles/:id/events/unread-count`                                                                                                                        |
| Nudges    | `POST /circles/:id/nudge/:userId` (one member, no history)                                                                                                                                                                             |
| Safety    | `POST /circles/:id/sos` (3 per 10 min), `POST /sos/:alertId/resolve`, `GET /circles/:id/sos?activeOnly=true`, `POST /circles/:id/check-in`, `GET /circles/:id/check-ins`, `POST /circles/:id/nudge/:userId`                            |
| Trips     | `GET /circles/:id/members/:userId/trips`, `GET /me/trips`, `GET /trips/:tripId`                                                                                                                                                        |
| Push      | `GET /push/config`, `POST/DELETE /push/register`, `POST /push/test`                                                                                                                                                                    |
| Admin     | `GET/PATCH /admin/settings`, `GET /admin/users`, `PATCH /admin/users/:id`, `GET /admin/stats`, `GET /admin/push/queue`, `POST /admin/push/drain`, `GET /admin/audit`                                                                   |

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
down.", "On my way.") or a short line of your own, and a `200` returns
`{ ok: true }`. Sending one records a `nudge_requested` event in the circle's
activity feed, queues a push for the recipient alone, and publishes a `nudge`
frame on the recipient's own topic. Nothing is kept as a conversation, so there
is no endpoint to list them back. The feed entry names both people and quotes
the line, so this is a short word in front of the family rather than a private
channel.

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
set while somebody has the member's page open, see [watching](#watching-a-member).

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
hold the window. The member's phone is asked to report at full accuracy every
few seconds for `DEFAULTS.watchWindowSeconds`: over its control channel when
it has one open (see the websocket section), by a silent push otherwise, and
by its next upload reply either way. The reply is a `WatchResponse`:

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
itself reported stands between it and reporting (`PRESENCE_ISSUES` in the
shared package). A member sharing approximately or paused cannot be watched:
`watching` is false and every other field is empty.

## Asking one phone for a fix

```http
POST /api/v1/circles/:id/members/:userId/refresh
```

Called when someone opens a member's page. The phone is asked for one fix
now, over its control channel when it has one open and by silent push
otherwise, at most once per half minute per phone whoever is looking. The
reply is `{ asked }`: `socket`, `pushed`, `held` (pushed moments ago),
`fresh` (heard from in the last half minute, left alone), `no_device` or
`unsupported`. `POST /circles/:id/locations/refresh` does the same for
every quiet member of a circle when the map opens.

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
| `sos`        | `{ circleId, alert }`                                        |
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
and drops sockets that miss two; each answered ping renews the channel's
stamp on the presence row, valid for 5 minutes, which is what the routes
read to choose the channel over a push.

## Roles

`PATCH /circles/:id/members/:userId` is decided by the _target's_ current rank,
not only the requested one. Admins may rename anyone and demote plain members,
but can never touch the owner or a peer admin. Only the owner grants `admin`.
`{ role: "owner" }` performs an atomic transfer, promoting the target and
demoting the caller to admin in one transaction. A transfer to a non-member is
a `404` and changes nothing.

## Rate limits

Default is 300 requests/minute per account, set by `RATE_LIMIT_MAX`. The
limiter decodes the bearer token itself, so a shared NAT doesn't throttle a
whole household, and unauthenticated calls are counted per IP. `/healthz` and
`/readyz` are exempt, so an uptime check can poll as hard as it likes.

Routes with their own budget:

| Route                             | Limit          |
| --------------------------------- | -------------- |
| `POST /locations/batch`           | 240 per minute |
| `GET /media/*`                    | 600 per minute |
| `GET /join/:code`                 | 60 per minute  |
| `POST /auth/me/avatar`            | 10 per minute  |
| `POST /circles/:id/nudge/:userId` | 6 per 10 min   |
| `POST /circles/:id/sos`           | 3 per 10 min   |
| `POST /push/test`                 | 5 per 5 min    |

Exceeding a limit returns `429`.

The `access_token` query parameter is honoured **only** on the websocket
upgrade, and it's redacted from request logs. Every other route requires the
`Authorization` header.
