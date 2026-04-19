# Mobile app

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

| Permission                     | iOS                                                                           | Android                                                     | Why                                                                              | Requested                                     |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Location, foreground           | `NSLocationWhenInUseUsageDescription`                                         | `ACCESS_FINE_LOCATION` (+ coarse)                           | Show you on the map                                                              | Onboarding, step 1                            |
| Location, **Always**           | `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location` | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` | Updates while the app is closed, plus arrive/leave alerts                        | Onboarding, step 1 (second prompt)            |
| Precise location               | `NSLocationDefaultAccuracyReduced = false`                                    | fine vs coarse detected                                     | Places and trips need GPS accuracy                                               | Detected, checklist links to Settings         |
| Notifications                  | runtime                                                                       | `POST_NOTIFICATIONS`                                        | Arrivals, battery, **SOS**. Local SOS banners need it even with no push provider | Onboarding, step 2                            |
| Battery optimisation exemption | n/a                                                                           | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                      | Doze and vendor power managers are the #1 reason background location dies        | Onboarding (Android), opens the system dialog |
| Background refresh / tasks     | `UIBackgroundModes: fetch, processing`, `BGTaskSchedulerPermittedIdentifiers` | `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`                       | Flush the offline queue when the OS allows                                       | Declared, checklist explains the iOS toggle   |
| Camera                         | `NSCameraUsageDescription`                                                    | `CAMERA` (via plugin)                                       | Scan an invite QR                                                                | Only when you tap _Scan_                      |
| Local network                  | `NSLocalNetworkUsageDescription`, `NSBonjourServices`                         | n/a                                                         | Self-hosted servers on your LAN                                                  | Prompted by iOS on first LAN connection       |

Other family apps ask for a pile of things Hearth deliberately doesn't. No contacts,
because invites are codes and QR. No photos, because there's no avatar upload
in v1. No microphone, no Bluetooth (there's no hardware tag to talk to), no
motion and fitness (the server derives activity from speed), and no advertising
identifier or tracking.

### Plain-HTTP servers on a LAN

The two platforms differ here, and you tend to find out at release time.

| Build                                 | iOS                                                              | Android                                |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Development                           | any HTTP host (`NSAllowsArbitraryLoads`)                         | any HTTP host (`usesCleartextTraffic`) |
| Production                            | **private ranges and `.local` only** (`NSAllowsLocalNetworking`) | **no HTTP at all**                     |
| Production with `HEARTH_ALLOW_HTTP=1` | any HTTP host                                                    | any HTTP host                          |

iOS ignores `NSAllowsArbitraryLoads` whenever `NSAllowsLocalNetworking` is also
present, so Hearth emits exactly one of the two.

A production Android build therefore can't reach `http://192.168.1.10:4000`
unless it was built with `HEARTH_ALLOW_HTTP=1`, while a production iOS build
can. Put TLS in front of the server (see [SELF-HOSTING.md](SELF-HOSTING.md))
and neither caveat applies.

### Invite links

The API serves `https://your-server/join/ABCD1234` itself. It shows the code,
hands off to `hearth://join/ABCD1234` when the app is installed, and explains
itself when it isn't. The Android intent filter in `app.json` is set to
`*.hearth.example`. Change it to your own domain before shipping, or the link
will open a browser rather than the app.

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

## Realtime

`app/services/realtime.ts` holds a single websocket while the app is in the
foreground and writes every message straight into the TanStack Query cache.
It disconnects in the background, where push takes over, and reconnects with
back-off.

## Structure

```text
app/
  components/   Avatar, GlassPanel, MemberMarker, SosHoldButton, ListRow, HearthMap…
  screens/      Server, Login, Register, Permissions, Map, MemberDetail, Places,
                PlaceEditor, PlaceDetail, Activity, Circle, CircleSettings, Invites,
                Sharing, NotificationPrefs, You, Devices, PrivacyData,
                ChangePassword, Sos, CheckIn, Trips, TripDetail, Admin,
                CreateCircle, JoinCircle
  navigators/   AppNavigator (auth gate + stack), MainTabNavigator (Map / Places / Activity / You)
  hooks/        queries.ts (TanStack Query), queryKeys.ts, useActiveCircle.ts
  services/     api/ (fetch client + typed endpoints), realtime.ts, notifications.ts, location/tracker.ts
  stores/       zustand: auth, settings, tracking, toast; tokenVault (SecureStore)
  theme/        Ignite theming with Hearth's light/dark palettes
  i18n/         en.ts (v1 is English-only; add a locale by typing a file as `Translations`)
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
pnpm --filter hearth-mobile lint:check
pnpm --filter hearth-mobile test         # jest-expo unit tests
```

Maestro flows (`.maestro/`) aren't included in v1. See the roadmap.
