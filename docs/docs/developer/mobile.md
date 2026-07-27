---
sidebar_position: 3
title: Mobile app
---

`apps/mobile` is an Expo SDK 55 / React Native 0.83 app bootstrapped with
[Ignite](https://github.com/infinitered/ignite) 11 and then reshaped for Hearth.

## Running it

The app depends on native modules (MapLibre, background location, secure
store), so **Expo Go will not work**. You need a development build.

```bash
pnpm install                     # from the repo root
cd apps/mobile
npx expo prebuild                # generates ios/ and android/ (git-ignored)
npx expo run:ios                 # simulator, needs Xcode
npx expo run:android             # emulator or device, needs Android Studio / SDK
```

After that, `pnpm start` (which runs `expo start --dev-client`) is enough for
JavaScript-only changes.

Point the app at a server on first launch. For a simulator talking to a server
on the same machine, that's `http://localhost:4000` on iOS or
`http://10.0.2.2:4000` on the Android emulator. Set `REGISTRATION_MODE=open` on
the server while you play.

### Builds

Two environments, `development` and `production`, plus a variant of each for
the shape of artifact you need. Every command builds locally rather than on
Expo's servers.

```bash
pnpm build:android:dev        # debug APK for an emulator or a plugged-in phone
pnpm build:android:prod       # AAB, what Play Store wants
pnpm build:android:prod:apk   # APK, for sideloading a release build
pnpm build:ios:sim            # debug build for the simulator
pnpm build:ios:dev            # debug build for a real device
pnpm build:ios:prod           # IPA
```

Development builds allow plain HTTP so a family can try the app against a LAN
server. Production builds do not, on either platform, which is the behaviour
you want and the thing to remember when a release build cannot reach a server
that a development build could.

Android release builds are signed with the keystore EAS holds for the project.
EAS injects it into `build.gradle` after the config plugins run, so nothing in
the repository or in your shell can swap the key. That key must never change.
Android refuses an update signed with a different one, so a build signed by
anything else strands everyone who already installed the app. Keep a copy
outside the repository, for example under `~/.hearth/keystores/`. Run
`npx eas-cli@latest credentials -p android`, pick the production profile, then
Keystore and Download to get it.

`plugins/withAndroidReleaseSigning.ts` only matters for a build made outside
EAS, with `expo prebuild` and Gradle directly. There it swaps the template's
debug key for whatever the `HEARTH_UPLOAD_*` Gradle properties point at, and
falls back to debug signing when they are missing, which is fine for trying
the app and must not be given to anyone.

Push notifications are configured for production only. `eas init` writes
`extra.eas.projectId` into `app.json`, which is what `PUSH_PROVIDER=expo` needs,
and Android additionally needs `google-services.json` present. Without either,
the app falls back gracefully and tells the user push is unavailable.

## Permissions

Hearth asks for exactly what background family tracking needs. A checklist
(_Set up Hearth_) shows up on first sign-in and can be revisited from
_You → Tracking status_.

| Permission                     | iOS                                                                           | Android                                                     | Why                                                                              | Requested                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Location, foreground           | `NSLocationWhenInUseUsageDescription`                                         | `ACCESS_FINE_LOCATION` (+ coarse)                           | Show you on the map                                                              | Onboarding, step 1                                                              |
| Location, **Always**           | `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location` | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` | Updates while the app is closed, plus arrive/leave alerts                        | Onboarding, step 1 (second prompt)                                              |
| Precise location               | `NSLocationDefaultAccuracyReduced = false`                                    | fine vs coarse detected                                     | Places and trips need GPS accuracy                                               | Detected, checklist links to Settings                                           |
| Notifications                  | runtime                                                                       | `POST_NOTIFICATIONS`                                        | Arrivals, battery, **SOS**. Local SOS banners need it even with no push provider | Onboarding, step 2                                                              |
| Battery optimisation exemption | n/a                                                                           | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                      | Doze and vendor power managers are the #1 reason background location dies        | Onboarding (Android), opens the system dialog                                   |
| Background refresh / tasks     | `UIBackgroundModes: fetch, processing`, `BGTaskSchedulerPermittedIdentifiers` | `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`                       | Flush the offline queue when the OS allows                                       | Declared, checklist explains the iOS toggle                                     |
| Camera                         | `NSCameraUsageDescription`                                                    | `CAMERA` (via plugin)                                       | Scan an invite QR                                                                | Only when you tap _Scan_                                                        |
| Local network                  | `NSLocalNetworkUsageDescription`, `NSBonjourServices`                         | n/a                                                         | Self-hosted servers on your LAN                                                  | Prompted by iOS on first LAN connection                                         |
| Motion and activity            | `NSMotionUsageDescription`                                                    | `ACTIVITY_RECOGNITION` (+ the Play Services variant)        | Let the OS say when you are driving or still, so the GPS can sleep               | Onboarding, right after location. Hidden on a phone that cannot classify motion |
| Photo library                  | `NSPhotoLibraryUsageDescription` (picker plugin)                              | system picker, no permission                                | Choose one profile picture                                                       | Only when you tap your avatar                                                   |

The motion classifier runs whenever tracking does. Core Motion and Play
Services have already classified the movement for the system, so asking them
costs far less than watching the phone's own position, which is what the GPS
fallback does. The checklist asks once, from its own Allow button, and nothing
the tracker runs in the background ever raises the dialog: Android answers a
request made from a process with no Activity as denied without showing
anything, and the module then reports denied for good. A phone that refuses,
or one that cannot classify motion at all, works stops out from position
instead. The server receives the same fixes either way.

The accelerometer, gyroscope and barometer need no permission on either
platform at the rates Hearth samples them, which is what makes crash detection
possible without asking for anything. It appears on the setup checklist for
exactly that reason: unannounced, it would be a sensor nobody agreed to.

Commercial trackers ask for a pile of things Hearth deliberately doesn't. No
contacts, because invites are codes and QR. No microphone. No Bluetooth, because
there is no hardware tag to talk to. No advertising identifier, and no tracking
of any kind. The photo library is reached through the system picker, which hands
back the one file you chose rather than access to the album. Motion is there to
let the GPS sleep, never to collect a fitness feed.

### Plain-HTTP servers on a LAN

The two platforms differ here, and you tend to find out at release time.

| Build                                 | iOS                                                              | Android                                |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Development                           | any HTTP host (`NSAllowsArbitraryLoads`)                         | any HTTP host (`usesCleartextTraffic`) |
| Production                            | **private ranges and `.local` only** (`NSAllowsLocalNetworking`) | **no HTTP at all**                     |
| Production with `HEARTH_ALLOW_HTTP=1` | any HTTP host                                                    | any HTTP host                          |

Both are decided at prebuild time, from `EAS_BUILD_PROFILE` and `NODE_ENV`.
`HEARTH_ALLOW_HTTP=0` forces the strict behaviour into a development build,
which is how you check a TLS-only setup before you ship it.

iOS ignores `NSAllowsArbitraryLoads` whenever `NSAllowsLocalNetworking` is also
present, so Hearth emits exactly one of the two.

A production Android build therefore can't reach `http://192.168.1.10:4000`
unless it was built with `HEARTH_ALLOW_HTTP=1`, while a production iOS build
can. Put TLS in front of the server (see [self-hosting](../install/self-hosting.md))
and neither caveat applies.

### Invite links

The API serves `https://your-server/join/ABCD1234` itself. It shows the code,
hands off to `hearth://join/ABCD1234` when the app is installed, and explains
itself when it isn't. That handoff works in every build, because the
`hearth://` scheme is registered unconditionally.

Android App Links, where tapping the link opens the app directly rather than a
browser page that then offers to, need a concrete domain compiled in and
verified against a file on that host. Every family self-hosts somewhere
different, so no build ships one. Opt in at prebuild time:

```bash
HEARTH_APP_LINK_HOST=hearth.yourfamily.com npx expo prebuild --platform android
```

## How background location works

All of this lives in `app/services/location/tracker.ts`.

1. `TaskManager.defineTask(BACKGROUND_LOCATION_TASK)` at module scope (imported
   from `app.tsx` as a side effect) so the OS can wake the JS runtime.
2. `Location.startLocationUpdatesAsync` with `Balanced` accuracy, the circle's
   interval/distance policy, deferred updates so the OS batches while still,
   and an Android foreground service notification.
3. Each delivery → `toFix()` (adds battery) → `thin()` (drops near-duplicates)
   → MMKV-persisted queue → `flush()` (single-flight upload, oldest first).
4. While the app is in the foreground, a heartbeat asks for one `Balanced` fix
   at the circle's interval whenever the last fix is older than that, tagged
   `source: "heartbeat"`. The OS delivers nothing inside the distance filter
   and a parked phone has stopped asking, so without it your own row went
   stale while you watched the map. It reads the moving/stationary mode and
   never changes it, swallows a failed acquisition rather than showing it as
   an error, and trip detection and the possible-incident check both ignore
   its fixes.
5. `expo-background-task` registers `com.binary.rewind.hearth.sync` to flush the queue
   (and take a fix if the last one is >30 min old) when the OS grants time,
   which is never while the app is open.
6. The server's response carries the current policy. If it changed, updates
   restart with the new intervals, throttled to once a minute.

Turning off _Share my location_ in the app stops the OS updates entirely. No
fixes are captured or queued.

### Driving

The GPS runs in exactly one state, a drive. Speed and heading only come from
GPS, and the walking tier never turns it on, so without this tier a driver's
dot sat off the road and their speed read as noise. The tier starts when the
classifier says automotive, or from speed alone on a phone without the
permission, and asks for High accuracy every ten seconds with a distance
filter that follows the speed in fifty metre steps, so fixes land about one
interval apart whether the car is in town or on a motorway. It ends when the
classifier says otherwise, after three minutes of crawling, or when the
phone parks. Nothing is deferred while driving.

### Moving and stationary

Continuous location on Android requires a foreground service, and a location
foreground service must show a notification the user cannot dismiss. Running one
around the clock is what makes that notification permanent and what actually
drains the battery, because the GPS never sleeps.

So the tracker has two states. **Moving** is continuous updates, and it is the
only state that runs the service. Its notification is one plain line, "Hearth,
updating your location", with no colour and no other copy. The app creates the
notification's channel at minimum importance before the service ever starts,
which keeps it out of the status bar. It sits collapsed in the silent part of
the shade instead. expo-location names the channel after the package and the
task and only creates one when nothing by that name exists, so the id in
`services/notifications.ts` has to match. Once the phone has stayed for five
minutes inside a circle of 60 m, or 1.5 times the policy's distance filter
where that is wider, it switches to **stationary**: the same task is
re-registered with resting options, Balanced accuracy, no GPS, one fix wanted
every quarter hour, and an exit geofence is armed around where it stopped. The
resting options carry no foreground service, and expo-location stops a running
service when the task is registered without one, so the notification goes with
it. Leaving the circle puts the phone back into moving, and so does a resting
fix outside the circle, which covers a fence Android forgot after killing the
process. The geofence is cheap because it rides on the location the system
computes anyway.

Starting the service again from the background is where stock expo-location
gives up. It refuses to register a location task with a foreground service
unless the app is in the foreground, which is the rule Android 12 has for
ordinary apps and not the one for a geofence exit, an activity transition, a
high priority push or an app exempt from battery optimisation, all of which
Android allows. The refusal also failed the whole registration, so the fence
had been torn down and nothing was moving. `patches/expo-location@55.1.14.patch`
removes that refusal, makes the attempt, catches only Android's own
`ForegroundServiceStartNotAllowedException`, and records the outcome where
the app can read it (`getForegroundServiceStatusAsync`). Expo ships its
modules to Android as prebuilt AARs, and a patch to Kotlin source does
nothing to one of those, so `apps/mobile/package.json` lists expo-location
under `expo.autolinking.android.buildFromSource`. Check the build log: the
module must appear without the package icon that marks a prebuilt. The patch
is applied by `scripts/apply-patches.mjs` from the root `postinstall`, not by
pnpm's `patchedDependencies`: with `node-linker=hoisted`, which Metro needs,
pnpm applies a patch again on every install, and `expo prebuild` runs one,
which left the Kotlin declared twice. The script applies each patch once and
leaves one already in place alone. The tracker
registers the request first and only then decides about the fence: with the
service up the fence has done its job, and refused, the fence stays, because
its exit is a moment Android does allow the start and the plain request
carries the phone on throttled fixes until then. The next high priority push,
the server's wake or a nudge, re-asserts the request in whatever tier the
tracker is in, and so does the app opening. `hearth-motion` asks for activity
transitions as well as the sampled verdicts, since a transition is the
exempt trigger Android names, and tags each verdict with its source. Both
reach the app through a receiver registered by the running process, so
neither can relaunch a process Android has reclaimed; the fence does that.
A fence exit brings the service up first, inside the allowed moment, and
then checks the exit against one bounded fix: a sharp fix clearly inside
the circle is a false exit and the phone parks again at once.

A server side second line stands behind the heartbeat. The scheduler sends a
silent push to a phone that has been quiet for half an hour, once per
silence, and the app answers it with a fix from a background task that runs
even when the app is not open. The offline sweep waits for that answer, so
a phone is only reported offline once it has ignored both its own heartbeat
and the wake. Without the expo provider no wake can be sent and the hour of
silence alone decides, as it always did. The admin screen shows each
account's longest silence over the last day, which is how the whole
arrangement is judged on real phones.

The service used to stop outright while parked and take the request with
it. That left the phone's next word to the OS task schedulers, and Doze lets
a phone sit for hours, at which point the server, which calls a phone
offline after an hour of silence, told the family the phone had gone quiet.
On Android the request now stays: a background app gets a handful of fixes
an hour, which is enough for a quarter hour heartbeat most of the time,
`restingFixes` thins anything more frequent back to one per heartbeat, and
the server's wake covers the rest.

iOS is different while parked. A parked iPhone runs no location session at
all: the stop stops the updates, the fence stays, and the phone is suspended.
That is the only way it shows no indicator and costs nothing, and it is how
commercial apps behave. The fence relaunches the app when the phone leaves, and
while it sits the server's silent push is its heartbeat: the wake after half
an hour of quiet, the map being opened, and somebody watching. iOS delivers
a few such pushes an hour, which is why the server spends them carefully
(see the intervals in `locations.routes.ts`). `showsBackgroundLocationIndicator`
is off in every tier; the small arrow still shows while location is actually
being read, as it does for every app, and the blue Dynamic Island pill does
not.

Two things make the stop callable on iOS at all. Core Motion reports an
activity when it changes and then says nothing while it holds, so "still for
ninety seconds" never got the second reading the tracker waits for; the
native module repeats the current verdict every thirty seconds, which is the
shape Android's classifier already had. And a phone that has not crossed the
distance filter delivers no fix to judge, so the tracker's background clock,
a React Native timer that `RCTTiming` keeps as an `NSTimer` while the moving
session keeps the app alive, asks for one Balanced fix once no update has
come for five minutes and judges the stop from it, unless the tracker
believes the phone is driving, in which case a queue of traffic is not a
stop. For any of this the moving session must never pause:
`pausesUpdatesAutomatically` is off, since a paused manager suspends the app
with it and a suspended app calls no stop and arms no fence. That was the
phone that went silent the moment it was put down.

### Watching

Opening a member's page is the one time the family wants to see a car move
along a road, and the one time the GPS runs on a phone nobody is driving.
The page calls `POST /circles/:id/members/:userId/watch` on focus and every
minute after; the server sends the phone a silent `watch` push once per
window and answers the rest from memory. The phone puts `watchedUntil` in
its store and `currentOptions()` returns the live tier, full accuracy every
five seconds, until it passes; the first fix past the window steps the
request back down, since no timer runs in the Android background between
deliveries. A parked phone answers with one fix instead, because it is not
going anywhere, and goes live only if the fence then sends it moving inside
the window.

Opening the map calls `POST /circles/:id/locations/refresh`, which sends one
`wake` to each member quiet for a couple of minutes, at most once every ten
minutes per phone. Both routes refuse a provider that cannot carry a silent
push and a member sharing approximately, whose live fixes the projection
would throw away anyway.

Deferred delivery is off in every tier too. It looked like the OS batching
for battery and is not: both of expo's consumers hold the fixes in the
process, which is alive either way, and the ones held were the last of every
journey, the fixes that say where the phone stopped. They only surfaced on
the next delivery, which a parked phone never makes, so the stop was judged
against a stale anchor.

On Android the moving request carries no distance filter: the OS delivers
on the interval whether or not the phone moved, and `thin` in the tracker
applies the circle's distance filter to what is uploaded. With the filter at
the OS a still phone delivered nothing, and nothing could judge the stop
while the classifier read a phone in a hand as tilting, so the service and
its notification stayed up. Now the stop is judged from every fix, and one
whose error circle still covers the anchor neither resets the clock nor, on
a parked phone, counts as leaving.

A parked phone does not leave on the classifier's word alone unless the word
is a sure "automotive" (a transition, or a sample at 75% or better). Handled in bed, a phone reads as walking at fifty or sixty
percent, and taking that alone brought the service back to a phone going
nowhere. On foot the verdict is confirmed by one Balanced fix, at most every
two minutes, and only a fix clear of the anchor by more than its own error
ends the stop; otherwise the fence is the judge, as it would have been a
minute later anyway.

The OS classifier is the normal path for both ends of a stop: it calls one
after ninety seconds of the phone reading still, and ends one the instant you
start moving, before a geofence or the periodic wake would have. The position
watch above is the fallback, for a phone that refused the permission or cannot
classify motion.

### Crash detection

`apps/mobile/modules/hearth-motion`, a local Expo native module written in
Kotlin and Swift, does the sampling. The accelerometer runs fast enough to catch
an impact (20 ms), and the gyroscope and barometer run far slower (100 ms and
200 ms) because rotation and pressure move on human timescales. Samples cross
the bridge batched roughly four times a second rather than one call per sample.

On Android the module registers its `SensorManager` listener from the
application context. expo-sensors drops its listener the moment the Activity
pauses, and a screen going off or a map app on top is the state a phone is in
for most of a drive, so the detector used to run only while somebody was
watching it. Registering from the application context keeps samples arriving for
as long as the process lives, which the location foreground service already
guarantees while the phone is moving.

`app/services/location/driveSensors.ts` receives those batches, assembles the
rolling window, and calls `detectDriveEvent()` in
`packages/shared/src/impact.ts`, which is where the reasoning about what the
sensors can and cannot claim is written down. expo-sensors is the fallback only,
for an install built without the module. It is also the path the
`ACCEL_INTERVAL_MS`, `GYRO_INTERVAL_MS` and `BARO_INTERVAL_MS` constants in
`driveSensors.ts` belong to, since the native sampler sets its own rates.

One switch gates it, and it samples only between the two ends of a drive. The
circle has to have _Possible-incident alerts_ on, which the app mirrors into
device storage because the detector runs from a background task where the query
cache may be cold. The OS classifier, which runs whenever tracking does, is what
says you are in a vehicle, because sampling this hard is only worth its battery
while you are driving.

A verdict does not alert anybody. It goes into a persisted store and the app
asks the person, with a countdown. Answering dismisses it. Silence escalates to
a real SOS, because someone hurt badly enough not to answer is the case the
feature exists for. The store survives a process kill on purpose: the phone that
just took the impact is the one most likely to be restarted by it.

The server runs its own, unrelated check on the breadcrumbs it receives, and it
needs no sensors and no settings on the phone. Fixes half a minute apart cannot
tell a collision from parking hard, so all it claims is that somebody stopped
suddenly after driving fast, and it posts that to the circle as a prompt.

## Realtime

`app/services/realtime.ts` holds a single websocket while the app is in the
foreground and writes every message straight into the TanStack Query cache.
It disconnects in the background, where push takes over, and reconnects with
back-off.

## Structure

```text
app/
  components/   Avatar, GlassPanel, MemberMarker, SosHoldButton, IncidentPrompt, ListRow,
                HearthMap and the rest
  screens/      Server, Login, Register, Permissions, Map, MemberDetail, Places,
                PlaceEditor, PlaceDetail, Activity, Circle, CircleSettings,
                Invites, Sharing, NotificationPrefs, You, Devices, PrivacyData,
                ChangePassword, Sos, CheckIn, Trips, TripDetail, Admin,
                CreateCircle, JoinCircle
  navigators/   AppNavigator (auth gate + stack), MainTabNavigator (Map / Places / Activity / You)
  hooks/        queries.ts (TanStack Query), queryKeys.ts, useActiveCircle.ts
  services/     api/ (fetch client + typed endpoints), realtime.ts, notifications.ts,
                location/ (tracker.ts, motion.ts, driveSensors.ts)
  stores/       zustand: auth, settings, tracking, incident, nudge, push, toast.
                mmkv (persisted-store adapter), tokenVault (SecureStore)
  theme/        Ignite theming with Hearth's light/dark palettes
  i18n/         en.ts. v1 is English only, and a locale is a file typed as `Translations`
modules/        hearth-motion: the Expo native module behind the motion classifier
                and the batched sensor samples
```

## Design notes

- Dark-first, warm near-black surfaces so the map and avatars carry the colour.
- One ember gradient reserved for the primary action on each screen.
- Status is communicated by the avatar ring: blue = you, red pulse = SOS,
  dashed amber = approximate, grey = stale.
- Glass panels float over the map, with blur intensity reduced on Android.
- SOS requires a three-second hold with a visible progress ring, never a tap.

## Testing

```bash
pnpm --filter hearth-mobile compile      # tsc
pnpm --filter hearth-mobile lint
pnpm --filter hearth-mobile test         # jest-expo unit tests
```

Maestro flows (`.maestro/`) aren't included in v1. See the roadmap.
