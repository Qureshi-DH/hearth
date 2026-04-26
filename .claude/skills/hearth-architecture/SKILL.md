---
name: hearth-architecture
description: Use when adding a feature to Hearth or working out where existing behaviour lives. Maps the request path, the location pipeline, the realtime layer, the background jobs, and the mobile data flow.
---

# Hearth architecture

Three packages in one pnpm workspace.

```text
server/            Fastify 5, Drizzle, Postgres
apps/mobile/       Expo SDK 55, React Native, based on Ignite
packages/shared/   Contract types, constants, geo maths. No runtime deps.
```

## Server request path

```text
phone -> reverse proxy -> Fastify
                          helmet, cors, rate limit (per account)
                          @fastify/jwt, 15 minute access tokens
                          zod validation
                          modules/*.routes.ts -> services/* -> Drizzle -> Postgres
```

Everything lives under `/api/v1` except the health probes and the invite
landing page, which sit at the root.

## Where things live

| You want to change              | Look in                                        |
| ------------------------------- | ---------------------------------------------- |
| An endpoint                     | `server/src/modules/*.routes.ts`               |
| Domain logic                    | `server/src/services/`                         |
| Tables and migrations           | `server/src/db/`                               |
| Periodic work                   | `server/src/jobs/scheduler.ts`                 |
| What a viewer is allowed to see | `server/src/services/presence.ts`              |
| Push transports                 | `server/src/services/push.ts`                  |
| A screen                        | `apps/mobile/app/screens/`                     |
| Server calls from the app       | `apps/mobile/app/services/api/`                |
| Background location             | `apps/mobile/app/services/location/tracker.ts` |

## Location pipeline

A user has one location stream. Circles decide who can see it and how
precisely. That mirrors how people think about it and keeps the write path free
of per circle fan out.

`ingestPoints` in `services/locations.ts` does this in order:

1. Normalise and drop implausible fixes without failing the batch
2. Bulk insert with `ON CONFLICT DO NOTHING`, so retries are free
3. Advance the presence snapshot, only ever forwards in time
4. Replay newly inserted fixes through the geofences of circles the member
   shares precisely with
5. Raise battery, speed and incident alerts
6. Publish to the realtime bus

Only step 2 is load bearing. Everything after it can fail without corrupting
history.

## Realtime

`lib/bus.ts` is an in process emitter, or Redis pub/sub when `REDIS_URL` is
set. The bus carries a notification that something changed, never a rendered
payload, because what a viewer may see depends on the viewer. Each socket
projects presence for its own user.

Sockets re-read circle membership on a timer and when a removal event arrives,
so being kicked out stops the coordinates within seconds rather than at
reconnect.

## Background jobs

One tick, every `JOB_INTERVAL_SECONDS`, each step isolated so one failure does
not stop the rest.

```text
drain push -> lapse expired pauses -> flag offline devices -> detect trips
  -> prune history -> prune outbox -> prune sessions
```

Anything that can run on several replicas claims its work first. The push
outbox uses `FOR UPDATE SKIP LOCKED`, trip detection takes a per user advisory
lock.

## Mobile data flow

Server state lives in TanStack Query. Client state lives in zustand backed by
MMKV, which hydrates synchronously so screens never flash empty. Refresh tokens
live in the OS keychain, never in MMKV.

The websocket writes straight into the query cache, so screens only ever read
query data and never subscribe to the socket.

Location fixes go: OS callback, thin out near duplicates, MMKV backed queue,
single flight upload oldest first. A failed upload keeps the queue. A 4xx
validation error drops that batch so one bad fix cannot wedge the pipeline.

## Adding a feature, in order

1. Types in `packages/shared/src/types.ts`
2. Table in `server/src/db/schema.ts`, then `pnpm db:generate`
3. Logic in `server/src/services/`
4. Route in `server/src/modules/`, thin
5. Test in `server/src/test/api.test.ts` against real Postgres
6. Client call in `apps/mobile/app/services/api/endpoints.ts`
7. Hook in `apps/mobile/app/hooks/queries.ts`
8. Screen

If the feature exposes location, revisit `presence.ts` before you ship it.
