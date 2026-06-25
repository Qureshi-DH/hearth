# Security policy

Hearth handles about the most sensitive personal data there is. It knows where
people are, all the time. Please report vulnerabilities responsibly.

## Reporting

Email the maintainers (see the repository's GitHub profile) or open a
**private** security advisory on GitHub. Don't file a public issue for anything
exploitable. You should hear back within a few days.

## Scope

Everything under `server/` counts: authentication, authorisation, the privacy
projection in `services/presence.ts`, input validation, injection, and rate
limiting. In `apps/mobile/`, it's token storage, deep-link handling, and
anything else that could leak a position to a party the user didn't choose.
Docker images and compose files too.

Vulnerabilities in third-party services you choose to configure (Expo push,
ntfy, tile hosts) are out of scope, and so is denial of service against your
own instance.

## Design commitments

- Refresh tokens are stored hashed and rotated on every use.
- Passwords are hashed with scrypt (N=2¹⁵) and compared in constant time.
- Every authorisation decision is made against the database per request. Role
  and membership are never trusted from the JWT.
- Location visibility always passes through one projection function, so
  "paused" and "approximate" cannot be bypassed by an alternate endpoint.
- Push payloads never contain coordinates.

## Supported versions

The `main` branch and the latest tagged release.

## Known limitations

These are deliberate, documented and unfixed as of 0.1.3. Each one
was judged not worth the risk of a rushed change before the first release.

**Avatar URLs are capabilities.** `GET /api/v1/media/*` takes no token. The 128
random bits in the object name are the permission, which is what lets an ordinary
image view render a face without sending headers. Somebody who leaves a circle
keeps a working link to a photo they had already loaded, until that photo is
replaced and the old object is deleted. Nothing else is reachable that way, and
the names cannot be guessed or listed.

**The first account on an empty server becomes an administrator.** That is the
zero-config way in, and it is why `ADMIN_EMAIL` and `ADMIN_PASSWORD` are refused
as optional outside development. Do not start a server in `open` registration
mode without them, or the first stranger to find the address owns it.

**A drive past a place can still be recorded as a visit.** When the fixes for a
drive-through arrive as separate uploads, the server cannot know a departure is
coming when the entry lands, so both crossings reach the activity feed. Nobody is
notified: the entry push is held back and cancelled by the departure, so the
phone never buzzes about a visit that did not happen. Closing the rest needs the
entry held in the database until the transit window has passed.

**Your own actions count toward your unread badge.** The badge counts exactly what
the feed shows, and the feed shows your own check-ins and arrivals.

**Sensor sampling on Android depends on the foreground service.** Crash detection
samples at 50 Hz through a native module registered against the application
context, verified running with the app backgrounded. Android restricts continuous
sensors for genuinely idle apps, so the guarantee in practice is the location
foreground service the tracker holds while a journey is under way.

**iOS motion sampling has not been verified on hardware.** The module compiles,
links and installs in a real Xcode build, and the app launches. A simulator has no
accelerometer, gyroscope or barometer, so the sampling itself has only been
measured on Android.
