# Changelog

Notable changes to Hearth. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-26

A correctness and security pass over the server, the alert logic and the mobile
app. This release fixes 58 defects and adds the tests that hold them in place.

### Security

- A single websocket frame from any signed-in account could take the whole
  server down, ending live location, SOS and check-ins for every family on it
- The activity feed and the place-events endpoint ignored the target's sharing
  state, so a circle somebody had stepped back from could still read the named
  places they had been to
- A timed pause that lapsed resolved to precise rather than to the state it
  replaced, handing exact coordinates to a circle that had been given a grid
  square. Fixed in all three places that resolve it
- Server-admin was read from the access token rather than the database, so
  demoting an administrator did not demote them, and within the token's life
  they could promote themselves back permanently
- The login throttle no longer believes a forwarded address from anywhere but a
  proxy on a private network
- Refresh tokens rotate with the superseded hash remembered, so a replay is told
  apart from a phone retrying a response it never received

### Fixed

- A car passing through a tunnel read as a crash, because a fix carrying no
  speed was treated as a measured zero rather than as unknown
- An ordinary arrival raised a crash alert off a single stray sample. Two fixes
  now have to agree before a speed is evidence
- Alert cooldowns lived on the account, so the first circle told spent the
  cooldown for every other circle, and a circle that was paused at that moment
  heard nothing for the rest of the drain. Speed and battery latches are per
  circle now
- Trips merged every device on an account, so a tablet left at home teleported
  the driving phone's route and inflated its distance and average speed
- A completed trip was never announced at all
- Pausing sharing and resuming it announced a fresh arrival at a place the
  member had never left
- Driving past a place no longer buzzes the family. The entry push is held for
  the length of a transit and cancelled by the departure

### Changed

- Member rows, the activity feed and the map no longer re-render on every
  location frame
- The background sync task stops waking the GPS once the phone signs out
- The location queue no longer rewrites itself in full on every fix

## [0.1.3] - 2026-06-25

Everything since 0.1.0. The 0.1.1 and 0.1.2 images went out without release
notes, so this covers all three.

### Added

- Nudges. A one-tap prod that plays on the recipient's map, buzzes their phone
  and lands in the feed. It always goes to one person
- Crash detection that keeps running with the screen off, using a small native
  module that samples the accelerometer, gyroscope and barometer itself
- SOS is marked time sensitive on iOS, and goes out on an Android channel that
  bypasses Do Not Disturb
- Profile pictures, stored in any S3 compatible bucket
- A documentation site, and a landing page for the project
- Android and iOS build profiles, so a release artifact is one command
- The motion permission is on the setup checklist, and the app notices when
  location access is taken away later

### Changed

- Location tracking only runs while the phone is moving, which is most of the
  battery saving
- The first account no longer bypasses the invite gate. An admin account is
  created from the environment instead
- The account export streams rather than loading a whole history into memory,
  and is no longer silently cut off at 100,000 points
- Trips are detected per device, so a tablet left at home stops inflating the
  distance of the phone's drive
- Possible-incident alerts need a stop that lasted, not just a fast fix
  followed by a slow one
- The seven migrations collapsed into a single init. Nothing had been deployed,
  so there was no database to preserve

### Removed

- In-app messaging. Nudges replaced it, and nothing is stored to catch up on
  later

### Fixed

- Geofences no longer freeze on a small place when a fix is coarse, and a
  member who stops sharing precisely stops being reported as inside one
- The retention sweep no longer lets one large account starve the others
- Offline alerts are no longer withheld when a household is simply asleep
- Failures in the app that used to disappear are shown

### Security

- The credential routes are rate limited, and an admin can no longer lock every
  other admin out
- Revocation is enforced on the request path rather than only at refresh

## [0.1.0] - 2026-04-28

First alpha. Everything below is built and tested, but the project has not had a
security audit and there are no store builds yet.

### Added

- Circles with owner, admin and member roles, invite codes, QR joining and deep
  links
- Background location tracking on iOS and Android with an offline queue and a
  server-driven update policy
- Live map over a websocket, with battery, activity and staleness per member
- Per circle sharing modes: precise, approximate on a 750 metre grid, or paused
- Places with arrive and leave events, using hysteresis so a phone on a boundary
  doesn't flap
- SOS with a three second hold, twenty second live pings, and an override of a
  paused sharing state
- Check-ins and location requests
- Messages per circle with one-tap canned replies
- Speed alerts and possible-incident alerts, both off by default
- Trip detection from breadcrumbs, with distance, duration, speeds and endpoints
- Activity feed with unread counts and per member notification mutes
- Push notifications through Expo, self-hosted ntfy, or Web Push, with a durable
  outbox that survives a provider outage
- Data export, history erasure and account deletion
- Admin API and screen for stats, users, registration mode and the push queue
- Docker Compose stack with optional ntfy and Redis overlays

### Security

- Refresh tokens are hashed at rest and rotated on every use
- Passwords use scrypt from Node's standard library, so the image builds on ARM
  without a toolchain
- Every circle route re-checks membership against the database rather than
  trusting the token
- Push payloads never carry coordinates

[Unreleased]: https://github.com/Qureshi-DH/hearth/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Qureshi-DH/hearth/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Qureshi-DH/hearth/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/Qureshi-DH/hearth/releases/tag/v0.1.0
