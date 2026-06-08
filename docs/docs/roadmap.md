---
sidebar_position: 7
title: Roadmap
---

v1 ships the core of a family location app, end to end. Nothing below it is
built yet, so read this as intent rather than a promise. Roughly ordered by
value.

## Near term

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
- Battery work beyond the moving and stationary split, which is what pays for
  itself today. The next win is a measured comparison of the OS motion
  classifier against the GPS-only path, so the setting can pick a default
  instead of asking each person to guess.
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
