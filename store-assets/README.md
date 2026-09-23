# Store assets

Everything the App Store and Google Play ask for, and the tools that make it.

```text
app-store/
  screenshots/iphone-6.9-1320x2868/   10 shots, upload in file order
  graphics/icon_1024x1024.png         App Store icon, no alpha
  metadata/en-US/                     one file per listing field
  listing.md                          categories, age rating, App Privacy, review notes
play/
  screenshots/phone-1080x1920/        8 shots, upload in file order
  graphics/feature-graphic_1024x500.png
  graphics/icon_512x512.png
  metadata/en-US/                     title, descriptions, changelogs
  listing.md                          Data safety, content rating, permission declarations
tools/                                seeding, capture and compositing
```

The metadata folders follow the layout fastlane `deliver` and `supply` read,
so they can be uploaded with fastlane later. Nothing here needs it.

The privacy policy and account deletion pages both stores ask for are
`web/privacy.html` and `web/delete-account.html`, linked from the landing
page's footer. Both stores want them at a public URL. The Pages workflow
publishes `web/` to <https://qureshi-dh.github.io/hearth/> on every push to
`main` that changes it, once the repository is public, and
`app-store/metadata/en-US/privacy_url.txt` and `play/listing.md` already point
there.

## Before submitting

- Check that <https://qureshi-dh.github.io/hearth/privacy.html> loads. Pages
  serves nothing while the repository is private.
- Stand up a public HTTPS demo server and seed it. Both reviews need to sign
  in. The steps are in `app-store/listing.md` under App Review.
- For Play, record the background location and foreground service videos
  described in `play/listing.md`.

## Checking

```bash
python3 store-assets/tools/validate.py
```

Checks every image's exact size, that it has no alpha channel where a store
refuses one, file size caps and screenshot counts, then every text field
against its character limit.

## Making the screenshots again

The screenshots are real captures of the Release build in the iOS simulator,
signed in to a local server holding a made-up family. Apple wants iPhone
screenshots to come from the app running on iOS, and Play takes the same
captures on its own canvas.

1. Start a local server on an empty database, on port 4100.
2. Seed the family: `node store-assets/tools/seed-demo.mjs http://127.0.0.1:4100`
3. Tidy what setup leaves in the feed:
   `PGTZ=Asia/Karachi psql <demo db> -f store-assets/tools/tidy-demo.sql`.
   Set `PGTZ` to your own zone, because the script dates the check-in by the
   local clock.
4. Build the app for the simulator in Release, signed ad hoc
   (`CODE_SIGN_IDENTITY="-"`), since a Debug build shows the dev menu and an
   unsigned one can't use the keychain.
5. Set the simulator's language to English (US), its clock to 9:41 with
   `xcrun simctl status_bar booted override --time 9:41 --batteryLevel 100 --cellularBars 4`,
   and sign in as `sarah@hearth.demo` using `tools/flows/connect.yaml` and
   `onboard.yaml` in Maestro.
6. Run `tools/refresh-demo.mjs` so nobody on the map looks stale, then capture
   each screen with `xcrun simctl io booted screenshot` into `tools/raw/`. For
   the Live shot, start `tools/drive-live.mjs` first, then open Live on David.
7. Composite: `node store-assets/tools/compose.mjs`. It writes both stores'
   screenshots, the feature graphic and the icons.
8. Run `validate.py`.

`compose.mjs` holds the headlines and captions for each shot in `SHOTS`. To
change the words, edit them there and run step 7 again. No new captures
needed.

The pictures in the repository README come from the same captures:
`node store-assets/tools/readme-images.mjs` writes them to `.github/assets/`.

Compositing uses headless Google Chrome for the layout and Pillow to flatten to
RGB. The font is Space Grotesk from the app's own dependencies, so run
`pnpm install` at the repo root first.
