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
npx expo run:ios                 # simulator; needs Xcode
npx expo run:android             # emulator or device; needs Android Studio / SDK
```

After that, `pnpm start` (which runs `expo start --dev-client`) is enough for
JavaScript-only changes.

Point the app at a server on first launch. For a simulator talking to a server
on the same machine, that's `http://localhost:4000` on iOS or
`http://10.0.2.2:4000` on the Android emulator. Set `REGISTRATION_MODE=open` on
the server while you play.

### EAS builds

`eas.json` ships with `development`, `preview` and `production` profiles.

```bash
npm i -g eas-cli && eas login
eas init                          # creates the project id used for Expo push
eas build --profile development --platform ios
```

`eas init` also writes `extra.eas.projectId` into `app.json`, which is what
`PUSH_PROVIDER=expo` needs. Without it the app falls back gracefully and tells
the user push is unavailable.

## Permissions

Hearth asks for exactly what background family tracking needs. A checklist
(_Set up Hearth_) shows up on first sign-in and can be revisited from
_You → Tracking status_.

| Permission                     | iOS                                                                           | Android                                                     | Why                                                                              | Requested                                      |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Location, foreground           | `NSLocationWhenInUseUsageDescription`                                         | `ACCESS_FINE_LOCATION` (+ coarse)                           | Show you on the map                                                              | Onboarding, step 1                             |
| Location, **Always**           | `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location` | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` | Updates while the app is closed, plus arrive/leave alerts                        | Onboarding, step 1 (second prompt)             |
| Precise location               | `NSLocationDefaultAccuracyReduced = false`                                    | fine vs coarse detected                                     | Places and trips need GPS accuracy                                               | Detected, checklist links to Settings          |
| Notifications                  | runtime                                                                       | `POST_NOTIFICATIONS`                                        | Arrivals, battery, **SOS**. Local SOS banners need it even with no push provider | Onboarding, step 2                             |
| Battery optimisation exemption | n/a                                                                           | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                      | Doze and vendor power managers are the #1 reason background location dies        | Onboarding (Android), opens the system dialog  |
| Background refresh / tasks     | `UIBackgroundModes: fetch, processing`, `BGTaskSchedulerPermittedIdentifiers` | `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`                       | Flush the offline queue when the OS allows                                       | Declared, checklist explains the iOS toggle    |
| Camera                         | `NSCameraUsageDescription`                                                    | `CAMERA` (via plugin)                                       | Scan an invite QR                                                                | Only when you tap _Scan_                       |
| Local network                  | `NSLocalNetworkUsageDescription`, `NSBonjourServices`                         | n/a                                                         | Self-hosted servers on your LAN                                                  | Prompted by iOS on first LAN connection        |
| Motion and activity            | `NSMotionUsageDescription`                                                    | `ACTIVITY_RECOGNITION` (+ the Play Services variant)        | Let the OS say when you are driving or still, so the GPS can sleep               | Only if this phone turns the motion setting on |
| Photo library                  | `NSPhotoLibraryUsageDescription` (picker plugin)                              | system picker, no permission                                | Choose one profile picture                                                       | Only when you tap your avatar                  |

_Use the phone's motion sensor_ lives under _You → Tracking status_ and belongs
to the handset, not to the server and not to the circle. The server receives the same
fixes either way. All that changes is whether this phone works out that it has
stopped from Core Motion and Play Services, which have already classified the
movement for the system, or from watching its own position, which costs GPS.
Turning it on is what triggers the permission prompt, so a phone that leaves it
off is never asked.

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
4. `expo-background-task` registers `app.hearth.mobile.sync` to flush the queue
   (and take a fix if the last one is >30 min old) when the OS grants time.
5. The server's response carries the current policy. If it changed, updates
   restart with the new intervals, throttled to once a minute.

Turning off _Share my location_ in the app stops the OS updates entirely. No
fixes are captured or queued.

### Moving and stationary

Continuous location on Android requires a foreground service, and a location
foreground service must show a notification the user cannot dismiss. Running one
around the clock is what makes that notification permanent and what actually
drains the battery, because the GPS never sleeps.

So the tracker has two states. **Moving** is continuous updates, and it is the
state that shows the notification. Once the phone has stayed inside a 60 m
circle for five minutes, it switches to **stationary**: updates stop, the
notification disappears, and an exit geofence is armed around where it stopped.
Leaving that circle wakes the app and puts it back into moving. The geofence is
cheap because it rides on the location the system computes anyway.

With _Use the phone's motion sensor_ on, the OS classifier can call a stop
sooner than the position watch can, and can end one the instant you start
moving. That is the whole difference the setting makes.

### Crash detection

`app/services/location/driveSensors.ts` samples the accelerometer fast enough to
catch an impact, the gyroscope and barometer far more slowly, and keeps a
rolling window. The verdict comes from `detectDriveEvent()` in
`packages/shared/src/impact.ts`, which is where the reasoning about what the
sensors can and cannot claim is written down.

Two switches gate it, and it samples only between them. The circle has to have
_Possible-incident alerts_ on, which the app mirrors into device storage because
the detector runs from a background task where the query cache may be cold. The
phone has to have the motion setting on, because sampling that hard is only
worth its battery inside a vehicle and the OS classifier is what says you are in
one. Leave the motion setting off and the sensors are never read.

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
                PlaceEditor, PlaceDetail, Activity, Messages, Circle, CircleSettings,
                Invites, Sharing, NotificationPrefs, You, Devices, PrivacyData,
                ChangePassword, Sos, CheckIn, Trips, TripDetail, Admin,
                CreateCircle, JoinCircle
  navigators/   AppNavigator (auth gate + stack), MainTabNavigator (Map / Places / Activity / You)
  hooks/        queries.ts (TanStack Query), queryKeys.ts, useActiveCircle.ts
  services/     api/ (fetch client + typed endpoints), realtime.ts, notifications.ts,
                location/ (tracker.ts, motion.ts, driveSensors.ts)
  stores/       zustand: auth, settings, tracking, incident, toast. tokenVault (SecureStore)
  theme/        Ignite theming with Hearth's light/dark palettes
  i18n/         en.ts. v1 is English only, and a locale is a file typed as `Translations`
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
