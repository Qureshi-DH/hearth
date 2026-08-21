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

### The keep-alive checklist

Android closes apps that run in the background, and Xiaomi, Huawei, OPPO,
vivo, Samsung, Transsion (Infinix, Tecno, itel) and ASUS each ship a power
manager of their own that closes them sooner and without asking. Nothing in
the platform can read those switches back, so the checklist works from the
make. `vendorFor()` in `services/permissions.ts` maps `Build.MANUFACTURER`
onto those seven groups, and on any of them the checklist shows a row, _Keep
Hearth running in the background_, as a Check. The one thing the OS does read
back is the person setting Hearth's background usage to Restricted
(`ActivityManager.isBackgroundRestricted`), and that turns the same row into
an Off on any Android, Pixel included.

The row opens `KeepAliveScreen`. It says in plain words what the phone does
to an app like this, lists that maker's steps as dontkillmyapp.com gives
them, reads back the Restricted setting and the battery optimiser so the
person can see whether what they changed took, and has one button that calls
`openVendorPowerManagerAsync()` in `hearth-motion`. That walks the component
names transistorsoft's `DeviceSettings` and the AutoStarter library use for
each vendor's autostart or power screen, newest first, and falls back to
Hearth's own app settings page, where every Android keeps the Battery >
Unrestricted toggle. The battery optimisation row raises
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` from native code first, which
Play allows a family safety app to do, and only then falls back to the intent
launcher and the settings list.

Battery Saver on Android and Low Power Mode on iOS get a row of their own for
as long as they are on. Both stop background location, and both flip without
the app being opened. The checklist re-reads everything on focus and on every
return to the foreground, because these settings revert after system updates
on several of those makes.

None of the vendor component names can be checked without the handset in
hand. That is why every candidate is tried in turn and the app's own page is
the floor.

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
   from `app.tsx` as a side effect) so the OS can wake the JS runtime. The
   module writes a `boot` line to the diagnostics log saying whether the
   process is headless, and re-attaches the motion classifier if sharing is
   on, because a process the OS cold-starts for a fix runs this before any
   React code and used to run the whole journey without a classifier.
2. `Location.startLocationUpdatesAsync` with the options of whatever tier the
   tracker is in, see below. `currentOptions()` is the one place the OS
   request is derived from what the tracker believes, so a re-registration
   from a wake or a watch cannot disagree with the tier. On Android the
   moving, driving and live tiers carry the foreground service; a parked
   phone runs without it, and a wake carries it for the length of one fix.
3. Each delivery → `toFix()` (adds battery and the tracker's own `activity`)
   → `thin()` (drops near-duplicates, and on Android applies the circle's
   distance filter to what is uploaded) → MMKV-persisted queue → `flush()`
   (single-flight upload, oldest first). The flush runs on every delivery
   whether or not it kept a fix, so an upload that failed earlier is not
   left waiting for the next kept fix, which on a parked phone is a quarter
   hour away.
4. While the app is in the foreground, a heartbeat asks for one `Balanced` fix
   at the circle's interval whenever the last fix is older than that, tagged
   `source: "heartbeat"`. It reads the moving/stationary mode and never
   changes it, swallows a failed acquisition rather than showing it as an
   error, and trip detection and the possible-incident check both ignore its
   fixes. A fix still being acquired counts as fresh only until its deadline,
   so a native request that never settles cannot hold the heartbeat off for
   the rest of the process, which is what "not reporting while online" was.
5. `expo-background-task` registers `com.binary.rewind.hearth.sync` to flush
   the queue, re-arm the fence and take a fix if the last one is stale, when
   the OS grants time, which is never while the app is open. Its fixes are
   bounded at fifteen seconds, since iOS gives the task about thirty.
6. The server's response carries the current policy. If it changed, updates
   restart with the new intervals, throttled to once a minute.

Turning off _Share my location_ in the app stops the OS updates entirely. No
fixes are captured or queued.

### The tiers

The tracker is in one of three modes, `moving`, `stationary` or `off`. Inside
`moving` it may also be on the driving tier, and in any mode it goes live
while somebody is watching.

**Moving** is the walking tier. On Android it asks for `Balanced` accuracy on
the circle's interval with no OS distance filter, so a still phone keeps
delivering fixes the stop can be judged from, and `thin` applies the circle's
distance filter to what is uploaded. On iOS it asks for `High` accuracy with
the circle's distance filter at the OS: iOS 16.4 and later suspend a low
accuracy session that has a distance filter once significant-change
monitoring is also on, and expo-location always adds that, so a `Balanced`
moving iPhone sat silent until relaunched.

**Driving** is the one state the GPS runs for its own sake. Speed and heading
only come from GPS, and without this tier a driver's dot sat off the road and
their speed read as noise. It starts when the classifier says automotive, or
from speed alone on a phone without the permission, and asks for `High`
accuracy every ten seconds with a distance gate that follows the speed in
fifty metre steps. It ends when the classifier says otherwise, after three
minutes of crawling, or when the phone parks. The drive, the classifier's last
verdict and the start of its still streak are persisted in the tracking
store rather than held in module scope: a process the OS cold-starts for a
background event throws its React host away after every task, so each
delivery used to begin a new drive, upload `unknown`, and lose the guard that
keeps a queue of traffic from parking the phone.

Android reports a speed of 0 for a fix it never measured, where iOS reports
-1, and a Wi-Fi or cell fix never measures one. `toFix` reads a zero on a fix
looser than GPS class (30 m) as unmeasured, so the derived speed runs, the
6 m/s rule can start a drive without the classifier, and a run of network
fixes under a flyover no longer ends one. A zero on a GPS fix is a real stop.

**Parked** (`stationary`) is quiet but never silent. Once the phone has stayed
for five minutes inside a circle of 60 m, or 1.5 times the policy's distance
filter where that is wider, the request steps down and an exit geofence is
armed around where it stopped. Before it steps down, while the moving
registration still holds the process and, on Android, the service, the
tracker takes one arrival fix, stamps it `still` whatever its own verdict,
and waits for the upload. If the OS does not answer within thirty seconds a
fix is made up from the parking spot, dated now, so the word `still` always
leaves. The last fix of every journey is taken while the phone is still called
moving, so without this the server never heard the stop and applied its hour
rule to a phone sitting at home.

On Android the parked request is `Balanced` with one fix wanted a quarter
hour and no foreground service, so nothing stays in the shade. On iOS it is a
cell-only session (`Accuracy.Lowest`) with no distance filter, because a low
accuracy session with one is the shape iOS 16.4 and later suspend once
significant-change monitoring is on, and expo-location always adds that. It
costs almost nothing, it keeps the process alive so the tracker's own timer
can send a `still` fix every quarter hour from the fix the OS already has,
and a departure is seen by the session's own fixes rather than at the
fence's leisure. The 200 m fence stays as a third signal. Whether a parked
iPhone stays resident with this shape has not yet been confirmed on a
device: the tracker log's `heartbeat` lines over a parked hour are the
check.
A parked iPhone used to run no session at all and was suspended within
seconds: the arrival fix went with it, there was no heartbeat, and the fence,
which iOS reports minutes late and not at all with Background App Refresh
off, was the only way back.

**Live** is the tier for as long as somebody has the member's page open, see
Watching below.

### The Android service

Android hands out continuous location only to a foreground service, and
without one the phone is an ordinary background app: a few fixes an hour,
none in Doze, no network until a maintenance window, a process reclaimed
within minutes on most OEM builds, and a service start refused later except
at a handful of moments. The family will not have a notification that stays,
so the service runs while the phone is on the move (moving, driving, live)
and goes with the stop. A parked phone runs the cheap resting request with
no service, and a wake or a watch brings the service up for the length of
one fix and drops it with the fix (`briefService`), which is the second-long
"Updating your location" a messaging app shows when it checks for messages.
The notification is one plain line on a channel the app creates at minimum
importance before the service ever starts (`services/notifications.ts`; the
id has to match the one expo-location derives from the package and the
task), and the patched service creates the channel at the same importance if
it is ever first.

What makes the parked phone reliable without a service is the battery
optimisation exemption: an exempt app may start its service from the
background at any moment and keeps its network in Doze, so the brief service
for a wake, the resting request and the upload all work. The checklist asks
for it directly (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, allowed for
family safety apps) and, on the vendors that kill background apps, walks the
person through the vendor's own settings. A parked phone that is not exempt
gets what Android gives a background app, and the server's twelve-hour rule
for a parked phone is what covers it.

Android 12 still refuses a service start from the background except at a
geofence exit, an activity transition, a high priority push, an app exempt
from battery optimisation, or the app being opened. Stock expo-location
refused the whole registration unless the app was in the foreground;
`patches/expo-location@55.1.14.patch` makes the attempt, catches only
Android's own `ForegroundServiceStartNotAllowedException`, records the
outcome where the app can read it (`getForegroundServiceStatusAsync`), and
registers the location request either way. `reassertService` answers a
refusal for a moving phone at every allowed moment: an activity transition,
a fence exit, a wake or watch push and the app opening at once, and a
delivery or the sync task once per ten minutes, since re-registering hands
back the fix the OS already had and that is another delivery. A parked phone
wants no service and is left alone. A status of `none`
while a tier wants the service means it went down without the app asking,
an OEM battery manager most often; the tracker brings it back, remembers the
moment for a day, and `serviceDiedUnexpectedly()` is what the health report
sends as `serviceStopped`.

The patch also has the service promote itself to the foreground in
`onStartCommand` from options it persisted, so when the OS kills the process
and restarts the service with a redelivered intent, nobody has to bind to it
first; a service started without a `startForeground` is killed a few seconds
later with an exception that takes the process with it.

Expo ships its modules to Android as prebuilt AARs, and a patch to Kotlin
source does nothing to one of those, so `apps/mobile/package.json` lists
expo-location under `expo.autolinking.android.buildFromSource`. Check the
build log: the module must appear without the package icon that marks a
prebuilt. The patch is applied by `scripts/apply-patches.mjs` from the root
`postinstall`, not by pnpm's `patchedDependencies`: with
`node-linker=hoisted`, which Metro needs, pnpm applies a patch again on every
install, and `expo prebuild` runs one, which left the Kotlin declared twice.
The script applies each patch once and leaves one already in place alone.

### One-shot fixes

Every one-shot fix (`reportNow`, the background clock, the sync task, the
fence check, the classifier's confirmation) has a thirty second deadline
inside `reportNow` itself. Android's `getCurrentPositionAsync` has no timeout
of its own, and a request a background app makes can hang for the life of the
process. When the fresh fix is late, the fix the OS already has stands in
where that is still useful (a wake, a nudge, the app opening, the clock) and
not where it would lie (a fence check, where a stale fix inside the circle
would re-park a phone that has just left; the park fix, which is made up from
the anchor instead).

On iOS, expo-location's one-shot manager had `allowsBackgroundLocationUpdates`
off, which Apple documents as a manager Core Location need not keep the app
running to serve. The patch sets it when the app is authorised Always and
declares the location background mode, so wakes, park fixes and watch answers
are served in the background.

### Calling the stop

The classifier is the normal path: it calls a stop after ninety seconds of
the phone reading still, three minutes inside a detected drive, and ends one
the instant you start moving. A phone on a journey is not parked by the
classifier alone: while it has travelled more than 400 m in the last ten
minutes or done 3 m/s in the last three, a still verdict at the lights needs
the position to agree, which means no fix clear of the anchor for the same
five minutes the location path parks on. The anchor is kept through a drive
for exactly this, though a drive is never parked from the location path.

The position watch is the fallback, for a phone that refused the permission
or cannot classify motion. On iOS a phone that has not crossed the distance
filter delivers no fix to judge, so the tracker's background clock, a React
Native timer that `RCTTiming` keeps as an `NSTimer` while the session keeps
the app alive, asks for one fix once no update has come for five minutes and
judges the stop from it. For any of this the session must never pause:
`pausesUpdatesAutomatically` is off in every tier, since a paused manager
suspends the app with it and a suspended app calls no stop and arms no fence.

A parked phone does not leave on the classifier's word alone unless the word
is a sure "automotive" (a transition, or a sample at 75% or better). Handled
in bed, a phone reads as walking at fifty or sixty percent, and taking that
alone brought the full tier back to a phone going nowhere. On foot the
verdict is confirmed by one Balanced fix, at most every two minutes, and only
a fix clear of the anchor by more than its own error ends the stop; otherwise
the fence is the judge, as it would have been a minute later anyway. A fence
exit on Android brings the full tier up first, inside the allowed moment, and
then checks the exit against one bounded fix: a sharp fix clearly inside the
circle is a false exit and the phone parks again at once.

Deferred delivery is off in every tier. It looked like the OS batching for
battery and is not: both of expo's consumers hold the fixes in the process,
and the ones held were the last of every journey, the fixes that say where
the phone stopped.

### Uploads

A failed upload (network, 5xx, 429) keeps the queue and retries on its own
after thirty seconds, then a minute, then two, while the process lives; after
that it waits for the next delivery, which flushes whether or not it kept a
fix. An upload that gets through starts the ladder over. A 4xx that is not
an auth problem drops that batch so one bad fix cannot wedge the pipeline.

### What the phone says about itself

`services/health.ts` sends `PATCH /me/health` with the checklist's reading
of the phone: the location permission level, Location Services, Background
App Refresh on iOS, battery optimisation and the Restricted background
setting on Android, Low Power Mode or Battery Saver on either, the
manufacturer in lowercase, and on Android whether the location service died
without the tracker asking. It goes when the app comes to the front, after
the checklist changes anything, and the moment Low Power Mode or Battery
Saver flips, which the native module reports as an `onPowerStateChange`
event. Otherwise it goes again only when something changes or a day has
passed. The server keeps it on
`user_presence.health`, projects it as `issues` on presence, and the rows put
the first issue under the member's name once the phone is stale. The offline
sweep reads it too: a quiet phone that has said why it cannot report is
reported as that, not as offline.

Every fix carries `activity` from the tracker's own tiers, `still` while
parked and on the arrival fix, `driving` on the GPS tier, the classifier's
word while walking, so the server knows a still phone is meant to be quiet
and calls it offline only after twelve hours rather than one.

### Diagnostics

`services/location/log.ts` keeps the last thousand things the tracker did,
on the phone: `boot` with whether the process was headless, tier changes and
why, `fixes` delivered and kept, `report` / `report done` / `report failed`
for every one-shot fix with its source, accuracy and elapsed time, `flush` /
`flush failed` with sizes and status, `service` with the Android service's
status after every registration, `reassert` before and after, `sync` for
each run of the sync task, `watched` and `watch adopted`, `wake`, fence
exits and whether they were false, the classifier's verdicts, and
`heartbeat skipped` with the reason. A shared log opens with a header from
`headerForTrackerLog()`: mode, anchor, queue length, last error, permission
and service status. When a family member says "the notification stayed" or
"it went quiet at home", this is the page to ask for; a stop that was called
and a park fix that never left used to look identical.

### The control channel

The tracker keeps its own websocket to the server for as long as sharing is
on, in every tier on both platforms. A parked iPhone's session keeps the app
alive. A parked Android phone runs no service, so the OS may reclaim its
process, but a phone exempt from battery optimisation keeps its network and
stays up for hours, and while it does an ask reaches it in a second. It sends `{ type: "control" }` on open, pings every two
minutes, reconnects with backoff, and takes a new token from the API client
when one is rotated (`services/location/control.ts`). An ask from the family
(a page opened, Live, the map opened, the sweep's wake) comes down it and is
answered within a second: `wake` takes one fix, `watch` goes live. The UI's
socket in `services/realtime.ts` is a different thing: it lives with the
screen and closes when the app goes to the background, which is exactly when
this one matters. When the OS does take a parked Android phone's process
the socket drops, the server sees the stamp age out, and the ask goes by
silent push instead; either way the brief service answers with one fix.

Opening a member's page calls `POST /circles/:id/members/:userId/refresh`
for one fix now, the way opening the map calls
`POST /circles/:id/locations/refresh` for everyone quiet. The tracker also
keeps the circles' places (`stores/places.ts`, filled by every places query
and refreshed by the tracker itself once a day) and uploads the fix that
crosses into or out of one at once, whatever the distance gate says, so an
arrival is announced on the crossing fix rather than on the park fix minutes
later.

### Watching

The Live page is the one time the family wants to see a car move along a
road. The page calls `POST /circles/:id/members/:userId/watch` on focus and
every minute after. The server records the window on the member and sends
the ask down the phone's control channel when it has one open, or a silent
`watch` push otherwise, again after ninety seconds if the phone has
not uploaded since, three times per window at most, and the reply says
which (`pushed`), when the phone was last heard and what it said
stands in its way; every upload reply also carries `watchedUntil`, so a phone that is already reporting picks the watch up on
its next batch whether or not the push arrived. Either way the phone puts
`watchedUntil` in its store and `currentOptions()` returns the live tier
whatever the phone was doing: `High` accuracy every five seconds on the move,
`Balanced` at the same interval when parked, since a parked phone is not
going anywhere and the point is that the page hears from it every few
seconds rather than once. The phone also answers with one fix straight away,
because iOS ignores the interval and delivers on distance, so a phone at rest
would otherwise say nothing for the whole window. The window ends by a timer
and by the first fix past it, whichever comes first, and the request steps
back to the tier it was in.

The Live page draws the fixes that arrive while it is open and nothing else.
A trip draws its own trail, and only where the phone reported it: a silence
between two fixes is dashed (`splitTrail` in `utils/trail.ts`), because the
road between them is a guess. The profile map draws no trail.

Opening the map calls `POST /circles/:id/locations/refresh`, which sends one
`wake` to each member quiet for a couple of minutes, at most once every ten
minutes per phone. Both routes refuse a provider that cannot carry a silent
push and a member sharing approximately, whose live fixes the projection
would throw away anyway. The server's own wake after half an hour of quiet is
a second line behind the phone's heartbeats, not the heartbeat itself.

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
