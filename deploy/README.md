# deploy/

Reverse-proxy examples referenced from [docs/docs/install/self-hosting.md](../docs/docs/install/self-hosting.md).

- `Caddyfile`: TLS and websocket proxy for the API, and optionally for ntfy.

The compose files themselves live at the repository root:
`docker-compose.yml` (API, Postgres and MinIO, built from this working tree),
`docker-compose.ntfy.yml` (self-hosted push) and `docker-compose.redis.yml`
(multi-replica realtime).

To run a released build rather than your own, delete the `api` service's `build:`
block and point its existing `image:` at `dhqureshi/hearth-api:latest`.
[docs/docs/install/self-hosting.md](../docs/docs/install/self-hosting.md) has
the whole file written that way.
