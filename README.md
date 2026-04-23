<h1 align="center">Hearth</h1>

<p align="center">
  Family location sharing you host yourself.<br>
  A family safety app where the map, the history and the alerts live on your server.
</p>

<p align="center">
  <a href="#status"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange"></a>
  <a href="LICENSE"><img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/your-org/hearth/ci.yml?branch=main"></a>
  <img alt="Expo SDK 55" src="https://img.shields.io/badge/Expo-SDK%2055-000020?logo=expo">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520.10-5FA04E?logo=node.js&logoColor=white">
  <img alt="Postgres 14+" src="https://img.shields.io/badge/postgres-%E2%89%A514-336791?logo=postgresql&logoColor=white">
</p>

---

Commercial family trackers work well and cost you the thing you were trying to
protect. Every position, every arrival, every drive ends up on somebody else's
servers, under a privacy policy that can change next quarter.

Hearth does the same job on hardware you control. It's two pieces: an API server
that runs in Docker next to Postgres, and an iOS and Android app that talks only
to it.

## Status

Alpha. The features below are built and tested, and I run it for my own family.
It has not been through a security audit, the Android build has had less real
device testing than iOS, and the app is not on either store yet, so you build it
yourself. Read [SECURITY.md](SECURITY.md) before pointing it at the internet.

## What it does

**See where everyone is.** A live map of your circle with battery level, whether
they're walking or driving, and how long ago each position came in. Updates
arrive over a websocket while the app is open and by push when it isn't.

**Places.** Draw a circle around home, school or work and the whole family gets
told when somebody arrives or leaves. Leaving needs a bit more distance than
arriving, so a phone sitting on the boundary doesn't spam everyone.

**Privacy that actually means something.** Per circle, you choose precise,
approximate or paused. Approximate snaps you to a 750 metre grid and hides your
trail, your trips and which place you're at. Paused shares nothing at all. The
choice is yours, per circle, and everyone can see which mode you picked.

**Safety.** Hold the SOS button for three seconds and everyone gets a
high-priority alert with your live position, updated every twenty seconds until
you clear it. SOS overrides a paused sharing state, because an emergency isn't
the moment to respect ghost mode. There's also a one-tap check-in, and you can
ask somebody's phone for a fresh fix.

**Messages.** A short thread per circle with one-tap replies like "Please slow
down" and "On my way". It's there so the alerts have an obvious answer, not to
replace your group chat.

**Driving alerts, if you want them.** Off by default. Turn on a speed threshold
and the circle hears about it. Turn on incident alerts and a hard stop from
driving speed raises a check-on-them notification.

**Trips and history.** Journeys are worked out from breadcrumbs on the server:
distance, duration, top speed, and where they started and ended. History is kept
for as long as each circle asks for and then deleted, with a server-wide cap on
top.

**Your data stays yours.** Export everything as JSON, wipe your history, or
delete your account and watch it cascade through every table.

## Try it

You need Docker and about five minutes.

```bash
git clone https://github.com/your-org/hearth.git
cd hearth
cp .env.example .env
```

Open `.env` and set two things:

```bash
JWT_SECRET=$(openssl rand -base64 48)   # paste the output
PUBLIC_URL=https://hearth.example.com   # where phones will reach you
```

Then:

```bash
docker compose up -d
curl localhost:4000/readyz     # {"ok":true}
open http://localhost:4000/docs
```

The first account you create becomes the server administrator. After that,
registration is invite only unless you change it.

Phones won't talk to a plain HTTP server in the background, so put a TLS proxy
in front before you invite anyone. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)
has Caddy and nginx configs you can paste.

## Build the app

There's no App Store build yet. The app uses native modules for maps and
background location, so Expo Go won't run it and you need a development build.

```bash
pnpm install
cd apps/mobile
npx expo prebuild
npx expo run:ios        # or run:android
```

Enter your server's address on first launch. In a development build the field is
pre-filled with whichever machine is running Metro.

## Develop

```bash
pnpm install
createdb hearth_dev
cp .env.example .env          # set DATABASE_URL and JWT_SECRET

pnpm dev                      # API on :4000 with hot reload
pnpm seed                     # a demo family with places, trips and history
pnpm dev:mobile               # Expo
```

`pnpm seed` prints four demo accounts and the password they share. One of them
shares approximately, so you can see what the fuzzing looks like.

Before you push:

```bash
pnpm verify   # format, lint, typecheck, test
```

Server tests run against a real Postgres and truncate between specs. Mocking the
database would test almost nothing, since a good deal of the interesting
behaviour is in SQL.

```bash
createdb hearth_test
TEST_DATABASE_URL=postgres://localhost:5432/hearth_test pnpm test
```

## How it's put together

```text
server/            Fastify 5, Drizzle, Postgres. The whole API.
apps/mobile/       Expo SDK 55, React Native, based on Ignite.
packages/shared/   Types, constants and geo maths. No runtime dependencies.
docs/              Everything below.
.claude/skills/    Conventions, for humans and agents alike.
```

`packages/shared` is consumed as TypeScript source by both sides, so if a
response shape changes, both fail to typecheck until they agree.

## Documentation

|                                                  |                                                    |
| ------------------------------------------------ | -------------------------------------------------- |
| [Self-hosting](docs/SELF-HOSTING.md)             | Deploy, TLS, backups, upgrades, scaling            |
| [Push notifications](docs/PUSH-NOTIFICATIONS.md) | Every option for self-hosters, with the tradeoffs  |
| [Architecture](docs/ARCHITECTURE.md)             | Data model, location pipeline, realtime, jobs      |
| [API](docs/API.md)                               | REST and websocket reference                       |
| [Mobile](docs/MOBILE.md)                         | Building the app, permissions, background location |
| [Privacy](docs/PRIVACY.md)                       | What's stored, for how long, who can see it        |
| [Roadmap](docs/ROADMAP.md)                       | What's next                                        |
| [Contributing](CONTRIBUTING.md)                  | Setup and conventions                              |

## Push notifications, briefly

Waking a sleeping phone is the one part of this that a self-hoster can't fully
own, because that last hop belongs to Apple and Google. Hearth gives you four
options and defaults to the one that needs no configuration:

| Provider         | Third party?        | Works on                            | Effort |
| ---------------- | ------------------- | ----------------------------------- | ------ |
| `none` (default) | No                  | Both, while the app is open         | None   |
| `ntfy`           | No, you host it     | Android fully, iOS via the ntfy app | Low    |
| `expo`           | Yes, Expo relays it | Both                                | Low    |
| `webpush`        | Browser vendor      | Browsers, UnifiedPush               | Medium |

Notification payloads carry names and identifiers, never coordinates. The app
fetches the position from your server when you tap.
[docs/PUSH-NOTIFICATIONS.md](docs/PUSH-NOTIFICATIONS.md) goes through each one
properly.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup and the handful of conventions that matter, mostly around privacy and the
database.

If you find a security problem, please report it privately. See
[SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). Run it, change it, share it. If you offer it to other
people as a service, share your changes too.
