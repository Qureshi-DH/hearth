---
sidebar_position: 1
slug: /
title: Introduction
---

Hearth is family location sharing that runs on your own hardware. A live map of
the people in your circle, alerts when somebody arrives at or leaves a place,
an SOS button, and a history of trips. All of it in a Postgres database you own.

A tracker is only as private as whoever runs it. Commercial trackers keep every
position, arrival and drive on servers you do not control, under a policy they
can change. Hearth has no company on the other end. There is no Hearth account,
no analytics, no ad network and no crash reporter anywhere in it.

## The two pieces

The **server** is a Fastify API that runs in Docker next to Postgres and a small
S3-compatible object store for profile pictures. It is published as
`dhqureshi/hearth-api` for amd64 and arm64, so running it needs no clone.

The **app** is an iOS and Android build made with Expo. It talks to your server
and to nothing else, and you type your server's address in on first launch.
There is nothing in between: no relay, no broker, no account with anybody.

## What it does for a family

- **A live map.** Each member's position, battery, whether they are walking or
  driving, and how long ago the fix arrived. Updates arrive over a websocket
  while the app is open and by push when it is not.
- **Places.** Draw a circle around home, school or work and everyone is told on
  arrival and departure. Leaving needs about 40 metres more than arriving, so a
  phone resting on the boundary does not spam the circle.
- **Sharing modes, per circle.** Precise, approximate or paused. Approximate
  snaps you to a 750 metre grid and hides your trail, your trips and which place
  you are at. Paused shares nothing. Everyone can see which mode you picked.
- **SOS.** Hold for three seconds and the circle gets a high-priority alert with
  your position, refreshed every 20 seconds until it is cleared. SOS overrides a
  paused state, because an emergency is not the moment to respect ghost mode.
- **Check-ins, nudges and quick messages.** One tap to say you are fine, a way
  to ask a phone for a fresh fix, and a one-tap word to one person, "On my way"
  or "Please slow down", which plays on their map for a moment, arrives as a
  notification, and is recorded in the activity feed.
- **Driving alerts, off until you turn them on.** A speed threshold, and an
  incident heuristic that asks you first and only ever suggests going to check
  on someone.
- **Trips, history and export.** Journeys are worked out on the server from
  breadcrumbs. History is kept for as long as each circle asks for, 30 days out
  of the box, under a server-wide ceiling that starts at 90. Export everything
  as JSON, wipe your history, or delete your account.

## What it deliberately does not do

There is no hosted version to sign up for, and no browser dashboard. Nobody
operates Hearth as a service, which is the point, and the map lives in the phone
app while the server just serves an API.

There is no chat either. Everyone already has a messenger, and a family map does
not need to be a second one. A quick message is one line to one person, seen
once and then only in the feed, so there is no thread to keep up with.

Nothing phones home. No analytics, no crash reporting, no third-party SDKs. Two
things do leave your server, and both are your choice: map tiles come from the
style URL your server advertises (OpenFreeMap by default, self-hostable), and
push payloads go through a relay only if you configure one. Those payloads carry
names and identifiers, never coordinates. See [Privacy](../privacy.md).

## What it costs you to run

Being the operator is real work, so here is the honest list.

**A machine that stays up.** When the server is down, nobody can see anybody and
no alert fires. Power cuts, upgrades and a dead broadband line are now yours.
Backups are too, and Postgres holds everything except the profile pictures.

**Remote access.** Phones will not talk to a plain HTTP server in the
background, so you need TLS with a real certificate before you invite anyone.
That means a reverse proxy and a domain, or a tunnel or VPN. See
[Remote access](../install/remote-access.md).

**Waking a sleeping phone.** That last hop belongs to Apple and Google, and it
is the one part a self-hoster cannot fully own. The default is no push at all,
which still works while the app is open. [Push
notifications](../install/push-notifications.md) covers the options.

**Building the app.** Hearth is alpha and is not on either store yet, so you
build the app yourself from source. It has not had a security audit, and Android
has seen less real-device testing than iOS.

Registration is invite-only by default, and the first admin account is created
from your environment file before the first boot, so a server you have not
claimed cannot be claimed by whoever finds the URL.

## Next

[Quick start](quick-start.md) gets a server running and a phone connected. For
the full deployment, TLS, backups and upgrades, go to
[Self-hosting](../install/self-hosting.md).
