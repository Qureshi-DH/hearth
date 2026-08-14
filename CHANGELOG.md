# Changelog

Notable changes to Hearth. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-08-14

Why the family's phones went silent, taken apart and put back. Servers must
update before phones: the app reads `pushed` and `lastHeardAt` off the watch
reply, and the batch route now records every upload.

### Added

- A phone that uploads has been heard, whatever it uploaded. The server
  records the moment (`user_presence.last_heard_at`, migration 0007) and
  measures silence from the later of the last fix and the last upload, so
  a phone retrying a batch or draining old fixes is never called offline.
- The watch reply says what became of the phone: whether a silent push was
  `sent`, `held` because one went moments ago or the phone has uploaded
  since, or impossible for want of a push token (`no_device`) or a provider
  that can carry one (`unsupported`), along with the last fix, the last time
  the phone spoke, what it was doing, and what it said stands in its way.
  A phone that has not uploaded since the first push is asked again after
  ninety seconds, three times per window at most.
- A phone can report that its background activity is restricted, that a
  power saving mode is on, which vendor made it, and that its location
  service was stopped without being asked. The circle sees these under the
  member's name and the offline alert names them.
- `POST /auth/refresh` takes the device id. A spent refresh token replayed
  by the device the session belongs to, inside one access token's lifetime,
  is a phone racing itself between two runtimes and is refused without
  ending the session. From anywhere else it still ends the session.

### Changed

- One speed rule for the speed alert and the trip card (`agreedMaxSpeedMps`
  in the shared package). Fixes that measured a speed are paired across any
  that measured none, two readings within a tenth of each other stand at the
  faster and any other pair at the slower, and the answer is floored at the
  ground covered between two sharp fixes. A drive announced at 92 km/h was
  filed with a top speed of 21, below its own average, because the card
  paired only adjacent fixes and every road-speed fix on a mixed GPS and
  network stream sat between two that carried no speed.
- Parked is judged from everything the server knows, not from the one label
  the phone may never have managed to send: the last fix said "still", or
  the member is inside a named place, or the last fix measured under 1 m/s
  with an accuracy of 250 m or better. A parked phone gets the twelve-hour
  rule; one last seen on the road, the hour.
- A phone the server can push is only called offline after two wakes have
  gone unanswered. Wakes follow a schedule measured from when the phone was
  last heard: at 10, 20 and 40 minutes for a phone last seen moving, every
  half hour up to three times for a parked one, and the count starts again
  the moment the phone uploads anything. One wake per silence, and one lost
  push, used to be "stopped reporting" at 61 minutes.
- The park fix lands even when it shares its timestamp with the fix that
  settled the phone, which on Android it always does. A stop re-reported at
  the same instant adopts "still" onto the stored fix and the presence row,
  instead of being dropped as a duplicate and leaving the phone "driving"
  at Home for the offline sweep to judge by the wrong rule.
- Silent pushes carry a lifetime: a minute for a watch, five for a wake, ten
  for a nudge. A wake held back by Doze used to be delivered whenever, up to
  weeks later. On iOS a content-available push travels at normal priority,
  which is what Apple documents for a background push; Android stays high.
  The per-phone guards count only pushes that are in flight or went, so a
  push skipped for want of a token no longer holds the next one back for
  ten minutes.
- The speed alert is gated on the device's own history rather than the
  member row, so a tablet landing a fix a moment after the phone's batch
  cannot swallow the phone's fast run.
- The tracker no longer goes quiet at home. On Android the location
  foreground service stays up for as long as sharing is on, in every tier,
  with one silent notification in the shade; without it Android treated the
  phone as a background app and throttled or refused every way it had to
  report, which is how a family member sitting at home came to be "not
  reporting" an hour after arriving. On iOS a parked phone keeps a cell-only
  location session instead of none, so it stays alive to say "still here"
  every quarter hour and to notice leaving. Both platforms send the arrival
  fix, stamped still, before the request steps down, and make one up from
  the parking spot if the OS does not answer in time. A phone being watched
  goes live whatever it was doing and answers straight away. Every one-shot
  fix has a deadline, failed uploads retry on their own, a red light no
  longer parks a car, Android's network fixes stop reading as a stopped car,
  the drive survives a background relaunch, and the diagnostics log records
  what each report, upload and service start came to. The expo-location
  patch grows two changes: a restarted Android service promotes itself so a
  redelivery cannot crash the app, and iOS one-shot fixes are served in the
  background.

## [0.7.0] - 2026-08-03

What a week of family feedback said was unreliable, taken one item at a
time: a feed in the wrong order, trips that never appeared, trails drawn as
rulers across town, a page that had to be pulled to refresh. Servers must
update before phones: the app reads `watchedUntil` off the upload reply and
the feed cursor changed shape.

### Added

- Live. A member's profile offers a Live button while their phone says they
  are on the move. It follows them on the map at the zoom you choose, shows
  the speed they are doing and the street they are on, and draws the trail
  from the fixes that arrive while it is open, dashed across any stretch it
  missed. Their phone is asked to report every few seconds for as long as
  the page is open, and nobody else's is.
- A phone learns it is being watched from its own upload reply
  (`watchedUntil` on `POST /locations/batch`), so a car already reporting
  goes live on its next fix whether or not the silent push got through.
  Server: `user_presence.watched_until`, migration 0006.

### Changed

- The activity feed is in the order things happened, and pages by it. A
  backlog uploaded after an outage used to put the morning's arrivals under
  lunchtime's. The cursor carries the moment to the microsecond, which is
  how Postgres stamps it, so rows written in the same millisecond are not
  skipped between pages.
- A trail is drawn only where the phone reported it. A silence between two
  fixes is dashed, and the trip says so, instead of a straight line that
  looked like the route.
- A member's profile shows where they are, not the day's breadcrumbs, and
  no longer asks their phone to go live just for being opened. Live does
  that.
- The trip detector reads a silence between two fixes as travel when the
  phone was clearly somewhere else afterwards, at a pace a person could have
  kept, and the fix before the silence still showed travel. Fixes ten
  minutes apart used to cut a drive into single points, and single points
  are never a trip. A resting fix from where the drive ended still ends it,
  a fix a kilometre out with a kilometre of doubt vouches for nothing, a
  walk across one large place stays inside it, a silence longer than half
  an hour is a lost journey rather than one under way, and a silence with
  another trip's fixes inside it is never bridged. A fix too lonely to be a
  journey is kept for one to grow from, and a trip already filed grows by
  the same rule, so a drive is assembled fix by fix the way the sweep meets
  it, not only when the whole of it is uploaded at once.
- The app refetches the feed, presence and trips every time its socket
  reconnects, which is every time it comes back from the background. A feed
  scrolled deep is cut back to its first page first, so the refetch is one
  request. A feed event that arrives late over the socket lands where it
  happened, or waits for the page it belongs to.
- New places default to a 100 m radius. 150 covered the whole street.

### Fixed

- The feed no longer scrambles after a phone uploads a backlog.
- A drive out to a kilometre away and back, reported sparsely, now counts.
- The Activity page no longer needs a pull to refresh after the app was in
  the background.

## [0.6.0] - 2026-07-31

A fresh look at what the family actually sees against what a family safety app should do,
with the three things that kept happening (a phone called offline on the
sofa, journeys that merged or vanished, a notification that stayed) traced
to their causes. Servers must update before phones: the app calls
`PATCH /me/health` and the offline rule reads what the phone reports.

### Added

- The phone tells the server what stands between it and reporting: the
  location permission level, Location Services, Background App Refresh on
  iOS, battery optimisation on Android. The circle sees "Location permission
  is not set to Always" under the member instead of a phone that went quiet,
  and a quiet phone that has said why is reported as such rather than as
  offline. Server: `PATCH /me/health`, `issues` on presence.
- "At Home since 3:15 PM". Presence carries when the member arrived.
- Every fix says what the phone was doing, from the tracker's own tiers:
  still, walking, driving. The rows show a car for a drive, and the server
  knows a still phone is meant to be quiet.
- Tracker diagnostics under You: what the tracker did and why, kept on the
  phone, shareable. The answer to "the notification stayed" is a page, not a
  guess.
- iOS: a real heartbeat while parked. expo-background-task asked iOS for a
  processing task, which runs when the phone is idle and charging, so a
  parked iPhone had none. Patched to an app refresh task, which is what
  Background App Refresh means: up to thirty seconds, about every quarter
  hour when iOS sees fit. The sync task takes a fix on it when the last one
  is a quarter hour old.

### Changed

- A parked phone is not called offline after an hour of the silence it was
  expected to keep; only after twelve. A phone last seen moving that goes
  quiet is still reported after the hour, and the hour's silent wake before
  it. An Android phone is asked for a fix after a quarter hour of quiet, an
  iPhone after half an hour, since iOS delivers a silent push a few times an
  hour at most.
- Trips end at a stop the phone kept reporting from. A phone that arrived
  somewhere and went on delivering a fix every few minutes held the journey
  open all day, so the morning's drive to work and the evening's drive home
  came out as one trip. A stretch of fixes inside a hundred metres for
  longer than the idle gap now ends the journey where the phone arrived and
  starts the next where it left. Two lone fixes at two different named
  places, silence between them at a pace a person could keep, are one
  journey the tracker did not narrate rather than no journey at all.

### Fixed

- Every remaining way a parked phone was brought back to the moving tier
  without leaving, or kept there after stopping, found in a review of
  the tracker and closed:
  - A fence exit is confirmed against a real fix. Android fires fences on
    the fixes it has, indoors a cell tower's. The service comes up first,
    inside the moment Android allows it, and goes straight back down when a
    sharp fix shows the phone clearly still at home. An exit that lands on a
    phone already moving only re-asserts the service.
  - A vehicle verdict on a parked phone used to enter the moving tier twice
    from a stale snapshot and lose the driving tier it had just entered. A
    doubtful vehicle sample, under 75%, is now confirmed by a fix like a
    walk; a transition, the OS's debounced word, is taken at face value.
  - A still streak counted before a departure no longer parks the phone on
    its first "still" after leaving. One "still" at the lights no longer
    ends a drive; three minutes do, and then park in one step.
  - iOS repeats only the "still" verdict on its schedule. Replaying
    "automotive" un-parked an idling car the tracker had just parked.
  - The on-foot confirmation judged "left" by the still radius, not the
    fence's; a Wi-Fi estimate wandering about a house cleared it. Every
    departure now asks the same question, and the sync task's own stop
    check carries the fix's accuracy like every other.
  - The parking spot survives a suspected departure, so one that turns out
    false settles again on the first fix back inside, rather than five
    minutes later.
  - A drive that ends on the crawl dates the stop from when the crawl began,
    so a parked car is parked five minutes after it stopped, not eight. The
    iOS clock does the same for a walk. A drive can also start from
    displacement, since Android's network fixes carry no speed at all.
  - Switching sharing off goes through the same chain as every other
    registration, so a wake mid fix cannot bring the service back after it.
  - A journey that begins in a fresh process from a wake or a resting fix
    now runs the classifier from the start.
  - A phone with only "While Using" on Android could never park and ran the
    service for good; it now reports from the foreground only until Always
    is granted, as the checklist says.

- On Android the "Updating your location" notification could stay up
  indefinitely at home. A phone that had not moved delivered no fix, since
  the distance filter sat at the OS, so nothing could judge the stop while
  the classifier read a phone in a hand as "tilting" rather than still. The
  request now delivers on the interval whether or not the phone moved, the
  app applies the circle's distance filter to what it uploads, and the stop
  is called from the fixes after five minutes without the classifier's help.
  A fix whose error circle covers the house no longer resets that clock, or
  calls a parked phone gone. And a phone handled in bed, which Android's
  classifier reads as walking at fifty or sixty percent, no longer brings the
  service back on that word alone: on foot, the verdict has to be confirmed
  by a fix clear of where the phone parked, and until then the fence decides.
- With the members sheet pulled up over the map, the back button left the
  app. It brings the sheet down now.
- The expo-location patch was applied twice on the second `pnpm install` a
  build runs, and the Android build failed on the duplicate. Patches are now
  applied once by the root `postinstall`, and left alone when already there.

## [0.5.0] - 2026-07-25

The tracker measured against what it is meant to be: a self-hosted family safety app.
Location is not read all the time. It is read while the phone is moving,
read closely while somebody is watching, and left alone while the phone sits
still. Servers must update before phones: the app calls two new routes.

### Added

- Watching. Opening a member's page asks their phone, by silent push, to
  report at full accuracy every few seconds for ten minutes, and the page
  keeps asking while it is open. A parked phone answers with one fix. This is
  the only time the GPS runs on a phone nobody is driving, and the only time
  a car is drawn moving along a road, which is when somebody is looking.
  Server: `POST /circles/:id/members/:userId/watch`.
- Opening the map asks every member's phone that has been quiet for a couple
  of minutes for one fix, at most once every ten minutes per phone whoever is
  looking. Server: `POST /circles/:id/locations/refresh`.
- Street names. Under a member with no named place, and at both ends of a
  trip, the phone's own geocoder names the street: "Near Queen Street,
  Bristol" instead of "Unnamed spot". Answers are kept on the phone. Off in
  Settings for anyone who would rather their phone did not ask a geocoder
  about the family's whereabouts.

### Changed

- A parked iPhone runs no location session at all. The fence around where
  it stopped relaunches the app when it leaves, and the server's silent push
  is the heartbeat while it sits. That is the only way it shows no location
  indicator in the Dynamic Island and costs nothing, and it is what a commercial app
  does. The blue background indicator is off in every tier; the small arrow
  still shows while location is actually read, as it does for every app.
- A parked Android phone answers a wake or a nudge with the service up for
  the length of one fix and down again after, so the fix is not subject to
  background location limits or Doze and the notification shows for a second
  or two. Posting a notification for a high priority push is also what keeps
  the app's pushes at high priority.
- Opening the app asks for a fix of your own straight away when the last one
  is older than ten seconds, and your dot moves the moment the fix lands
  rather than after the upload and the frame back.
- Arriving somewhere is reported from where the phone actually settled, with
  one Wi-Fi grade fix the moment the stop is called, rather than whenever the
  next fix happened along.
- Trips are journeys. A run that starts inside a place has to leave it, so
  an afternoon in the garden is no longer filed as a trip, while a walk to a
  friend's house still is.

### Fixed

- Android never got its location service back after parking. expo-location
  refuses to register a location task with a foreground service unless the
  app is in the foreground, which is not where a geofence exit or a
  classifier verdict finds it, and the refusal failed the whole registration
  and left the fence torn down. The patched expo-location now makes the
  attempt, catches only Android's own refusal of a background start, and
  tells the app what happened. A journey that starts at a moment Android
  allows (a geofence exit, an activity transition, a high priority push, or
  any time once the app is exempt from battery optimisation) gets the
  service; one that starts at any other moment keeps its fence armed and
  runs on the plain request until the fence exit or the next push brings the
  service up. expo-location is now built from source on Android so the patch
  is in the build at all: Expo ships it as a prebuilt library, and the patch
  in the two previous builds never reached a phone.
- The motion classifier on Android now also asks for activity transitions,
  which are the exempt trigger Android names, so a journey the classifier
  notices can start the service itself.
- An iPhone put down went silent until it moved far enough for iOS to relaunch
  the app. iOS was allowed to pause the updates when it judged the phone
  still, which suspends the app, and a suspended app never called the stop
  or armed the fence. The updates no longer pause while moving. Core Motion
  also only reports an activity when it changes, so the ninety second
  stillness check never got its second reading; the native module now
  repeats the current verdict every thirty seconds, as Android's classifier
  does. A clock in the tracker stands behind both, calling the stop after
  five minutes without a fix, and never while the phone is driving.
- The end of every journey was held back. Deferred delivery looked like the
  OS batching for battery and was not: expo holds the fixes in the process,
  and the ones held were the last of every journey, the fixes that say where
  the phone stopped. They surfaced on the next delivery, which a parked phone
  never made, so arrivals were announced and trips filed a quarter of an hour
  late or not at all. Deferred delivery is gone from every tier.
- A re-registration of the location request mid drive, from a wake or a
  policy change, dropped the GPS tier for the rest of the drive. One place
  now derives the request from the tier the tracker is in.
- The Background App Refresh row on the iOS checklist read "Check" whatever
  the switch said. It now reads the switch itself, through the native
  module, and shows On or Off.

## [0.4.0] - 2026-07-22

The tracker after a proper look at how the platforms behave. Servers must
update before phones: the server carries a migration, and the wake needs it.

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
