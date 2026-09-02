# App Store Connect

Everything App Store Connect asks for that isn't an image. The listing text
itself is in `metadata/en-US/`, one file per field, in the layout fastlane
`deliver` reads.

## App information

| Field              | Value                                  |
| ------------------ | -------------------------------------- |
| Name               | `metadata/en-US/name.txt`              |
| Subtitle           | `metadata/en-US/subtitle.txt`          |
| Bundle ID          | `com.binary.rewind.hearth`             |
| Primary category   | Social Networking                      |
| Secondary category | Navigation                             |
| Content rights     | Does not contain third-party content   |
| Privacy policy URL | `metadata/en-US/privacy_url.txt`       |
| Support URL        | `metadata/en-US/support_url.txt`       |
| Marketing URL      | `metadata/en-US/marketing_url.txt`     |
| Copyright          | 2026 Daniyal Hassan                    |
| Price              | Free, no in-app purchases              |
| Devices            | iPhone only. `supportsTablet` is false |

The biggest family safety apps list in Social Networking, and that is
where parents browse for this kind of app, so Hearth sits beside them. The name
leads with "Private Family Safety" because "family safety" is what people
search for, and "private" is the difference. Listing copy never calls Hearth a
tracker. "tracker" stays in the hidden keywords only, because people search
for it.

"Hearth" alone is likely taken, which is why the name carries more. If Apple
rejects it, "Hearth Family Safety" is 20 characters.

## Age rating

Answer None or No to every content question. The two that need a thought:

- Unrestricted web access: No. The app opens no browser of its own.
- User-generated content, messaging: the only messages are check-ins and a fixed
  set of quick messages, sent to people the user already added to a circle.
  There is no free text chat, no public profiles and no way to reach a
  stranger. Answer No.

That lands on 4+.

## App Privacy

The label describes what the developer and its partners collect. Everything
the app sends goes to a server the user or their family runs, which the
developer has no access to. Apple's definition of collecting is transmitting
off the device in a way the developer or its partners can access, so the
account, location, photos and history are not collected by us.

The exception is notifications. Store builds deliver through Expo's push
service, which is our service provider. It receives the device push token and
the notification's names and short text, briefly, to deliver it. So declare:

| Data type              | Used for          | Linked to user | Tracking |
| ---------------------- | ----------------- | -------------- | -------- |
| Identifiers, Device ID | App Functionality | No             | No       |

Everything else: not collected. If a later build drops the Expo relay for
Apple's push service directly, the label can become "Data Not Collected".

## Export compliance

`ITSAppUsesNonExemptEncryption` is false in `app.json`. The app uses only the
HTTPS the system provides, which is exempt. No documentation to upload.

## App Review

Review needs a working server. The app can't be tried without one, and a
reviewer who can't sign in rejects under guideline 2.1.

1. Run a Hearth server on a public HTTPS address, for example
   `https://demo.<your domain>`.
2. Seed it with `node store-assets/tools/seed-demo.mjs https://demo.<your domain>`.
   That creates the five-person family from the screenshots.
3. Under App Review Information, sign-in required: yes.
   - Username: `sarah@hearth.demo`
   - Password: the `PASSWORD` in `tools/seed-demo.mjs`
4. Paste this into Notes:

   > Hearth is a self-hosted family locator. Each family runs its own Hearth
   > server, and the app connects to it. On the first screen, enter the server
   > address `https://demo.<your domain>`, then sign in with the account above.
   > That account belongs to a demo family with sample history. Location is
   > collected in the background so family members can see each other with the
   > app closed, which is the app's main purpose. The user can pause or reduce
   > sharing at any time under You, Location sharing. Account deletion is in
   > You, Privacy & data, Delete my account.

5. Keep the server running until the review is done, and run
   `tools/refresh-demo.mjs` the day before submitting so nobody on the map
   looks stale.

Guideline 5.1.5 asks that background location has a clear reason in the
purpose strings. The strings in `app.json` already say why. The review note
repeats it.

## Screenshots

`screenshots/iphone-6.9-1320x2868/`, all ten, in file order. Apple scales the
6.9 inch set down for every smaller iPhone, so no other size is needed.

## Version release notes

Not asked for on a first version. For later ones, write them in
`metadata/en-US/release_notes.txt`, 4000 characters at most.
