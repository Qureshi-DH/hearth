---
sidebar_position: 4
title: Privacy
---

Hearth exists so that a family's whereabouts stay on hardware the family
controls. This is the plain-language version of what the server stores and who
sees it.

## What is stored

| Data                                                                            | Where                               | Retention                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Account: email, display name, scrypt password hash                              | `users`                             | Until the account is deleted                                                                                                 |
| Devices: name, platform, app version, push token, hashed refresh token, last IP | `sessions`                          | Until signed out. Revoked rows pruned 30 days later, expired rows as soon as they lapse                                      |
| Live position (one row per user)                                                | `user_presence`                     | Overwritten by each fix                                                                                                      |
| Breadcrumb history: coordinates, accuracy, speed, heading, battery, activity    | `location_points`                   | Per-circle setting (default 30 d), under a server-wide ceiling (90 d out of the box, admin-editable). 0 = live position only |
| Places and arrive/leave events                                                  | `places`, `place_events`            | Until the place or circle is deleted                                                                                         |
| Activity feed, SOS alerts, check-ins                                            | `events`, `sos_alerts`, `check_ins` | Until the circle is deleted                                                                                                  |
| Quick messages: the line sent, its sender and the member it named               | `events`                            | Until the circle is deleted                                                                                                  |
| Profile picture                                                                 | Object storage, key in `users`      | Until you replace or remove it                                                                                               |
| Trips (aggregates + endpoints)                                                  | `trips`                             | Until the account is deleted. Survive breadcrumb pruning                                                                     |
| Notification outbox (title, body, ids)                                          | `notification_outbox`               | Delivered/failed rows pruned after 7 days                                                                                    |
| Admin audit log                                                                 | `audit_log`                         | Indefinite (operator can truncate)                                                                                           |

Everything but the profile pictures is a row in Postgres. Those are files, so
the server keeps them in S3 compatible object storage, MinIO in the default
stack. The bucket is never public: images are streamed back through the API
under a random key, and the app strips the EXIF by re-encoding the photo before
it uploads, which matters because a phone photo usually records where it was
taken.

No analytics, no crash reporting, no third-party SDKs phone home. The only
outbound connections the server makes are to the push provider you configured
(if any) and the map tile server the _app_ is pointed at.

## Who can see what

A user has one location stream. Each circle sees it through the mode you picked.

Precise is exact coordinates, accuracy, speed, heading, activity, battery,
today's trail and trips. Approximate snaps your position to a deterministic
~750 m grid and reports accuracy as ≥750 m. Speed, heading, activity, trail,
trips, "at a place" and place arrive/leave alerts are all hidden there, though
battery stays visible. Paused is nothing at all. Members see that you paused,
not where.

Going back to precise does not open up the time in between. History and trips
recorded while a circle saw you paused or approximate stay out of that circle's
view, and a place you crossed then is never announced to it.

You always see yourself exactly. Circle admins get _no_ extra visibility into
members' locations. Roles only govern circle management.

A server administrator sees no positions either. The admin screen lists each
account with its email, its number of circles and devices, when it last signed
in, and the longest stretch its phone went without reporting over the last
day. That last figure is measured whatever the sharing mode, so it tells the
administrator whether a phone paused in every circle is still on and
reporting, though never where it is.

SOS is the one exception. Raising an SOS switches the sender to precise sharing
in that circle and notifies everyone regardless of mutes. The sender (or an
admin) resolves it, and sharing stays precise after that until they set it back
themselves.

A quick message wakes only the person it names, but the circle's activity feed
records it with both names and the line itself. It is a short word said in front
of the family rather than a private channel, and there is no chat to read back.

## What leaves the server

Push notifications carry a title, a body and identifiers (`{type, circleId,
eventId?, placeId?, userId?, alertId?, fromUserId?}`). Coordinates are never
included. The app fetches them from your server when the notification is
tapped. Point `PUSH_PROVIDER=ntfy` at your own ntfy instance and nothing leaves
your infrastructure.

Map tiles also leave. The phone requests them from the style URL your server
advertises, OpenFreeMap by default, so the tile host sees the viewed area, as
with any map. Self-host tiles to avoid it.

## Your rights, built in

- `GET /api/v1/me/export` returns your profile, circle memberships,
  breadcrumbs, trips, check-ins and the places you created, as JSON. Also in
  the app under _You → Privacy & data → Export_.
- `DELETE /api/v1/me/history` erases your breadcrumbs, and the trips derived
  from them, and keeps the account.
- `DELETE /api/v1/me` deletes the account. Rows keyed to you go with it:
  sessions, breadcrumbs, trips, check-ins, place history and circle
  memberships. Circles you solely own are deleted, shared circles pass to the
  longest-standing admin. Three things sit outside that. An activity feed line
  in a circle that outlives you loses the link to your account but keeps the
  text it was written with, which usually names you. An admin audit row does
  the same and keeps the IP the action came from. And a profile picture already
  in the bucket is untouched. Nothing points at it once the row is gone and its
  key is random, but removing the object itself is the operator's job.

## Children

Hearth is designed for families and therefore for tracking minors by their
guardians. That's a decision for each family and, in many jurisdictions, a
legal one. The tracked person gets the same controls as everyone else (pause,
approximate, leave) unless an admin of the circle disables pausing. That
setting is visible to every member.

## What the app asks the phone for

Location (foreground, then _Always_) and notifications, plus a
battery-optimisation exemption on Android. Camera only when you scan a QR code,
and the photo library only when you pick a profile picture, through the system
picker that hands back the one file you chose rather than the album.

Motion and activity is the only other one. It is on the setup checklist for
every phone that can classify motion, because it is what lets the GPS sleep
while you are still and what tells crash detection that a drive has started.
The app only ever asks from that checklist, with the reason on screen first.
You can refuse it. The app then works the stop out from position, which costs
more battery, and crash detection cannot run on that phone because nothing
tells it a drive has started.

Hearth never requests contacts, microphone, Bluetooth or an advertising
identifier. Crash detection needs no permission of its own beyond that one: the
accelerometer, gyroscope and barometer need no permission on either platform at
the rates it samples them, so it is listed on the setup checklist instead,
where you can at least see that it is running. See
[the mobile app page](developer/mobile.md#permissions) for the full table and the
reason for each.

## Security summary

- TLS is required in production (phones refuse background HTTP anyway).
- Access tokens expire in 15 minutes. Refresh tokens are single-use and stored
  hashed. Signing a device out invalidates its token and push registration.
- Passwords: scrypt, N=2¹⁵, 64-byte keys, per-user salt.
- Rate limiting per account. Login timing is equalised for unknown emails.
- Authorisation is checked against the database on every request.

Report vulnerabilities per [SECURITY.md](https://github.com/Qureshi-DH/hearth/blob/main/SECURITY.md).
