---
sidebar_position: 7
title: Roadmap
---

v1 ships the core of a family location app, end to end. Nothing below it is
built yet, so read this as intent rather than a promise. Roughly ordered by
value.

## Near term

Measured against the family safety apps Hearth sets out to be a self-hosted version
of, these are the gaps that remain after 0.6.0. The tracker's tiers, places
with arrival and departure alerts, check-ins, SOS, crash detection, low
battery alerts, trips, history, and the member statuses other apps show
("location permission off", "at Home since") are all there.

- Driving events on trips: hard braking, rapid acceleration, phone use while
  driving, and a weekly driving summary. The sensor pass already sees the
  braking; see the item below.
- A time-boxed approximate mode, a "bubble": share a rough area for
  the next few hours and snap back to precise on its own. Pause already has
  a timer; approximate does not.
- A manifest-declared receiver for activity transitions on Android, so a
  car pulling away can relaunch a reclaimed process at a moment Android
  allows the location service to start, rather than waiting for the fence.
- Group messaging inside a circle. Quick messages and check-ins cover the
  short form today.

- Direct APNs / FCM push drivers, so `expo` isn't the only zero-infra option.
  The `PushDriver` interface is one `send()` method. See
  `server/src/services/push.ts`.
- A web client in `apps/web`. Read-mostly map and feed for the desktop, on top
  of the existing API, websocket and Web Push driver. `CORS_ORIGINS` and the
  VAPID plumbing are already in place for it.
- Driving insights. The trip detector already stores max and average speed, and
  the on-device sensor pass already recognises a harsh brake and then throws it
  away, because there is nowhere to put it. Give it a home: count them per trip
  and show them on the trip detail screen.
- Scheduled place alerts, as in "tell me if Sami has not arrived at School by
  08:45". Needs a per-place schedule table and one more job step.
- Maestro E2E flows for the app's critical paths (server → login → circle →
  place → check-in).
- More locales. The i18n scaffold supports them, but v1 is English only.

## Medium term

- Offline map packs via MapLibre's `OfflineManager`, so the map still works in
  the countryside.
- Shared ETA, or "on my way". A check-in variant that publishes a destination
  and live ETA until arrival.
- Battery work beyond the moving and stationary split and the OS motion
  classifier, which are what pay for themselves today. A measured comparison
  of the classifier against the GPS-only fallback would say how much a refused
  permission actually costs.
- An admin web UI. The admin API exists, and a small dashboard would help
  operators who never install the app.
- Circle-level place sharing, meaning you copy a place into another circle.
- End-to-end encrypted history, with client-side keys and the server holding
  only ciphertext, for people who don't trust their own server host. Presence
  would stay plaintext for geofencing, or geofences would move client-side.

## Ideas

An Apple Watch or Wear OS glance. Bluetooth tag support, an ESP32 with GPS
reporting to the same API. Home Assistant integration via the websocket.

Contributions welcome. See [CONTRIBUTING.md](https://github.com/Qureshi-DH/hearth/blob/main/CONTRIBUTING.md).
