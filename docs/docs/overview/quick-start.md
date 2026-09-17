---
sidebar_position: 2
title: Quick start
---

This is the shortest path from nothing to a Hearth server running on your own
machine with one phone reporting to it. Everything stays on your network, so
plain HTTP is fine for this first look.

It is not a deployment. Before you invite the rest of the family you need TLS,
which is [step 6](#6-before-you-invite-anyone) and a link to a longer page.

## What you need

- Docker Engine 24+ with Compose v2 (`docker compose version`)
- Node 20.18+ and pnpm 9+, to build the app
- Xcode (iOS) or Android Studio (Android). There is no App Store or Play build
  yet, so you compile the app yourself
- A phone or simulator on the same network as the server

## 1. Get the code

```bash
git clone https://github.com/Qureshi-DH/hearth.git
cd hearth
cp .env.example .env
```

The server is also published as `dhqureshi/hearth-api`, so a real deployment
never needs a clone. See [self-hosting](../install/self-hosting.md) for that
compose file. You need the repository here anyway, because the app is built
from source.

## 2. Fill in .env

Six values. The rest of the file has defaults that boot.

```bash
JWT_SECRET=            # openssl rand -base64 48, then paste the output
PUBLIC_URL=http://192.168.1.10:4000   # the address phones will type
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=a-long-passphrase      # at least 10 characters
POSTGRES_PASSWORD=     # openssl rand -hex 24
S3_SECRET_ACCESS_KEY=  # openssl rand -hex 24
```

Compose refuses to start until `POSTGRES_PASSWORD` and `S3_SECRET_ACCESS_KEY`
are set, and tells you which one is missing. There is no shared default
database password to forget about later.

Compose runs the API with `NODE_ENV=production`, so the server also refuses to
boot without a `JWT_SECRET` of at least 32 characters and both admin values.

That admin account is created once, while the database still has no users, and
it is the only way in: registration never lets an account through without an
invite, so a server you have not signed into yet cannot be claimed by whoever
finds the URL. Editing `ADMIN_PASSWORD` afterwards does nothing, because the
bootstrap only runs against an empty user table. Change the password from the
app.

`PUBLIC_URL` is what Hearth puts in invite links and push payloads, so point it
at the address the phones will really use. Your machine's LAN address comes from
`ipconfig getifaddr en0` on macOS or `hostname -I` on Linux.

## 3. Start the server

```bash
docker compose up -d
docker compose logs -f api
```

The first run builds the image from your clone, which takes a few minutes.
After that the log says `Hearth is listening`, and:

```bash
curl http://localhost:4000/readyz     # {"ok":true}
```

`/readyz` checks the database, `/healthz` only says the process is up. The
interactive API reference is at `http://localhost:4000/docs`.

The host port comes from `HEARTH_PORT`, which is 4000 unless you change it.

## 4. Build the app

The app uses native modules for maps and background location, so Expo Go cannot
run it. You need a development build.

```bash
pnpm install
cd apps/mobile
npx expo prebuild
npx expo run:ios        # or run:android
```

A debug build reaches a LAN server over plain HTTP, which is what makes this
local try possible. Release builds do not: Android refuses cleartext outright and iOS
allows it only to private network addresses. [Mobile](../developer/mobile.md)
has the full table and the build details.

## 5. Connect the phone

1. The first screen asks for a server address. Type
   `http://192.168.1.10:4000`, with the scheme, so it does not try HTTPS first.
   In a development build the field is already filled in with whichever machine
   is running Metro, which is usually the right answer.
2. Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set.
3. Grant location access. Choose "Always" when the phone offers it, otherwise
   your position stops updating the moment Hearth leaves the screen, and allow
   notifications so alerts arrive.
4. Create a circle. Hearth gives you an 8 character invite code and a QR code,
   which is how everyone else joins.

You should now see yourself on the map. With the app open, updates arrive over
a websocket. Waking a closed app needs push, which is off by default and covered
in [push notifications](../install/push-notifications.md).

## 6. Before you invite anyone

Phones will not talk to a plain HTTP server in the background, so the LAN setup
above stops here. Put a TLS-terminating proxy in front before anyone else joins.

- [Remote access](../install/remote-access.md) compares the ways to reach your
  server from outside the house, and explains why the usual VPN-first advice
  fits a location app badly.
- [Self-hosting](../install/self-hosting.md) has Caddy, nginx and Traefik
  configurations to paste, plus backups, upgrades and retention.

When TLS is in front, set `PUBLIC_URL` to the `https://` address, set
`TRUST_PROXY=true` (only once a proxy really is in front of the API), and
`docker compose up -d` again.

## When it does not work

**Compose stops with a message naming `POSTGRES_PASSWORD` or
`S3_SECRET_ACCESS_KEY`.** Those two have no default. Set them in `.env`.

**The `api` container exits straight away.** Run `docker compose logs api`. A
bad configuration is printed as `Invalid configuration:` followed by the exact
variable, and the checks above for `JWT_SECRET` and the admin pair print their
own message.

**`/readyz` returns 503.** The API is up but Postgres is not reachable. Check
`docker compose logs db`.

**The phone says it could not reach a server at that address.** Confirm both
devices are on the same network, that you used the machine's LAN address rather
than `localhost`, and that the host firewall allows the port.

**You want to start over.** `docker compose down -v` deletes the volumes, which
includes the admin user, so the next boot bootstraps it again from `.env`.
