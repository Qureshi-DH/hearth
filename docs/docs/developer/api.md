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
POST /auth/refresh    { refreshToken }              # single-use, rotates
POST /auth/logout
```

`device` is `{ deviceId, deviceName?, platform?, appVersion?, osVersion? }`.
Responses carry `{ accessToken, refreshToken, expiresIn, user }`. Send the
access token as `Authorization: Bearer <token>`. It's good for 15 minutes.

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
  "policy": { "minUpdateIntervalSeconds": 30, "distanceFilterMeters": 60 }
}
```

Points are deduplicated on `(user, device, recordedAt)`, so retrying a failed
upload is safe. Implausible points (future, >7 days old, out of range) get
counted in `rejected` without failing the whole batch. `policy` is the
strictest setting across the caller's circles, and the device is expected to
apply it.

## Presence

`GET /circles/:id/locations` returns one `MemberPresence` per member, already
projected for the caller (see `packages/shared/src/types.ts`). `lat`/`lon` are
`null` for paused members. `approximate: true` means the coordinates were
snapped to a coarse grid.

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
| `pong`       | `{ serverTime }`                                             |
| `error`      | `{ message }`, the socket could not honour what you sent     |

Client → server: `{ type: "ping" }` and `{ type: "subscribe", circleIds }`,
which may only narrow to circles the user belongs to. The server pings every
30 s and drops sockets that don't answer.

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
