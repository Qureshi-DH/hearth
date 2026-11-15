---
sidebar_position: 0
title: Ways to deploy
description: Run the Hearth server with one command, Docker Compose, a one-click cloud host, Coolify, CapRover, Portainer, Unraid or Kubernetes.
---

Every option on this page runs the same thing: the `dhqureshi/hearth-api`
image, built for amd64 and arm64, next to a Postgres 14 or newer database. They
differ in who looks after the machine and how much you type. Pick by what you
already run.

| You have                     | Use                                                         |
| ---------------------------- | ----------------------------------------------------------- |
| A Linux machine or VPS       | [The install script](#one-command)                          |
| Docker and your own proxy    | [Docker Compose](#docker-compose)                           |
| No server, and a card        | [Render, DigitalOcean, Fly.io or Railway](#one-click-cloud) |
| Coolify, CapRover, Portainer | [A template for it](#homelab-platforms)                     |
| Unraid                       | [The Community Applications template](#unraid)              |
| A Kubernetes cluster         | [The manifests](#kubernetes)                                |

Whichever you pick, three things hold:

- The admin account comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on the very
  first start, while the database is empty. Everyone else joins with an invite.
  Changing those two later does nothing, so change the password from the app.
- Phones need HTTPS. A release build of the app won't talk to a plain HTTP
  server on the internet, so every option below puts TLS in front.
- The server has to stay awake. It asks each phone where it is every few
  minutes, so a free plan that sleeps when nobody visits leaves the map stale.

## One command

On any Linux machine with Docker, including a Raspberry Pi 4:

```bash
curl -fsSL https://qureshi-dh.github.io/hearth/install.sh | sh
```

It asks for three things: the domain phones will use, your email, and a
password, which it can make up for you. It writes `docker-compose.yml` and a
`.env` with every other secret generated into `./hearth`, then starts Postgres,
MinIO for profile pictures, the API, and Caddy, which gets the certificate for
your domain. Point the domain's DNS at the machine and open ports 80 and 443
before you run it.

Leave the domain empty to try Hearth on your own network first. The API then
listens on port 4000 on every interface, plain HTTP, which is fine on a LAN and
wrong anywhere the internet can reach.

The script is [deploy/install.sh](https://github.com/Qureshi-DH/hearth/blob/main/deploy/install.sh),
and piping it into a shell means trusting it, so read it first. To run it
without questions:

```bash
curl -fsSL https://qureshi-dh.github.io/hearth/install.sh | \
  HEARTH_DOMAIN=hearth.example.com HEARTH_ADMIN_EMAIL=you@example.com sh
```

With no `HEARTH_ADMIN_PASSWORD`, it generates one and prints it once.
`HEARTH_DIR` changes the folder, and `HEARTH_NO_START=1` writes the files
without starting anything. Upgrading later is the usual:

```bash
cd hearth
docker compose pull
docker compose up -d
```

## Docker Compose

The compose file the script uses works on its own:

```bash
mkdir hearth && cd hearth
curl -fsSLO https://raw.githubusercontent.com/Qureshi-DH/hearth/main/deploy/compose/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/Qureshi-DH/hearth/main/.env.example
```

Set `JWT_SECRET`, `PUBLIC_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`POSTGRES_PASSWORD` and `S3_SECRET_ACCESS_KEY` in `.env`, then
`docker compose up -d`. The API listens on `127.0.0.1:4000` for a reverse proxy
on the same machine. [Self-hosting](self-hosting.md) has Caddy, nginx and
Traefik configs, backups and the rest.

For Caddy in the same stack, download
[`caddy.yml`](https://github.com/Qureshi-DH/hearth/blob/main/deploy/compose/caddy.yml)
next to it and add these to `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:caddy.yml
HEARTH_DOMAIN=hearth.example.com
PUBLIC_URL=https://hearth.example.com
TRUST_PROXY=true
```

## One-click cloud

These run the published image on a host that keeps the machine patched for you.
The host can read what's on a server it runs, so your family's history sits
with the provider you choose. None of them is affiliated with Hearth.

Profile pictures are off on all of them, since there's no MinIO beside the API.
Avatars fall back to initials, and setting `S3_ENDPOINT` and the keys to any S3
compatible bucket turns uploads on.

### Render

[Deploy to Render](https://render.com/deploy?repo=https://github.com/Qureshi-DH/hearth)
reads [`render.yaml`](https://github.com/Qureshi-DH/hearth/blob/main/render.yaml)
and creates the API and a Postgres database. It generates the token secret and
asks for your email and admin password. The server takes its address from
Render, so invites work straight away. Point a custom domain at it later and set
`PUBLIC_URL` to match.

The Blueprint uses Render's smallest paid plans. A free web service sleeps after
15 minutes, and a free database expires after 30 days.

### DigitalOcean

[Deploy to DigitalOcean](https://cloud.digitalocean.com/apps/new?repo=https://github.com/Qureshi-DH/hearth/tree/main)
reads [`.do/deploy.template.yaml`](https://github.com/Qureshi-DH/hearth/blob/main/.do/deploy.template.yaml)
and creates an App Platform app with a development database. It asks for
`JWT_SECRET`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` before it builds. Fill
`JWT_SECRET` with the output of `openssl rand -hex 48`.

### Fly.io

Fly has no button, but the config is ready. In an empty folder:

```bash
curl -fsSLO https://raw.githubusercontent.com/Qureshi-DH/hearth/main/deploy/fly/fly.toml
fly launch --copy-config --no-deploy
fly secrets set JWT_SECRET=$(openssl rand -hex 48) \
  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' \
  DATABASE_URL='postgres://user:password@host:5432/hearth'
fly deploy
```

`DATABASE_URL` is any Postgres 14 or newer. With Fly's Managed Postgres, use
the direct connection string rather than the pooled one, because Hearth
prepares its statements and a pooler in transaction mode loses them. The
machine is kept running, and the server finds its own `https://<app>.fly.dev`
address.

### Railway

1. Make a project and add a service from the Docker image
   `dhqureshi/hearth-api:latest`.
2. Add a Postgres database to the same project.
3. On the Hearth service, set these variables. The first two are Railway's own
   syntax and fill themselves in.

   ```bash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=${{secret(48)}}
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD=a-long-passphrase
   NODE_ENV=production
   TRUST_PROXY=true
   ```

4. Under Networking, generate a domain, and set the health check path to
   `/readyz`.

The server reads the domain Railway generated, so `PUBLIC_URL` only needs
setting for a custom one.

### Any other container host

Koyeb, Northflank, a Synology or a QNAP: anything that runs a container and
keeps it running will do. Give it:

- the image `dhqureshi/hearth-api:latest`, listening on `PORT` (4000 unless the
  host sets it)
- `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (32 or more random
  characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `PUBLIC_URL` set to the
  https address phones will use
- `TRUST_PROXY=true` when the host's proxy terminates TLS, which on a cloud host
  it always does
- a health check on `GET /readyz`, and websockets allowed through

## Homelab platforms

### Coolify

Add a resource, choose **Docker Compose Empty**, and paste
[`deploy/coolify/docker-compose.yml`](https://github.com/Qureshi-DH/hearth/blob/main/deploy/coolify/docker-compose.yml).
Coolify generates the database credentials, the token secret and the admin
password, which it shows under Environment Variables, and gives the API a
domain with a certificate. Set `ADMIN_EMAIL` there before the first deploy.

### CapRover

Under **One-Click Apps/Databases**, scroll to `>> TEMPLATE <<` at the end of
the list and paste
[`deploy/caprover/hearth.yml`](https://github.com/Qureshi-DH/hearth/blob/main/deploy/caprover/hearth.yml).
The form asks for your email and password and generates the rest. When it's
done, turn on HTTPS for the app and tick Force HTTPS.

### Portainer

Add a stack from a repository: `https://github.com/Qureshi-DH/hearth` with the
compose path `deploy/portainer/docker-compose.yml`. That file takes its settings
as stack variables rather than from a `.env` file, so add `PUBLIC_URL`,
`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `POSTGRES_PASSWORD` under
Environment variables.

To get Hearth in Portainer's App Templates instead, set the templates URL in
Settings to
`https://raw.githubusercontent.com/Qureshi-DH/hearth/main/deploy/portainer/templates.json`.

### Unraid

[`deploy/unraid/hearth.xml`](https://github.com/Qureshi-DH/hearth/blob/main/deploy/unraid/hearth.xml)
is a Community Applications template for the API. Hearth needs a Postgres
container next to it, so install one from Community Applications first, make a
`hearth` database and user, and point `DATABASE_URL` at it. Until the template
is listed in Community Applications, save the file to
`/boot/config/plugins/dockerMan/templates-user/` on the server, and it shows up
under Add Container.

### Kubernetes

[`deploy/kubernetes`](https://github.com/Qureshi-DH/hearth/tree/main/deploy/kubernetes)
is a Kustomize directory with the API, a Postgres StatefulSet and an Ingress:

```bash
git clone https://github.com/Qureshi-DH/hearth.git
cd hearth/deploy/kubernetes
cp hearth.env.example hearth.env   # fill in every value
# set your host in ingress.yaml
kubectl apply -k .
```

It runs one API replica. A second needs Redis for realtime events, which
`REDIS_URL` in `.env.example` covers. The Ingress expects a controller that
passes websocket upgrades through, which ingress-nginx and Traefik do by default,
and cert-manager or a TLS secret named `hearth-tls`.

## After it's up

Open the server's address in a browser for the admin portal, or `/docs` for the
API reference. Then install the app, type the same address on its first screen,
and sign in. [Push notifications](push-notifications.md) covers waking phones
that have Hearth closed, and [Self-hosting](self-hosting.md#backups) covers
backups, which nothing on this page sets up for you.
