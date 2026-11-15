# deploy/

Everything for running the server somewhere.
[Ways to deploy](../docs/docs/install/deploy.md) walks through each one.

| Path                         | What it is                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `install.sh`                 | The one-command installer, served at `qureshi-dh.github.io/hearth/install.sh` |
| `compose/docker-compose.yml` | The published image with Postgres and MinIO, no clone needed                  |
| `compose/caddy.yml`          | Adds Caddy for automatic HTTPS beside it                                      |
| `Caddyfile`                  | A Caddy config for a proxy outside Docker                                     |
| `kubernetes/`                | Kustomize manifests: API, Postgres StatefulSet, Ingress                       |
| `fly/fly.toml`               | Fly.io                                                                        |
| `coolify/docker-compose.yml` | Coolify, using its generated passwords and domain                             |
| `caprover/hearth.yml`        | CapRover one-click app template                                               |
| `portainer/`                 | A stack that takes its settings as variables, and an App Template             |
| `unraid/hearth.xml`          | Unraid Community Applications template                                        |

`render.yaml` and `.do/deploy.template.yaml` sit at the repository root because
the Render and DigitalOcean buttons only look there.

The compose files at the root are for working on Hearth:
`docker-compose.yml` builds the API from this working tree, and
`docker-compose.ntfy.yml` (self-hosted push) and `docker-compose.redis.yml`
(several API replicas) are overlays for it.

Every template here runs `dhqureshi/hearth-api:latest`. When a setting changes
in `server/src/env.ts`, check the templates that spell it out:
`portainer/docker-compose.yml`, `unraid/hearth.xml`, `caprover/hearth.yml`,
`coolify/docker-compose.yml`, `render.yaml` and `.do/deploy.template.yaml`.
