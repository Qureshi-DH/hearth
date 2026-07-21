# Changelog

Notable changes to Hearth. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A driving tier. While the phone is in a vehicle the tracker uses the GPS,
  reports every ten seconds with a filter that follows the speed, and defers
  nothing, so the map shows a driver on the road with a real speed. Nowhere
  else is the GPS on

- A silent wake. A phone quiet for half an hour is sent a push with nothing
  to show, and answers it with a fix from the background, even with the app
  closed. A phone is only reported offline once it has ignored both its own
  heartbeat and the wake
- The admin screen shows each account's longest silence over the last day

### Fixed

- The exit fence around a parked phone is 200 metres on iOS, which is the
  smallest region iOS reliably reports leaving
- A parked phone was reported offline to its family. The location service used
  to stop altogether once the phone had settled, leaving its next report to
  the OS task schedulers, and Doze and iOS both let it sit for over an hour.
  The service now steps down to a cheap Wi-Fi grade watch instead and checks
  in every quarter hour. On Android the notification therefore stays while
  parked, collapsed and silent as before

## [0.3.2] - 2026-07-12

The second day on two phones. The server change is the low battery text.

### Changed

- Directions on a member's page offer Google Maps on iOS too, when it is
  installed, next to Apple Maps
- Alerts fade and settle in rather than appearing in one frame
- The Change password sheet is titled like the Name prompt beside it
- A low battery alert names the phone it is about, so it reads on its own in
  the tray next to everything else
- The map banner for your own SOS says it is yours and takes you to the
  screen where you can call it off, instead of telling you that you need help

### Fixed

- On iOS, "I'm safe now" on the SOS screen did nothing until the screen was
  closed, and then showed one confirmation for every tap. Alerts now draw in
  a window above native modal screens, and a repeated tap does not queue
  another copy
- Saving from a sheet's button left the keyboard up after the sheet had gone
- The You screen shifted every thirty seconds while the app was open, because
  the tracking row grew a "queued" note for the instant a heartbeat fix waited
  to upload

- Tapping a member on the map did nothing but move the camera. On Android the
  map received the same tap and cleared the selection at once, so the member
  card never appeared. A tap now flies to them and names them at the top of
  the sheet, a second tap on them or on the card opens their page, and a row
  in the list opens the page as its chevron promised

## [0.3.1] - 2026-07-08

Faster alerts on the server, and the app fixes from a day of using it on a
phone. The server carries a migration.

### Added

- Confirmations, prompts and option sheets are drawn by the app in its own
  theme rather than by the system, so they look the same on both platforms

### Changed

- Notifications go out the moment the event that caused them is committed.
  Postgres wakes the worker instead of the worker checking every minute, sends
  run several at a time, and the most urgent go first. Every notification is
  now sent at high priority, so a phone in Doze shows it at once
- The Android notification shown while a journey is being followed no longer
  puts an icon in the status bar. Android will not run background location
  without a notification, so it cannot go away entirely, but it now sits
  collapsed in the silent part of the shade
- Deactivating a user or changing who is an admin asks first

### Fixed

- Every prompt sheet crashed the moment it opened, because the sheet host sat
  outside the theme. The Android back button now closes a sheet instead of
  the screen under it
- The battery optimisation row on the setup checklist read On with a Review
  link beside it as soon as the dialog had been shown. It now reads what the
  OS says
- The SOS notification channel asked for a sound file called default, which
  does not exist, and so had no sound

## [0.3.0] - 2026-06-30

The first round of fixes from using the app on a real phone, and a new app
identifier. Servers must update to this version before phones do, because the
new app reports heartbeat fixes that an older server rejects.

### Added

- A heartbeat location source. While the app is open and the phone is parked
  it takes one cheap fix at the circle's interval, so your own row no longer
  goes stale on the map. Trip detection and the possible-incident check both
  ignore those fixes, since a phone reporting on a timer says nothing about how
  it came to a stop

### Changed

- The phone's motion classifier is no longer a switch on the You screen. It
  runs whenever location sharing does, and the Motion and Fitness or physical
  activity permission is asked for on the setup checklist like location is.
  Refusing it leaves the phone working stops out from position, as before.
  Existing installs are walked through the checklist once more to see the new
  row
- The tracker only ever checks the motion permission. The checklist's Allow
  button is the one place that asks, so a background wake can no longer make a
  request that Android answers as denied without showing a dialog
- The app identifier is now `com.binary.rewind.hearth` on both platforms. A
  build with the new id installs beside the old one rather than over it, so
  remove the old app once you have signed in on the new one

### Fixed

- Sheets that a screen mounts hidden and shows later, such as the display name,
  server name, history retention and member nickname prompts, never opened.
  Every one of them opens now, and opens again after being swiped away
- Text fields inside a sheet now rise with the keyboard, and the first tap on
  Save lands while the keyboard is up. Change password gained the subtitle and
  spacing the other sheet forms have, and shows the server's error instead of
  a red hint
- Your own row on the map read as stale after fifteen minutes with the app open
  and the phone parked. See the heartbeat entry above
- The members sheet on the map stopped short of the status bar when expanded,
  and the map controls slid under the bar. The sheet now meets the bar and the
  controls stop level with the circle switcher and fade out
- Signed-in devices printed the raw platform name for a session without a
  device name, and the sign-out confirmation for such a row was blank

- Signed-in devices no longer lists a session whose refresh token has lapsed.
  It could not sign in again, so it was never a device to sign out

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
