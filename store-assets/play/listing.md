# Google Play Console

Everything Play Console asks for that isn't an image. The listing text is in
`metadata/en-US/`, in the layout fastlane `supply` reads.

## Main store listing

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| App name          | `metadata/en-US/title.txt`                         |
| Short description | `metadata/en-US/short_description.txt`             |
| Full description  | `metadata/en-US/full_description.txt`              |
| App icon          | `graphics/icon_512x512.png`                        |
| Feature graphic   | `graphics/feature-graphic_1024x500.png`            |
| Phone screenshots | `screenshots/phone-1080x1920/`, all eight          |
| Category          | Lifestyle                                          |
| Tags              | Family safety, Location sharing, Privacy           |
| Email             | a contact address you are happy to publish         |
| Website           | `https://github.com/Qureshi-DH/hearth`             |
| Privacy policy    | `https://qureshi-dh.github.io/hearth/privacy.html` |

Tablet screenshots are optional. Leave them out.

## App content

### Privacy policy

`https://qureshi-dh.github.io/hearth/privacy.html`, from `web/privacy.html`.

### App access

All functionality is behind a sign-in. Add instructions:

- Name: Demo family
- Username: `sarah@hearth.demo`
- Password: the `PASSWORD` in `tools/seed-demo.mjs`
- Other information:

  > Hearth is self-hosted. On the first screen enter the server address
  > `https://demo.<your domain>`, then sign in with the account above.

This needs the same public demo server as App Review. See
`../app-store/listing.md`.

### Ads

No, the app contains no ads.

### Content rating

Fill in the IARC questionnaire with category "All other app types".

- Violence, sexuality, language, drugs, gambling: No to all.
- Does the app let users interact or exchange content: Yes. Users share their
  location with people they choose, and send check-ins and fixed quick
  messages.
- Does the app share the user's current physical location with other users:
  Yes.
- Digital purchases: No.

Expect Everyone or PEGI 3, with "Users Interact" and "Shares Location".

### Target audience

18 and over. The app is set up and run by adults. Children can be members of
a family's circle, but choosing an under-13 age group puts the app under the
Families policy, which a background location app doesn't fit. If Google asks
whether the app appeals to children, answer no: the listing and screenshots
are aimed at parents.

### Data safety

Play counts data as collected when it leaves the device, and a reviewer
compares the form to the permissions. An app holding background location that
declares no location data gets flagged. So declare what the app sends to the
user's server, and say it isn't shared.

- Does your app collect or share any of the required user data types: Yes.
- Is all user data encrypted in transit: Yes. Store builds refuse plain HTTP
  (`usesCleartextTraffic` is false), except to a server on the local network.
- Do you provide a way for users to request that their data is deleted: Yes.
  Deletion URL: `https://qureshi-dh.github.io/hearth/delete-account.html`.

| Data type                                  | Collected | Shared | Optional | Purposes                              |
| ------------------------------------------ | --------- | ------ | -------- | ------------------------------------- |
| Location, Precise location                 | Yes       | No     | No       | App functionality                     |
| Location, Approximate location             | Yes       | No     | No       | App functionality                     |
| Personal info, Name                        | Yes       | No     | No       | App functionality, Account management |
| Personal info, Email address               | Yes       | No     | No       | Account management                    |
| Photos and videos, Photos                  | Yes       | No     | Yes      | App functionality                     |
| Messages, Other in-app messages            | Yes       | No     | Yes      | App functionality                     |
| App activity, Other user-generated content | Yes       | No     | Yes      | App functionality                     |
| Device or other IDs                        | Yes       | No     | No       | App functionality                     |

Processed ephemerally: No for all of them, since the server stores them.

"Shared" means handed to a third party. Expo and Google deliver notifications
as service providers, which Play explicitly excludes from sharing.

### Account deletion

Play requires both an in-app path and a web page. The app has You, Privacy &
data, Delete my account. The web page is `web/delete-account.html`.

### Government, financial, health, news apps

No to each.

## Sensitive permissions

Each of these has its own declaration form under App content. Google wants a
short video for the first two. Record them on a real phone with the store
build, under 30 seconds each, and upload to YouTube as unlisted.

### Location in the background (`ACCESS_BACKGROUND_LOCATION`)

- Feature: family location sharing. Members of a circle see each other on a
  map, get arrival and departure alerts at named places, and get SOS and crash
  alerts, with the app closed.
- Why it needs background access: the whole point is that the family can see
  you when you are not using the app. Arrival alerts and crash detection only
  work if the app knows where you are while it's closed.
- Video: sign in, the prominent disclosure screen in onboarding, the system
  prompt with "Allow all the time", then the map with a family member moving
  while the phone's home screen is showing.

The prominent disclosure must appear before the system prompt and name
background use. Onboarding's location step does, but its text today says
"Always", which is the iPhone word. Google's reviewers look for their own
pattern, "Hearth collects location data to enable family location sharing,
arrival alerts and crash detection even when the app is closed or not in
use", and "Allow all the time" on Android. Change `onboarding` in
`apps/mobile/app/i18n/en.ts` to that on Android before recording.

### Foreground service, location (`FOREGROUND_SERVICE_LOCATION`)

- Task: continuous location for a user-started family sharing session, which
  the user can stop at any time from You, Location sharing.
- Video: turn sharing on, lock the phone, show a family member's view updating.

### Battery optimisation exemption (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`)

Play allows this only when the app's core function breaks without it. Family
location, SOS and crash alerts stop on many Android phones once Doze and the
vendor's battery manager kick in. There is no form for it, but a reviewer can
ask. If Play rejects it, the app still works through the settings screen
it links to, and the permission can be dropped.

### Physical activity (`ACTIVITY_RECOGNITION`)

A runtime permission, no declaration. The purpose shows on the setup
checklist before the system prompt.

## Release

Upload the AAB to an internal test track first. Play has to process the
permission declarations before a production release, and that can take a few
days. The release notes are in `metadata/en-US/changelogs/default.txt`.
