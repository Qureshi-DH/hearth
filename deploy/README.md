# deploy/

Reverse-proxy examples referenced from [docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md).

- `Caddyfile` — TLS + websocket proxy for the API (and optionally ntfy).

The compose files themselves live at the repository root:
`docker-compose.yml` (API + Postgres), `docker-compose.ntfy.yml` (self-hosted
push), `docker-compose.redis.yml` (multi-replica realtime).
