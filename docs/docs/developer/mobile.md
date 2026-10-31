---
sidebar_position: 3
title: Mobile app
---

`apps/mobile` is an Expo SDK 58 / React Native 0.88 app bootstrapped with
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

An EAS development build allows plain HTTP to any host so a family can try the
app against a LAN server. A release build doesn't. Android refuses plain HTTP
outright and iOS allows it only to local network addresses. See
[Plain-HTTP servers on a LAN](#plain-http-servers-on-a-lan). That's the
behaviour you want, and the thing to remember when a release build cannot
reach a server that a development build could.

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
the app and must not be given to anyone. `plugins/withAndroidReleaseManifest.ts`
writes a release-only manifest that removes `SYSTEM_ALERT_WINDOW`, which React
Native asks for so the dev menu can draw over other apps.

R8 stays off for Android release builds (`enableMinifyInReleaseBuilds: false`),
as it was before SDK 58 turned it on by default. With it on, WorkManager could
no longer construct its database by reflection and the app closed at launch.
Turning it on means checking every library that reflects, ours included.

Push only fully works in a build you make yourself, with your own Expo project,
Firebase project and Apple developer account. The store builds are waiting on
App Store and Play Store review and can't ship with the maintainer's personal
Expo, Firebase and Apple push keys. `app.json` has the maintainer's Expo
`owner` and `extra.eas.projectId` committed. Remove both and run `eas init`,
which writes a project id of your own, the one `PUSH_PROVIDER=expo` needs. An
iOS build also needs a bundle identifier on your own Apple team. Android needs
your own `google-services.json`. It's gitignored, and `app.config.ts` only
points at it when the file is present. `google-services.example.json` shows
the shape. Without a project id the app tells the user push is unavailable.
See [push notifications](../install/push-notifications.md) for the rest.

## Permissions

Hearth asks for exactly what background family tracking needs. A checklist
(_Set up Hearth_) shows up on first sign-in and can be revisited from
_You → Tracking status_.

| Permission                     | iOS                                                                           | Android                                                     | Why                                                                                                                         | Requested                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Location, foreground           | `NSLocationWhenInUseUsageDescription`                                         | `ACCESS_FINE_LOCATION` (+ coarse)                           | Show you on the map                                                                                                         | Onboarding, step 1                                                             |
| Location, **Always**           | `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location` | `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` | Answer the server's pings and Live while the app is closed                                                                  | Onboarding, step 1 (second prompt)                                             |
| Precise location               | `NSLocationDefaultAccuracyReduced = false`, full vs reduced detected          | fine vs coarse detected                                     | Places and trips need GPS accuracy                                                                                          | Detected, checklist links to Settings                                          |
| Notifications                  | runtime, `UIBackgroundModes: remote-notification` for the silent ping         | `POST_NOTIFICATIONS`                                        | Arrivals, battery, **SOS**. Local SOS banners need it even with no push provider                                            | Onboarding, step 2                                                             |
| Battery optimisation exemption | n/a                                                                           | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                      | Doze and vendor power managers are the #1 reason background location dies                                                   | Onboarding (Android), opens the system dialog                                  |
| Do Not Disturb access          | n/a                                                                           | `ACCESS_NOTIFICATION_POLICY`                                | Lets the SOS channel through Do Not Disturb. Optional                                                                       | Checklist (Android), optional, opens the system list                           |
| Background refresh / tasks     | `UIBackgroundModes: fetch, processing`, `BGTaskSchedulerPermittedIdentifiers` | `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`                       | The fallback fix and the queue flush, when the OS allows                                                                    | Declared, checklist explains the iOS toggle                                    |
| Motion and activity            | `NSMotionUsageDescription`                                                    | `ACTIVITY_RECOGNITION` (+ the Play Services variant)        | Say whether the phone has moved since its last fix without turning location on, and when a drive starts for crash detection | Checklist, right after location. Hidden on a phone that cannot classify motion |
| Camera                         | `NSCameraUsageDescription`                                                    | `CAMERA` (via plugin)                                       | Scan an invite QR                                                                                                           | Only when you tap _Scan_                                                       |
| Local network                  | `NSLocalNetworkUsageDescription`, `NSBonjourServices`                         | n/a                                                         | Self-hosted servers on your LAN                                                                                             | Prompted by iOS on first LAN connection                                        |
| Photo library                  | `NSPhotoLibraryUsageDescription` (picker plugin)                              | system picker, no permission                                | Choose one profile picture                                                                                                  | Only when you tap your avatar                                                  |

Android calls the background choice _Allow all the time_ and the foreground
one _Allow only while using the app_, so on Android the checklist uses those
words where iOS says _Always_ and _While Using_. The Android text opens with
the sentence Play's reviewers look for in a prominent disclosure, that Hearth
collects location data even when the app is closed or not in use. The strings
are chosen by platform when `i18n/en.ts` loads, and a member's issue line,
which may describe a phone on the other platform, is worded to fit both.

The motion classifier is what lets a ping go unanswered by the GPS. Core
Motion and Play Services have already worked out what the phone is doing for
the system, so asking them costs no location at all. A phone they have had
lying still since its last fix answers a ping with that fix again, and a drive
they spot is where crash detection starts. The checklist asks once, from its
own Allow button, and nothing the tracker runs in the background ever raises
the dialog: Android answers a request made from a process with no Activity as
denied without showing anything, and the module then reports denied for good.
A phone that refuses, or one that cannot classify motion at all, still
reports. It takes a Wi-Fi fix for every ping, and crash detection cannot run
on it.

The accelerometer and gyroscope need no permission on either platform at the
rates Hearth samples them, and on iPhone the barometer comes under Motion and
Fitness, which the classifier already asks for. That is what makes crash
detection possible without asking for anything new. It appears on the setup
checklist for exactly that reason, while a circle has crash alerts on:
unannounced, it would be a sensor nobody agreed to.

Commercial trackers ask for a pile of things Hearth deliberately doesn't. No
contacts, because invites are codes and QR. No microphone. No Bluetooth, because
there is no hardware tag to talk to. No advertising identifier, and no tracking
of any kind. The photo library is reached through the system picker, which hands
back the one file you chose rather than access to the album. Motion is there to
keep the GPS off and to know a drive has begun, never to collect a fitness
feed.

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
as long as they are on. Battery Saver stops background location, Low Power Mode
holds back the background pushes Hearth answers, and both flip without the app
being opened. The checklist re-reads everything on focus and on every
return to the foreground, because these settings revert after system updates
on several of those makes.

None of the vendor component names can be checked without the handset in
hand. That is why every candidate is tried in turn and the app's own page is
the floor.

### Plain-HTTP servers on a LAN

The two platforms differ here, and you tend to find out at release time.

| Build                                    | iOS                                                              | Android                                  |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| EAS `development` profile                | any HTTP host (`NSAllowsArbitraryLoads`)                         | any HTTP host (`usesCleartextTraffic`)   |
| Anything else, a local prebuild included | **private ranges and `.local` only** (`NSAllowsLocalNetworking`) | debug any HTTP host, **release no HTTP** |
| Built with `HEARTH_ALLOW_HTTP=1`         | any HTTP host                                                    | any HTTP host                            |

Both are decided at prebuild time from `EAS_BUILD_PROFILE`. `NODE_ENV` plays no
part, because `expo prebuild` sets it to `development` whenever it is unset,
and a release archived from that prebuild would otherwise allow every host
without anyone having asked for it. An Android debug build allows HTTP anyway,
from the template's debug manifest. `HEARTH_ALLOW_HTTP=0` forces the strict
behaviour into an EAS development build, which is how you check a TLS-only
setup before you ship it.

iOS ignores `NSAllowsArbitraryLoads` whenever `NSAllowsLocalNetworking` is also
present, so Hearth emits exactly one of the two.

A production Android build therefore can't reach `http://192.168.1.10:4000`
unless it was built with `HEARTH_ALLOW_HTTP=1`, while a production iOS build
can. Put TLS in front of the server (see [self-hosting](../install/self-hosting.md))
and neither caveat applies.

The app can't ask the OS which of these it was built with, so `app.config.ts`
writes the answer into `extra.plainHttp`, and `utils/serverProbe.ts` reads it
back with the platform. The server screen suggests typing `http://` only when
that address could work from this build. Anywhere else, an Android release
or a public name on an iPhone, it says the app connects only over HTTPS, and
an `http://` address it can't use is refused in the same words rather than as
a server that didn't answer. In development `extra` comes from whatever Metro
evaluated, which can differ from the build on the phone.

### Invite links

The API serves `https://your-server/join/ABCD1234` itself. It shows the code,
the server's address and the steps for somebody without the app, with an Open
in Hearth button that goes to `hearth://join/ABCD1234?server=<address>`. That
works in every build, because the `hearth://` scheme is registered
unconditionally. The QR code in the app is the same web link, so a phone
camera opens the page and Hearth's own scanner reads the server from it.
`parseInviteLink` in `utils/inviteCode.ts` takes either, and an older link
with only the code still works. On a phone that was never set up, the server
it names goes into the server field, ready to confirm.

Android App Links, where tapping the link opens the app directly rather than a
browser page that then offers to, need a concrete domain compiled in and
verified against a file on that host. Every family self-hosts somewhere
different, so no build ships one. Opt in at prebuild time:

```bash
HEARTH_APP_LINK_HOST=hearth.yourfamily.com npx expo prebuild --platform android
```

## How background location works

All of this lives in `app/services/location/tracker.ts`, and on Android in the
native module under `modules/hearth-motion/android`.

The phone takes its location when somebody asks, and not otherwise. The
server pings it on its circle's interval, five minutes out of the box, and a
little sooner while its last fix had it on the move. The motion classifier,
which costs no location, says whether the phone has moved since its last fix.
One lying still answers with that fix again and never turns location on, and
one that moved answers with one Wi-Fi grade fix. Opening a member's page asks
for a fresh fix, and Live puts the phone on a GPS fix a second for as long as
somebody watches. Moving never switches on continuous tracking. The one
exception is a drive, where a circle wants crash alerts: the GPS runs for the
detector, and those fixes stay on the phone (see
[crash detection](#crash-detection)). Otherwise there is no location session
between asks, so the location indicator stays off at home, and an Android
phone has no service and no notification up. Builds before 1.3.4 tracked
continuously instead, on a walking tier, a GPS driving tier and a parked tier
with a geofence round the parking spot, and the indicator was on all day.

1. `TaskManager.defineTask(BACKGROUND_LOCATION_TASK)` at module scope (imported
   from `app.tsx` as a side effect), so the OS can hand over a delivery before
   any React code has mounted. Only iOS runs a session, for Live and for a
   drive. A delivery outside both, or any delivery on Android, comes from a
   session an older build left running or a stop that never landed, and it
   stops the session.
   The module also writes a `boot` line to the diagnostics log saying whether
   the process is headless, and drains whatever the Android side queued while
   JavaScript was down.
2. The ping. On iOS the silent push reaches the expo-notifications background
   task (`NOTIFICATION_WAKE_TASK` in `services/notifications.ts`), and
   `answerWake()` answers it (`wakeFix`): with the last fix again when Core
   Motion's history has had the phone still since, and otherwise with one
   `Balanced` fix. On Android the push handler in the native module answers it
   without starting JavaScript, see
   [the Android transport](#the-android-transport). An ask
   that comes down the control channel, which only happens while the app is
   open, is answered from JavaScript on both platforms, under the brief
   service on Android.
3. Each fix → `toFix()` (adds battery and the `activity` label below) → the
   MMKV-persisted queue → `flush()` (single-flight upload, oldest first). On
   Live, `thin()` drops the near-duplicates a fresh iOS session hands over in
   bursts, so the stream is a fix a second rather than three. A retry already
   waiting keeps its timer, so a firewall that locked the address out isn't
   met with a request for every fix.
4. While the app is in the foreground, a heartbeat answers itself whenever the
   last fix is older than the interval, by the ping's rule: the last fix again
   for a phone the classifier has had still, one `Balanced` fix otherwise. It
   is the ping from the app's side, on the same interval, so a phone in use
   reports no more often than one in a pocket, and it needs no Android service
   for one fix. Its
   fixes go up as `source: "nudge"`, like the server's ping, and are read
   like one. `heartbeat`, which the server keeps out of trips and the
   possible-incident check, is what apps before 1.3.4 sent from a parked
   phone with the app open. It swallows a failed acquisition rather than
   showing it as an error. A fix still being acquired
   counts as fresh only until its deadline, so a native request that never
   settles cannot hold the heartbeat off for the rest of the process. It runs
   as a chain of timers, so a circle that changes its interval applies at the
   next tick.
5. `expo-background-task` registers `com.binary.rewind.hearth.sync` as the
   fallback for pings that never arrive. iOS holds silent pushes back when it
   decides an app has had enough, and FCM can sit on one in deep Doze. The OS
   runs the task when it chooses, a quarter of an hour apart at the very
   soonest and never while the app is open. It flushes the queue, re-reads the
   permission and the Location switch, and takes a fix only when the last one
   is older than two intervals, so a phone the pings are reaching does nothing
   there. `patches/expo-background-task@58.0.12.patch` makes it an app refresh
   task on iOS (`BGAppRefreshTaskRequest`) rather than a processing task,
   which iOS tends to hold for a phone that is idle and charging.
6. Every upload reply carries the policy, and the tracker keeps its interval
   for the heartbeat and the sync task. When the phone is asked is up to the
   server.

Turning off _Share my location_ in the app stops all of it. The phone answers
no ping, goes Live for nobody, and captures and queues no fix. It tells the
server it switched off, and the server stops pinging it until it says sharing
is back on or sends a fix. On Android a ping already on its way is dropped by
the push handler without starting anything. The map shows the phone's owner a
banner saying sharing is off, with a button to turn it back on.

The switch stays on through things that stop the tracker without the person
asking, such as a session that ended, a change of server, a permission dropped
below Always or Location Services switched off. `refreshLocationStatus()` runs
every time the app comes to the front and after every sign-in. It stops the
tracker when the permission or the switch rules it out, and starts it again
once the phone is signed in, the switch is on, the permission is Always and
Location Services are on. It never starts a tracker whose switch is off, and
never one the server refused, see Uploads below. `startTracking()` runs one
start at a time, so the app coming back and a sign-in in the same moment start
it once.

An app updated from an older build takes back what that build left with the
OS, once. `forgetLegacy()` stops the expo location request it kept running
between asks and the geofence it armed round the parking spot
(`hearth-stationary-geofence`). The OS holds both for the app across an update,
and expo restores them at boot. On Android, `LegacyRequests` removes the
half-minute classifier verdicts and the geofence older builds left with Play
Services, at the update itself (`MY_PACKAGE_REPLACED`) or at the first start
after it. The transitions stay, since `MotionUpdates` asks for them again
under the same request code. The tracking store moves to version 3, where the
mode is `on` or `off`, the parking spot, the old drive state, the activity
history and the service-death stamps are gone, and the classifier's last
verdict, the last real fix and the drive under way are kept.

### The ping

The server decides when a phone reports. Its job tick asks each phone for one
fix once its interval has passed since it was last heard, down the control
channel when one is open and otherwise by silent push (`wakeQuietPhones`, see
background jobs under [architecture](architecture.md)). Both carry `ping:
true`, which is how the phone tells the server's schedule from somebody asking.
A phone in no circle is not asked, since nobody could see its fix, and nor is
one that said sharing is switched off and has sent no fix since. The interval
is the strictest circle's, five minutes by default, and the server holds it
between two and ten minutes whatever a circle says. Past ten, a phone on the
move would read as stale on the map between one ping and the next. A phone
whose last fix said it was walking, running, cycling or driving is asked a
little sooner, on the server's `PING_MOVING_INTERVAL_SECONDS` (120 by default,
from 120 to 600, and never later than its circle's interval). Circle settings
offer every 2 minutes, every 5, a 10 minute battery saver, or anything from 2
to 10. A phone that stops answering is asked every half hour once twelve asks
have gone unanswered, and every three hours once sixty have, for as long as it
stays signed in, so a phone that was only flat comes back. Any upload starts
the count over.

The app registers its push token even when the person declines notifications.
The ping is a silent push, which neither iOS nor Android needs alert
permission for, so a phone that turned alerts down is still pinged.

How the phone answers depends on the motion classifier. A phone it has had
lying still since its last real fix, while that fix is under an hour old,
answers with that fix again, stamped now and labelled `still`, and location is
never turned on. On Android that happens in the push handler without even
starting the service (`Departure.stillSinceLastFix`,
`NativeUploader.sendStill`), and the classifier's still transition has to have
come before that fix. On an iPhone Core Motion's history since that fix has to
show nothing but still, said with at least medium confidence (`queryMotion`
and `stillThroughout` in `services/location/motion.ts`). Once the real fix is
an hour old the next ping takes a new one, so a departure the classifier
missed costs the family an hour at most.

A phone that moved, or one without the motion permission, answers with one
`Balanced` fix, Wi-Fi and cell grade, since a street's worth is what a ping is
for and the GPS is what costs. On Android that priority leaves the GPS off.
iOS chooses its own sources for a fix to a hundred metres. An ask somebody
made, opening a member's page, a nudge or the map's refresh, is a `wake`
without `ping` and always takes a fresh fix. A check-in asks for `High` and an
SOS for `Highest`, because there a person is asking.

Each fix is labelled with the classifier's verdict where it has one, `still`,
`walking`, `running`, `cycling`, or `driving` for in a vehicle. On Android that
is the last transition (`Departure.serverActivity`), and on an iPhone the
newest of Core Motion's records the ping read (`classifierActivity` in
`tracker.ts`). With no verdict, `pingActivity` in `tracker.ts` and
`UploadWire.activity` on the Android side work it out from the fix. A speed the
GPS measured decides outright. 6 m/s or more is driving, under 0.5 is still,
and anything between is unknown. A Wi-Fi or cell fix measures no speed. Android
reports 0 for one where iOS reports -1, so a zero on a fix looser than GPS
class (30 m) is read as unmeasured (`measuredSpeed`), or every network fix
would be a car that had stopped. Without a measured speed the fix before it
decides, if the two are between a minute and an hour apart. When both are sharp
to 100 m, two fixes no further apart than their error circles plus 50 m are
still. Driving is road speed over the distance the two error circles can't
explain, so a kilometre-wide cell estimate never reads as standing still or as
a drive. Anything else is unknown, since walking is the classifier's to say.

What that costs, said plainly:

- An iPhone answers a ping only when iOS hands the silent push to the app, and
  iOS decides how many of those an app gets. Expect it to answer fewer pings
  than it is sent, and fewer still in Low Power Mode or with Background App
  Refresh off. An iPhone where Hearth was swiped away in the app switcher
  answers none until somebody opens it.
- An arrival or a departure can be up to one interval late, plus the minute
  the job tick may add, because the fix that crosses a place's edge is the
  next ping. A departure the classifier missed waits for the next real fix,
  an hour at most after the last.
- Trips, speed and the hard-stop check are coarse outside Live. A drive
  between pings is a fix every two minutes or so, Wi-Fi grade unless crash
  detection is running, so its trail is dashed between them, and a short one
  may leave too few fixes to make a trip unless it runs between two named
  places. A speed alert needs a measured speed, which a ping carries only on
  a drive with crash detection on, when the drive's GPS fix answers it. The
  server's hard-stop check needs Live-rate fixes.
- On an iPhone crash detection starts only once a ping finds the drive, so up
  to an interval into it, see [crash detection](#crash-detection).

### Live

Live is the other occasion. It runs for as long as somebody has the member's
page open, see Watching below, and for half an hour from when the member raised
an SOS or last pressed it again. On Android the native service runs a `High`
accuracy request at a fix a second and sends every fix itself. On iOS a
location session runs for the window and no longer (`liveOptions()`), at `High`
accuracy with no distance filter and `pausesUpdatesAutomatically` off. It
starts from the watch push, a `watch` down the control channel or an upload
reply that names a window, and stops when the window ends or the server's reply
says nobody is watching.

### The Android transport

Android hands out location in the background only to a foreground service,
and an app may start one from the background only at a few moments, a high
priority push among them. Without a service the phone is an ordinary
background app: a few fixes an hour, none in Doze, and a process reclaimed
within minutes on most OEM builds. So the service runs for the seconds a ping
takes, for a Live window, or for a drive with crash detection on, and is gone
otherwise. Its notification, "Updating your location", or "Crash detection is
on for this drive" on a drive, is one plain line on a channel the service
creates
at minimum importance (`hearth-wake`, "Location updates"), not ongoing, so
from Android 13 the person can swipe it away and the service runs on without
it. Android 12 and later hold a new service's notification back for about ten
seconds, so a ping is often over before it appears. The app's own channels,
`default`, `alerts` and `sos`, come from `setupChannels()` in
`services/notifications.ts`. `setupPush()` sends the phone's time zone and
clock (`services/phoneClock.ts`) with its registration on every launch, since
the server reads quiet hours and the time on late news on them.

Everything that answers the server is native Kotlin in
`modules/hearth-motion/android`, so JavaScript need not start for a ping:

- `HearthTransitionReceiver` is declared in the manifest and is the target of
  the classifier's activity transitions (`MotionUpdates` in
  `PlayServicesRequests.kt`): entering still, walking, running, on a bicycle
  or in a vehicle. Play Services debounces them and starts the process to
  deliver one, and they cost no location. The receiver writes what the phone
  is doing to `TrackerPrefs` and the queue, and starts nothing, except that a
  vehicle, where a circle wants crash alerts, starts a drive, and still or on
  foot ends one (`Departure.kt`). Builds before 1.3.4 also asked for a verdict
  every half minute, which started the process all day for a phone in a
  drawer.
- `HearthMessagingService` sits in front of expo-notifications' own service
  (the manifest gives it the higher priority) and answers a `wake`, `watch` or
  `nudge_requested` push inside the message handler, the one moment a
  background app may start a service. With sharing off or signed out it takes
  no fix. With an upload key it starts `HearthTrackingService` with the ask. A
  `wake` or a `watch` goes no further, so JavaScript is not started for every
  ping. A `wake` marked `ping` to a phone the classifier has had still since
  its last fix, with no service running, is answered on the spot with that
  fix again, without location and without the service. A
  `nudge_requested` is a notification the person should see, so it goes on to
  expo-notifications as well and is shown. Without a key, from a server
  older than 1.3.2, it starts the brief service and passes the push on to
  expo-notifications, and JavaScript takes the fix. A push FCM delivered at
  normal rather than high priority can't start a service unless Hearth is
  exempt from battery optimisation, so the start isn't tried. There, and
  wherever Android refuses the start, the handler takes one `Balanced` fix on
  its own thread, within five seconds, and sends it before the handler's time
  is up.
- `HearthTrackingService` is the foreground service. For a ping it runs a
  `Balanced` request and sends the first fresh fix within 100 m, or the best
  one inside fifteen seconds, or failing both the system's last fix if that is
  under two minutes old. The service stops once the server has the fix, and
  waits 45 seconds at most for the upload. For a watch it runs a `High`
  accuracy request at a fix a second, sends each fix as it comes, and follows
  the window the server names in each upload reply (`WatchWindow` in
  `UploadWire.kt`), ten minutes at most per ask. A ping that lands inside a
  watch is answered by the watch's next fix. For a drive it runs a `High`
  accuracy request every five seconds, puts each fix on the queue marked local
  for the detector and uploads none of them, and opens the headless task that
  keeps the JavaScript detector running. A ping during a drive is answered
  with the drive's next fix. The drive ends on an on-foot transition, on a
  still one that holds three minutes with no speed seen in them, after ten
  minutes of its GPS having the phone under 2 m/s, or when crash alerts or
  sharing go off (`setTrackerState`). A ping that finds the phone moving like
  a car while the classifier still says vehicle starts the drive again, which
  covers a long standstill, a start Android refused and a service an OEM
  killed. The service is not sticky. A
  restart Android makes on its own stops at once, since the server asks again
  when it wants a fix. `startForegroundService` throws at the call on Android
  12 and later when the start is not allowed, and the refusal goes on the
  queue, so the tracker log shows it. A command for a service already in the
  foreground goes by a plain `startService`, which needs no exemption.
- `NativeUploader` sends the service's fixes with the session's upload key
  (`uploadKey`, which the server hands an Android session with its tokens and
  the tracker passes down in `syncUploader`). It labels each one with the
  classifier's verdict, or failing that against the last fix it sent. A fix
  waits in its own file until the server has it, then
  goes on the queue marked `sent`, so `ingest` learns from it and sends nothing
  again. One that cannot be sent, because the key was refused or the service
  is going, goes on the queue unmarked and JavaScript sends it. The server's
  answer comes back as an `uploaded` event and moves the watch.
- `TrackerQueue` keeps those fixes and events as one JSON document per line
  under `filesDir`. A poke reaches JavaScript only when it is already up and
  listening (`onNativeQueue`). Nothing in the queue starts it, since the queue
  is a record of what the native side already did, and the next launch drains
  it first thing.
- `HearthHeadlessService` runs the JavaScript tracker's headless task
  (`HearthTracker`, registered in `index.tsx`) under the brief service, which
  only a session without an upload key uses, and for a drive. The task drains
  the queue (`processNativeQueue`), fixes first through `ingest`, then events.
  For a drive the service opens one task, `awake`, which `keepTrackerAwake`
  holds until the drive is over. React Native runs no JavaScript timer in the
  background without an open task, and the detector is JavaScript.
- `HearthBootReceiver` asks for the classifier's transitions again after a
  reboot, which drops every request Play Services held. At the update itself,
  the first moment the new build runs, it also calls
  `LegacyRequests.forget()`. `setTrackerState` calls that too, for a phone that
  was off at the update, and it does its work once.
- `HearthDiagnostics` puts what the phone says about Hearth in the log, once
  per process: the last exits from `ApplicationExitInfo`, whether the app was
  force stopped (`ApplicationStartInfo`, Android 15 and later), the standby
  bucket, the battery exemption and background restriction, and for every
  ping or watch push its priority against the one it was sent with. A
  `normal` against `high` is FCM having demoted the push, which no longer
  lets the service start from the background.

The battery optimisation exemption still matters. An exempt app may start its
service from a push FCM demoted, and keeps its network in Doze. FCM may demote
an app's high priority pushes when they don't lead to a notification the
person sees, and a ping's notification often never shows, so the `push` lines
in the log are worth reading on a phone that goes quiet. The checklist asks for
the exemption directly (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, allowed
for family safety apps) and, on the vendors that kill background apps, walks
the person through the vendor's own settings.

The upload's wire format, the watch window and the ping's labels have plain
checks in `modules/hearth-motion/test/UploadWireTest.kt`, and what a
transition starts and when a ping may repeat the last fix in
`DepartureTest.kt`, each run the way the file says.

`patches/whatwg-fetch@3.6.20.patch` settles every `fetch` as a microtask rather
than on a zero delay timer. React Native's networking events need no timer, but
the polyfill resolved each answer on one, and One UI holds an app's timers back
in the background, so a request the server had already answered never finished.

`patches/expo-location@58.0.20.patch` remains for iOS (the one-shot manager's
`allowsBackgroundLocationUpdates`). Its Android half went with SDK 58, since
Android's pings and Live run in Hearth's own service and never reach
expo-location's. Expo ships its modules to Android as prebuilt AARs,
so `apps/mobile/package.json` lists expo-location and expo-notifications under
`expo.autolinking.android.buildFromSource`. Every patch in `patches/` is
applied by `scripts/apply-patches.mjs` from the root `postinstall`, not by
pnpm's `patchedDependencies`: with `node-linker=hoisted`, which Metro needs,
pnpm applies a patch again on every install, and `expo prebuild` runs one,
which left the Kotlin declared twice. The script applies each patch once and
leaves one already in place alone.

### One-shot fixes

Every one-shot fix JavaScript takes, a ping answered there, a check-in, an
SOS, the heartbeat and the sync task, has a twenty second deadline inside
`acquireFix`. Android's `getCurrentPositionAsync` has no timeout of its own,
and a request a background app makes can hang for the life of the process.
iOS gives a silent push about thirty seconds. When the fresh fix is late, the
fix the OS already has stands in if it is under two minutes old, since a ping
wants to know the phone is alive more than it wants a new estimate. The
heartbeat takes no stand-in.

A fresh request the OS answers from its cache, with a fix over a minute old,
is asked once more inside the same deadline. An iPhone opened after hours away
was handed the fix iOS still held from where the phone had been. Uploaded with
its own timestamp, the server never moved presence back to it, and the row
kept saying "two hours ago, at home". A second cached answer is all the OS has
and is taken as it is. Every `report done` line in the diagnostics log carries
the fix's age in seconds and the label it got.

On iOS, expo-location's one-shot manager had `allowsBackgroundLocationUpdates`
off, which Apple documents as a manager Core Location need not keep the app
running to serve. The patch sets it when the app is authorised Always and
declares the location background mode, so pings and nudges are served in the
background.

### Uploads

A failed upload (network, 5xx, 429) keeps the queue and retries on its own
after thirty seconds, then a minute, then two, while the process lives. After
that it waits for the next fix, which outside Live is the next ping. An upload
that gets through starts the ladder over. On Live the ladder is two, five and
ten seconds, and the ten repeats, since the next fix is a second away and
waiting for it is no back-off at all. Every fix stays queued meanwhile. A live
upload gets four seconds rather than thirty, and one that runs out goes again
at once on a fresh request with the same fixes in the same order, because one
stuck on a dead connection froze the viewer's map for as long as it waited. A
second timeout in a row is a slow network rather than a stuck request, and the
ladder takes over with the full time. A 4xx that is not an auth problem drops
that batch so one bad fix cannot wedge the pipeline, and the next batch waits
on the same ladder rather than going at once, since a firewall in front of the
server can lock the phone out for a 4xx. A 403 from Hearth itself ends sharing.
The tracker stops, says why on the You screen, and uploads nothing more until
the next sign-in or the person turns sharing back on. A deactivated account
answers that, though deactivating through the admin routes also revokes the
sessions, and the phone then signs itself out on the 401 that follows.

### What the phone says about itself

`services/health.ts` sends `PATCH /me/health` with the checklist's reading of
the phone. That covers the location permission level, whether location is
precise, Location Services, motion access, Background App Refresh on iOS,
battery optimisation and the Restricted background setting on Android, Low
Power Mode
or Battery Saver on either, the manufacturer in lowercase, and whether _Share
my location_ is on. It goes when the app comes to the front, after a sign-in,
after the checklist or the Sharing switch changes anything, and the moment Low
Power Mode or Battery Saver flips, which the native module reports as an
`onPowerStateChange` event. The tracker sends it from the background too, when
the sync task or a failed location delivery finds the permission or the
Location switch changed. Those sends go at most once in ten minutes, so a
switch flapping in a car park cannot spam the server, and they read the
switches without acting on them, since a tracker stopped in the background
would stay off once Location came back. Otherwise it goes again only when
something changes, the account changes, or a day has passed. The server keeps
it on `user_presence.health`, projects it as `issues` on presence, and the
rows put the first issue under the member's name once the phone is stale.
Sharing switched off is named at once, whatever the staleness, and the member
page shows a pill while precise location is off. A stale phone whose last
reading was 5% or less, off the charger, reads "Battery likely ran out"
instead (`batteryRanOut` in `packages/shared`). The server leaves what a flat
battery explains out of its `issues`, power saving, battery optimisation and a
restricted or stopped service, so an app that predates the line says the phone
went quiet rather than blaming power saving. A switch somebody turned off is
still named first. The offline sweep reads it too, so a quiet phone that has
said why it cannot report is reported as that, not as offline. A stopped
service is no longer sent, though the server still reads it from an older
app.

Sharing switched off on the phone is a pause of every circle that allows
one. Those circles see "Sharing paused" and no position, and hear no offline
alert. A circle with pausing turned off is told plainly instead. It keeps the
last position, faded once stale, the member's name says "Turned off location
sharing", and its offline alert says that is why. A fix newer than the
report reads as sharing back on, in case the report that said so has not
landed.

Every fix carries the `activity` label from the ping, and the server reads
`still` as a phone meant to be quiet and one on the move as a phone to ask a
little sooner. A phone whose last fix said `still`, or
that is inside a named place, is called offline only after twelve hours of
silence rather than one, since an iPhone that has not moved may answer few
pings. An account signed in only on Android phones gets about 100 minutes
instead, since Android answers a ping even from Doze. Where the server can
push, the verdict also waits for three unanswered asks, which is two not
counting the newest, since that one may have gone out in the same tick. A
phone the server can't ping at all, with no push token or on a provider other
than `expo`, is judged on its silence alone.

### Diagnostics

`services/location/log.ts` keeps the last thousand things the tracker did, on
the phone, in chunks of a hundred so a line costs one short write. While
somebody watches Live the deliveries and uploads are counted rather than
logged, and go in as one `live` line every half minute and one when the window
ends, so a window cannot wash the night's evidence out of the log. Otherwise
it records `boot` with whether the process was headless, `on` and `off`,
`push` for every push the app hears, `report` / `report done` /
`report failed` for every one-shot fix with its source, accuracy, age and
elapsed time, `fixes` delivered and kept, `flush` / `flush failed` with sizes
and status, `sync` for each run of the sync task and whether the phone was
overdue, `watched`, `watch adopted` and `watch over`, `wake`, `still` for a
ping answered with the last fix, `motion` for each verdict the classifier
gave, `drive` and `drive over` with why, `awake` while a drive holds the
headless task, `refused`, `resumed`, `heartbeat skipped` with the reason, and
`legacy fence stopped` once after an update. From the Android queue it adds
`native wake` for a ping answered there, whether it was answered still and
whether it found a fix, `native service` for a service
Android refused or stopped, each push's priority against the one it was sent
with, the last exits and the power state. A shared log opens with a header
from `headerForTrackerLog()` with the mode, the ping interval, queue length,
whether the server is refusing uploads, last error, permission, whether
location is precise, service status, the watch window and the platform. The
log holds no coordinates, so it can be pasted into an issue without saying
where anybody lives. When a family member says "it went quiet at home", this
is the page to ask for. From the server, a ping that never arrived and one
that arrived and found no fix look the same, and the log tells them apart.

### The control channel

The tracker keeps its own websocket to the server while somebody has the app
open, and on an iPhone for the length of a Live window, whose session keeps
the process alive (`syncControl` in `tracker.ts`). Between those it holds
nothing open, and an ask reaches the phone by silent push. It sends
`{ type: "control" }` on open and nothing more of its own (the server sends a
websocket ping every two minutes and the socket layer answers), reconnects
with backoff, and rotates its token itself when the server refuses it
(`services/location/control.ts`). An ask (a page opened, Live, the map opened,
the location ping) comes down it and is answered within a second. A
`wake` takes one fix, a `watch` goes live, and a `watch` with no seconds left
ends the window. Each ask carries an id, and the channel sends
`{ type: "control", ack }` back before it does anything else, because the
server pushes instead when no answer comes within three seconds. The UI's
socket in `services/realtime.ts` is a different thing. It lives with the
screen, and the server sends asks only to a socket that declared itself the
control channel.

An ask for a phone with no channel open goes by a silent Expo push, high
priority on Android and at Apple's background priority on iOS. On Android
`HearthMessagingService` answers it natively, as above. On a server that hands
out no upload key, the JavaScript task takes the fix under a brief service
instead (`wakeFix`, `startBrief` in `services/location/nativeTracker.ts`). On
iOS the expo-notifications task answers it (`answerWake` in `tracker.ts`).

Opening a member's page calls `POST /circles/:id/members/:userId/refresh`
for one fix now, the way opening the map calls
`POST /circles/:id/locations/refresh` for everyone quiet.

### Watching

The Live page is for watching somebody right now, a car along a road or a
child about to come out of school. The page calls
`POST /circles/:id/members/:userId/watch` on focus and every minute after.
Each viewer holds a window of their own, and the phone's is the latest of
them. The server sends the ask down the phone's control channel when the
phone says it has it within three seconds, or a silent `watch` push
otherwise, and pushes again when the phone has said nothing for twenty
seconds and the last push is ninety seconds old, three times per window at
most. That catches a phone whose live service Android stopped mid window.
The reply says which (`pushed`), when the phone was last heard and what it
said stands in its way. Every upload reply also carries `watchedUntil`, so a
phone that is already reporting picks the watch up on its next batch whether
or not the push arrived.

On Android the watch push starts the service live, inside the message
handler. The service sends every fix itself, follows the window the server
names in each answer, and goes when the window ends. JavaScript, when it is
up, holds the same window in its store (`enterWatched`) and passes on only a
viewer leaving, since its own timer can run ahead of an answer it has not
drained yet. Nothing runs under the service, so one Android kills inside the
window leaves the phone quiet until the server's next push. Where Android
refuses the service, the push handler answers with one fix and the server
asks again the same way. On iOS the watch push wakes the app, and
`enterWatched` starts the Live session for the window. iOS takes no time
interval, so the session has no distance filter either, which is the only
shape that delivers to a phone standing still, and `ingest` thins the stream
to a fix a second. A hold on a window already live only moves its end, with
no fresh fix and no new session, though a hold that came by push still brings
back a live service Android stopped, since a push is a moment Android allows
the start.

The page lets go with `DELETE` on the same path when it loses focus or the
app goes to the background. Inactive, under Control Centre or a call, it goes
on holding. With nobody else watching the server ends the window, and the
phone hears it at once. An upload reply with no window, or a shorter one,
ends or shortens what it holds, and so does a `watch` with no seconds left
down the channel. A reply to an upload sent before the latest ask can't end
it, since the ask is newer news. Otherwise the window ends by a timer and by
the first fix past it, whichever comes first, and the session or the service
stops until the next ping, or goes back to a drive that was under way. The
page sends neither the release nor a trail fill
to a server whose watch reply has no `supports`.

The Live page calls the phone live on any fix from the last thirty seconds,
counting one from up to thirty seconds before the ask, since the one fix an
ask gets out of an iPhone is stamped before the ask reached it. It holds the
display on for as long as it is open (`expo-keep-awake`, its own tag), since
following someone along a road is watching rather than reading. Asks closer
together than ten seconds go as one a moment later, so pulling to refresh
can't reach the server's sixty in ten minutes, and a `429` says there were too
many asks, not that the server could not be reached. The map follows them
with a short linear glide until the viewer moves it, and then stays put, with
a Follow button to pick them up again.

The button that opens it is offered for anyone the viewer sees precisely,
parked or on the move (`liveOffered` in `utils/activity.ts`), and never on
your own page. A phone that doesn't answer is said to be not answering, with
the reason.

Where somebody is, in words, comes from the phone's own geocoder
(`utils/geocode.ts`), with no Hearth server and no account. It is not private
to the phone. `reverseGeocodeAsync` hands the coordinates to Apple on an
iPhone and, on most Android phones, to Google, which answer over the network.
It is on by default, and _Street names_ under _You_ turns it off
(`streetNames` in `stores/settings.ts`), after which `useNearby` asks nothing.
Answers are cached on a hundred metre grid. Android's geocoder
falls back to an Open Location Code where it has no street ("8H+2W",
"7JVW4XPP+2H"), which is a coordinate spelled differently and means nothing
to a family, so plus codes, bare house numbers and postcodes are read as no
answer and the district, town or region is used instead. All of the
geocoder's answers are tried in turn, since the plus code is often the first
and the street the second.

A member settled somewhere no place covers gets a "Save this spot as a
place" row on their profile, which opens the place editor on their position
with the geocoder's name as a first draft.

The Live page draws the fixes that arrive while it is open and nothing else,
every fix of each upload, from the socket's `fixes` (`useLiveTrail`). After a
reconnect or a return to the front it fills what it missed from
`GET .../live-trail`, since the last point it drew. A fix far looser than the
last few, a Wi-Fi grade fix in a stream of GPS ones, is left out of the line
(`liveTrailToDraw` in `utils/trail.ts`), and so is a step under five metres.
A trip draws its own trail, and only where the phone reported it: a silence
between two fixes is dashed (`splitTrail`), because the road between them is
a guess. Outside Live that is most of a drive. The profile map draws no trail.

Opening the map calls `POST /circles/:id/locations/refresh`, which sends one
`wake` to each member quiet for a couple of minutes. Each wake goes down the
phone's control channel when it has one open, and otherwise by silent push,
at most once every ten minutes per phone. Only `PUSH_PROVIDER=expo` can send
that push. The map route skips members who have paused, and the member route
asks only a member sharing precisely. These asks come on top of the server's
own ping, which is the phone's heartbeat.

### Crash detection

Crash detection runs only on a drive, and only while a circle the person is
in has _Possible-incident alerts_ on, which the app mirrors into device
storage (`incidentDetection` in `stores/settings.ts`) because the detector runs
where the query cache may be cold. A drive is the one time Hearth runs the GPS
for itself. The detector reads the speed in the fifteen seconds before a jolt,
and a GPS speed is the one that can be believed. The drive's fixes stay on the
phone, feeding the detector (`noteDriveFix` in `driveSpeeds.ts`) and the
incident check, and are never uploaded. A ping during a drive is answered with
the drive's latest fix, so the family sees the car where the GPS has it. The
location indicator shows for the drive, and never at home.

On Android a drive begins from the classifier's in-vehicle transition, inside
the moment Android allows the start: the receiver starts `HearthTrackingService`
in drive mode, with a fix every five seconds and the notification "Crash
detection is on for this drive", and the service opens the headless task the
detector runs in. It ends on an on-foot transition, on a still one that holds
three minutes with no speed seen in them, after ten minutes of the GPS having
the phone standing, or when crash alerts or sharing go off. A ping that finds
the phone moving like a car while the classifier still says vehicle starts it
again. A reboot forgets what the classifier said, and any drive.

iOS has no way to start an app for a drive. A ping, or the heartbeat with the
app open, whose look at the last twenty minutes of Core Motion's history finds
the newest sure record a vehicle under way starts one (`considerDrive`,
`inMovingVehicle` in `motion.ts`): a `High` accuracy location session with no
distance filter,
which is also what keeps the app awake for the sensors, and Core Motion's live
updates (`startMotionWatch`). It ends once Core Motion has had the phone out of
the vehicle for three minutes, at once when it is sure the phone is on foot,
after ten minutes standing, or when crash alerts or sharing go off. So on an
iPhone crash detection starts only once a ping finds the drive, up to an
interval into it, and a drive that ends before the next ping is never seen.

`apps/mobile/modules/hearth-motion`, a local Expo native module written in
Kotlin and Swift, does the sampling. The accelerometer runs fast enough to catch
an impact (20 ms), and the gyroscope and barometer run far slower (100 ms and
200 ms) because rotation and pressure move on human timescales. Samples cross
the bridge batched roughly four times a second rather than one call per sample.

On Android the module registers its `SensorManager` listener from the
application context. expo-sensors drops its listener the moment the Activity
pauses, and a screen going off or a map app on top is the state a phone is in
for most of a drive, so the detector used to run only while somebody was
watching it. Registering from the application context keeps samples arriving
for as long as the process lives, which the drive's service and its headless
task keep it doing.

`app/services/location/driveSensors.ts` receives those batches, assembles the
rolling window, and calls `detectDriveEvent()` in
`packages/shared/src/impact.ts`, which is where the reasoning about what the
sensors can and cannot claim is written down. expo-sensors is the fallback only,
for an install built without the module. It is also the path the
`ACCEL_INTERVAL_MS`, `GYRO_INTERVAL_MS` and `BARO_INTERVAL_MS` constants in
`driveSensors.ts` belong to, since the native sampler sets its own rates.

A verdict does not alert anybody. It goes into a persisted store and the app
asks the person, with a countdown. Answering dismisses it. Silence escalates to
a real SOS, because someone hurt badly enough not to answer is the case the
feature exists for. The store survives a process kill on purpose: the phone that
just took the impact is the one most likely to be restarted by it.

What happens next lives in `app/services/incidentAlarm.ts`, not in the prompt.
`IncidentPrompt` is only mounted while the app is in front, and a phone after a
crash is usually locked, where JavaScript timers stand still. So nothing waits
on a timer. `checkIncident()` reads the store and the wall clock and does what
the incident needs at that moment. It puts the countdown notification up while
the app is not in front, decides once the 60 second countdown is past and the
incident is under five minutes old, retries an alert that found no signal, or
drops one an hour old. It is called from the tracker's `flush()`, which every
delivery, retry and sync pass goes through, with `online: true` from an upload
that got through, and from the prompt's tick and its AppState listener. The
verdict in
`driveSensors.ts` follows the same rule. It is armed with a timer for the
foreground, and any sample past its deadline judges too, since native batches
keep arriving with the screen off.

The alert itself is `raiseSos(circleId, note, "incident")` through a circle
with incident alerts on, from the query cache or from `GET /circles` when the
cache is cold. The server raises it in every circle of the caller that has
them on. Only a network failure, a 5xx, a 429, a firewall's page or a 401 with
tokens still held is retried, spaced 15 s, 30 s, 1 min and then 2 min apart,
and at once after a successful upload. Anything else is a refusal and ends it,
because asking again into a firewall that blocks on a 4xx takes the household
offline. Nothing is sent without a session, and an incident is dropped if a
different account signs in. The module requires the tracker for its fix at
the moment it needs one, rather than importing it, because the tracker imports
the module and a cycle resolved while the app loads can leave one side
undefined.

The notification uses the fixed id `hearth-incident`, the SOS channel (on the
trigger, which is where expo-notifications reads it), interruption level
`timeSensitive` and a category with one action, `incident-ok`. On Android the
action does not open the app. expo-notifications runs the registered
notification task for it, and `NOTIFICATION_WAKE_TASK` in
`services/notifications.ts` passes it to `answerIncidentResponse()` before
anything else. On iOS the action opens the app, because a killed app never
hears a background action. Whatever ends the incident dismisses the
notification.

The server runs its own, unrelated check on the breadcrumbs it receives, and it
needs no sensors and no settings on the phone. It needs fixes close together,
and a drive's own fixes never reach it, so in practice it only sees a phone on
Live, and even a fix a second cannot tell a collision from braking hard. All
it claims is that somebody stopped suddenly after driving fast, and it posts
that to the circle as a prompt.

## Realtime

`app/services/realtime.ts` holds a single websocket while the app is in the
foreground and writes every message straight into the TanStack Query cache.
It disconnects in the background, where push takes over, and reconnects with
back-off. Inactive is not the background, so pulling down Control Centre on
an iPhone leaves the socket open. It pings every 25 s, every 5 s while a Live
page is open, and opens a new socket when one goes 10 s, or 4 s, without a
word, since a half-open socket looks open and carries nothing. Presence from
the socket and from the minute's poll is merged by `recordedAt`
(`utils/presence.ts`), so an answer that lost a race never steps a dot back.
The map and the Live page show a quiet "Reconnecting…" once the socket has
been down for five seconds (`useRealtimeDown`).

Both that socket and the control channel hand every frame to
`app/services/socketAlerts.ts`. On a server whose push provider is `none` or
`webpush`, or where this phone's push setup came back unsupported, it posts a
local notification on the SOS channel for an `sos` frame about somebody else
and for an `event` frame of type `possible_incident`. An SOS rings once per
raiser and `startedAt`, because one press opens an alert in every circle in a
single transaction and they share its start. The notification comes down again
on `sos_resolved` once every alert of that press it heard is resolved, which
only a phone still connected at the time hears. It carries ids only, the same
`data` a push would.

## Structure

```text
app/
  components/   Avatar, GlassPanel, MemberMarker, SosHoldButton, IncidentPrompt, ListRow,
                HearthMap and the rest
  screens/      Server, Login, Register, Permissions, KeepAlive, Map, MemberDetail,
                Live, Places, PlaceEditor, PlaceDetail, Activity, Circle,
                CircleSettings, Invites, Sharing, NotificationPrefs, You, Devices,
                PrivacyData, ChangePassword, MapStyle, TrackerLog, Sos, CheckIn,
                Trips, TripDetail, Admin, CreateCircle, JoinCircle
  navigators/   AppNavigator (auth gate + stack), MainTabNavigator (Map / Places / Activity / You)
  hooks/        queries.ts (TanStack Query), queryKeys.ts, useActiveCircle.ts,
                useLiveness.ts, useMapStyle.ts, useNearby.ts
  services/     api/ (fetch client + typed endpoints), realtime.ts, notifications.ts,
                health.ts, permissions.ts, location/ (tracker.ts, nativeTracker.ts,
                control.ts, motion.ts, driveSensors.ts, log.ts)
  stores/       zustand: auth, settings, tracking, places, incident, nudge, push,
                alert, toast. mmkv (persisted-store adapter), tokenVault (SecureStore)
  theme/        Ignite theming with Hearth's light/dark palettes
  i18n/         en.ts. v1 is English only, and a locale is a file typed as `Translations`
  utils/        activity, geocode, trail, format, storage (MMKV) and the rest
modules/        hearth-motion: the Expo native module behind the motion classifier,
                the batched sensor samples, the power switches and, on Android, the
                push handler, the tracking service, its receivers, the uploader and
                the native queue
```

## Design notes

- Dark-first, warm near-black surfaces so the map and avatars carry the colour.
- One ember gradient reserved for the primary action on each screen.
- Status is communicated by the avatar ring: blue = you, red pulse = SOS,
  dashed amber = approximate, grey = stale.
- Glass panels float over the map, with blur intensity reduced on Android.
- SOS requires a three-second hold with a visible progress ring, never a tap.
- A toast is read out to a screen reader as it appears, since focus never
  reaches it before it goes. It stays up longer the longer it is, at least six
  seconds for an error and at most fifteen, and a tap dismisses it early.
- The header's back arrow and close cross are labelled Back and Close for a
  screen reader.
- Counted strings use i18next's `_one` keys beside the bare key, so one of
  anything never reads "1 members". A time ahead reads "in 3 days". One less
  than five minutes ahead reads "just now", since a phone clock running fast
  stamps fixes that far ahead and the server takes them.

## Testing

```bash
pnpm --filter hearth-mobile compile      # tsc
pnpm --filter hearth-mobile lint
pnpm --filter hearth-mobile test         # jest-expo unit tests
```

Maestro flows (`.maestro/`) aren't included in v1. See the roadmap.
