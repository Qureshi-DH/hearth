# Self-hosting Hearth

Hearth runs as two containers, the API and Postgres, behind any reverse proxy
that can terminate TLS. A Raspberry Pi 4 or the smallest VPS you can rent is
plenty for a family.

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

```bash
git clone https://github.com/your-org/hearth.git
cd hearth
cp .env.example .env
```

Edit `.env` and set at least:

```bash
JWT_SECRET=$(openssl rand -base64 48)      # paste the output
PUBLIC_URL=https://hearth.example.com
POSTGRES_PASSWORD=some-long-random-string
ADMIN_EMAIL=you@example.com                # optional bootstrap admin
ADMIN_PASSWORD=a-long-passphrase
```

Leave `REGISTRATION_MODE=invite` (the default) unless you want anyone who finds
the URL to be able to sign up. Whatever the mode, the first account ever created
becomes the server administrator, so create yours before you hand the URL to
anyone else.

## 2. Start

```bash
docker compose up -d
docker compose logs -f api
```

The API applies database migrations on boot and logs `Hearth is listening`.
`curl http://localhost:4000/readyz` should come back with `{"ok":true}`.

Interactive API docs are served at `/docs` (disable with `ENABLE_SWAGGER=false`).

## 3. Put TLS in front

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

Install the Hearth app (see [MOBILE.md](MOBILE.md) for building it), enter
`https://hearth.example.com`, create your account, create a circle, and share
the invite code or QR with the family.

## Optional pieces

### Push notifications

Read [PUSH-NOTIFICATIONS.md](PUSH-NOTIFICATIONS.md). For the fully self-hosted
route:

```bash
docker compose -f docker-compose.yml -f docker-compose.ntfy.yml up -d
```

then set `PUSH_PROVIDER=ntfy` and `NTFY_BASE_URL=https://ntfy.example.com`, a
second hostname on your proxy pointed at port `8093`.

### Map tiles

By default the app loads a MapLibre style from OpenFreeMap. No key, no tracking,
community-run. To be fully independent, host your own tiles with
[Martin](https://martin.maplibre.org/) or [TileServer GL](https://github.com/maptiler/tileserver-gl)
and point `MAP_STYLE_URL` at your style JSON. The app reads it from
`/api/v1/server-info` on launch, so nothing has to be rebuilt.

### Several API replicas

```bash
docker compose -f docker-compose.yml -f docker-compose.redis.yml up -d --scale api=3
```

Redis carries realtime events between replicas. One replica is plenty for a
household several times over, so most installs never need this.

## Operations

### Backups

Everything lives in Postgres.

```bash
docker compose exec -T db pg_dump -U hearth hearth | gzip > hearth-$(date +%F).sql.gz
```

Restore into a fresh stack with `gunzip -c file.sql.gz | docker compose exec -T db psql -U hearth hearth`.

### Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run automatically. Downgrades aren't supported, so if an upgrade goes
badly, restore a backup.

### Data retention

Breadcrumb history is pruned every minute by a background job. Each circle sets
its own window (default 30 days), and `MAX_HISTORY_RETENTION_DAYS` caps all of
them at 90 by default. Set a circle's retention to 0 and only the live position
is kept. Trips survive pruning as aggregates: distance, duration, endpoints.

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
breadcrumb, place, alert and notification tied to it.

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

You'll need Node 20.10+ and Postgres 14+.
