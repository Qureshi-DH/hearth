---
sidebar_position: 1
title: Self-hosting
---

Hearth runs as three containers behind any reverse proxy that can terminate
TLS: the API, Postgres, and MinIO for profile pictures. A Raspberry Pi 4 or the
smallest VPS you can rent is plenty for a family.

## Requirements

- Docker Engine 24+ with Compose v2 (`docker compose version`)
- A domain (or subdomain) pointing at the host, e.g. `hearth.example.com`
- Ports 80/443 reachable, for the reverse proxy

Location updates are small, a few hundred bytes every 30 to 60 seconds per
phone, so bandwidth won't be what runs out. Disk might. Measured over 200,000
rows, a stored fix costs about 340 bytes with indexes. At one fix a minute that
comes to roughly 14 MB per phone at the default 30 day retention, or 170 MB a
year if you switch retention off entirely.

## 1. Configure

The server is published as a Docker image, `dhqureshi/hearth-api`, built for
amd64 and arm64. You do not need the repository to run Hearth. Make a folder,
put this in `docker-compose.yml`, and put a `.env` beside it:

```yaml
name: hearth

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: hearth
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: hearth
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hearth -d hearth"]
      interval: 10s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY}
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 12

  api:
    image: dhqureshi/hearth-api:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
      minio:
        condition: service_healthy
    env_file: [.env]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://hearth:${POSTGRES_PASSWORD}@db:5432/hearth
      S3_ENDPOINT: http://minio:9000
    ports:
      - "4000:4000"

volumes:
  postgres-data:
  minio-data:
```

The `.env` needs at least these. Compose reads it twice: once to substitute the
variables above, and once to hand the whole file to the API.

```bash
JWT_SECRET=                                # openssl rand -base64 48, paste the output
PUBLIC_URL=https://hearth.example.com      # where phones will reach you
POSTGRES_PASSWORD=some-long-random-string
ADMIN_EMAIL=you@example.com                # required, your account
ADMIN_PASSWORD=a-long-passphrase           # required, at least 10 characters
ADMIN_NAME=Your Name                       # optional, defaults to the part before the @
S3_ACCESS_KEY_ID=hearth                    # MinIO, for profile pictures
S3_SECRET_ACCESS_KEY=another-long-random-string
```

`.env.example` in the repository lists every remaining variable with its
default, and none of them have to be set to boot.

The server refuses to start in production without `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. That account is created once, while the database still has no
users, and it is the only way in. Registration has no exemption for the first
account, so a server you have not signed into yet cannot be claimed by whoever
finds the URL first.

Editing `ADMIN_PASSWORD` later does nothing, because the bootstrap only runs
against an empty user table. Change the password from the app.

Leave `REGISTRATION_MODE=invite` (the default) unless you want anyone who finds
the URL to be able to sign up. Everyone else joins with an invite you send them.
An admin can change this later from the app without a redeploy, under
_You → Server admin → Who can sign up_.

### Building from the repository instead

If you want to change the code, clone it and let Compose build the image:

```bash
git clone https://github.com/Qureshi-DH/hearth.git
cd hearth
cp .env.example .env
```

The `docker-compose.yml` in the repository is the same stack with `build:` in
place of the published image, so `docker compose up -d --build` compiles the
server from your working tree.

## 2. Start

```bash
docker compose up -d
docker compose logs -f api
```

The API applies database migrations on boot and logs `Hearth is listening`.
`curl http://localhost:4000/readyz` should come back with `{"ok":true}`.

Interactive API docs are served at `/docs` (disable with `ENABLE_SWAGGER=false`).

## 3. Put TLS in front

If you do not have a domain yet, or you would rather not expose anything to the
internet, [remote access](remote-access.md) compares the ways to reach the
server from outside and explains why the usual VPN-first advice fits a location
app badly.

Both platforms refuse plain HTTP for background traffic, so a TLS-terminating
proxy is required, not optional.

### Caddy (simplest)

```caddyfile
hearth.example.com {
    reverse_proxy localhost:4000
}
```

Caddy gets and renews the certificate on its own and proxies websockets with no
extra configuration.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name hearth.example.com;
    ssl_certificate     /etc/letsencrypt/live/hearth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hearth.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # websocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Set `TRUST_PROXY=true` in `.env` only once a proxy really is in front. While it
is on, Hearth believes the `X-Forwarded-For` header, so anything that can reach
the API directly can forge its own address and walk past the per-IP rate limit.
Leave it `false` for a direct LAN deployment.

### Traefik

Add the usual router labels to the `api` service. Websockets work out of the box.

```yaml
labels:
  - "traefik.http.routers.hearth.rule=Host(`hearth.example.com`)"
  - "traefik.http.services.hearth.loadbalancer.server.port=4000"
```

## 4. Connect a phone

Install the Hearth app (see [the mobile app page](../developer/mobile.md) for building it), enter
`https://hearth.example.com`, sign in as the admin account you configured,
create a circle, and share the invite code or QR with the family.

## Optional pieces

### Push notifications

Read [push notifications](push-notifications.md). For the fully self-hosted
route, take the `docker-compose.ntfy.yml` overlay from the repository and run:

```bash
docker compose -f docker-compose.yml -f docker-compose.ntfy.yml up -d
```

then set `PUSH_PROVIDER=ntfy` and `NTFY_BASE_URL=https://ntfy.example.com`, a
second hostname on your proxy pointed at port `8093`.

### Profile pictures

The compose stack runs MinIO for these. It is the only thing Hearth stores as a
file, and the bucket is created on the first upload, so there is nothing to set
up beyond the keys in `.env`:

```bash
S3_ACCESS_KEY_ID=hearth
S3_SECRET_ACCESS_KEY=a-long-random-string
```

The bucket is never exposed. Images are streamed back through the API, so you
secure one hostname rather than two, and object keys are random, which is what
makes a picture unguessable rather than any access control.

Any S3 compatible storage works instead. Point `S3_ENDPOINT` at it, set
`S3_REGION`, and turn off `S3_FORCE_PATH_STYLE` if the provider serves buckets
as subdomains. Leave `S3_ENDPOINT` empty and uploads switch off entirely, with
avatars falling back to initials on a colour. The app hides the upload button
when the server reports no storage, so this degrades quietly.

The app resizes to 512 pixels before uploading, which re-encodes the file and
so strips the EXIF. That matters more here than in most apps: a phone photo
usually records where it was taken.

Whatever you point it at, it needs backing up separately. See below.

### Map tiles

By default the app loads a MapLibre style from OpenFreeMap. No key, no tracking,
community-run. To be fully independent, host your own tiles with
[Martin](https://martin.maplibre.org/) or [TileServer GL](https://github.com/maptiler/tileserver-gl)
and point `MAP_STYLE_URL` at your style JSON, plus `MAP_STYLE_URL_DARK` for the
app's dark theme and `MAP_ATTRIBUTION` for the credit line. The app reads all
three from `/api/v1/server-info` on launch, so nothing has to be rebuilt.

### Several API replicas

Redis carries realtime events between replicas. Its overlay lives in the
repository as `docker-compose.redis.yml`.

```bash
docker compose -f docker-compose.yml -f docker-compose.redis.yml up -d --scale api=3
```

Drop the `ports:` mapping from the `api` service before you scale it, or the
second replica fails to start because host port 4000 is already taken, and
point your reverse proxy at the service instead. One replica is plenty for a
household several times over, so most installs never need any of this.

## Operations

### Backups

There are two stores, and a Postgres dump alone is not a complete backup.

Postgres holds accounts, circles, positions, places, trips, messages and the
activity feed:

```bash
docker compose exec -T db pg_dump -U hearth hearth | gzip > hearth-$(date +%F).sql.gz
```

MinIO holds the profile pictures. They are files rather than rows, so `pg_dump`
never sees them, and a restore from the dump alone leaves every avatar as a
broken link. Copy the volume too:

```bash
docker run --rm -v hearth_minio-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/hearth-avatars-$(date +%F).tar.gz -C /data .
```

`hearth_minio-data` is the compose project name joined to the volume name, so
it matches the file above. Objects are written once under a random key and never
rewritten, so the copy does not need the stack stopped. If you pointed `S3_ENDPOINT` at storage you
run elsewhere, back it up there instead and skip this step.

Restoring both into a fresh stack:

```bash
gunzip -c hearth-2026-09-07.sql.gz | docker compose exec -T db psql -U hearth hearth
docker run --rm -v hearth_minio-data:/data -v "$PWD:/backup" alpine \
  tar xzf /backup/hearth-avatars-2026-09-07.tar.gz -C /data
```

### Upgrades

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on boot. Downgrades aren't supported, so if an
upgrade goes badly, restore a backup. Pin a tag instead of `latest` if you would
rather choose your moment.

Working from a clone, where Compose builds the image rather than pulling it,
that becomes `git pull && docker compose up -d --build`.

### Data retention

Breadcrumb history is pruned by a background job, which runs every
`JOB_INTERVAL_SECONDS` (60 by default). Each circle sets its own window, 30 days
out of the box, and a user's breadcrumbs live as long as the most generous
circle they belong to asks for. Set a circle's retention to 0 and only the live
position is kept. Trips survive pruning as aggregates: distance, duration,
endpoints.

A server-wide ceiling applies on top of whatever the circles ask for.
`MAX_HISTORY_RETENTION_DAYS` (90 by default) sets the ceiling the server boots
with, and an admin can change it from the app under _You → Server admin →
History retention_. The value stored there overrides the environment variable
from that point on, in both directions: the app can raise the ceiling as well as
lower it, and the next sweep uses the new number without a redeploy. Clear the
field in the app and the environment value is back in charge.

One wrinkle worth knowing before you touch anything on that screen: saving any
server setting writes the whole set, so renaming the server also stores whatever
ceiling was in force at that moment. From then on, editing
`MAX_HISTORY_RETENTION_DAYS` in `.env` changes nothing until you clear the field
in the app.

### Health

- `GET /healthz` says the process is up
- `GET /readyz` says the database is reachable, and it's the one to point your
  proxy and uptime checks at
- `GET /api/v1/admin/stats` (admin token) returns users, points, queue depth and
  DB size

### Logs

JSON lines on stdout. `LOG_LEVEL=debug` when something is wrong. Authorization
headers and passwords are redacted before they reach the log.

## Security notes

The server never stores plaintext refresh tokens. They're SHA-256 at rest and
rotate on every use, and a replayed token is rejected.

Passwords are hashed with scrypt (N=2¹⁵) using Node's built-in implementation.
That means no native build step, which is why the image builds on ARM boards
without a compiler.

Rate limits are per account, falling back to per IP, so one chatty phone on a
home NAT doesn't throttle the whole household.

All tables cascade from `users` and `circles`. Deleting an account deletes every
breadcrumb, place, alert and notification tied to it. The one thing that outlives
it is the profile picture in the bucket, which the cascade cannot reach. Nothing
links to it any more and its key is random, so it is unreachable rather than
exposed, but an operator who wants it gone has to remove the object.

`CORS_ORIGINS` is empty by default, which grants no cross-origin access at all.
Native apps don't send an `Origin` header and don't need one. Add your web
client's origin there the moment you have a web client. Authentication is a
bearer token and never a cookie, so credentialed cross-origin requests never
come into it.

## Running without Docker

```bash
pnpm install
cp .env.example server/.env            # or export the variables
pnpm --filter @hearth/server build
DATABASE_URL=postgres://... JWT_SECRET=... pnpm --filter @hearth/server start
```

You'll need Node 20.10+ and Postgres 14+. Object storage is optional: leave
`S3_ENDPOINT` unset and profile pictures are simply switched off.
