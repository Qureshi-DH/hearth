# Changelog

Notable changes to Hearth. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Qureshi-DH/hearth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Qureshi-DH/hearth/releases/tag/v0.1.0
