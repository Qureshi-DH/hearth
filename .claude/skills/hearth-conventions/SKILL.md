---
name: hearth-conventions
description: Use when writing or reviewing any code in this repository. Covers the comment policy, the Drizzle and Postgres gotchas that have already caused bugs here, the privacy rules that must not be bypassed, and the test expectations.
---

# Hearth code conventions

## Comments

The rule is simple. Explain why, never what.

A comment must earn its place by saying something the code cannot. If a reader
could work it out from the identifier and the three lines below it, delete the
comment.

Never write a comment that restates a value. Those go stale the moment somebody
changes the value, and a stale comment is worse than none.

```ts
// Bad. The name already says this, and the number will drift.
/** Maximum number of points accepted in one batch. Currently 200. */
maxLocationBatchSize: 200,

// Fine. No comment needed.
maxLocationBatchSize: 200,

// Good. This is a decision a reader would otherwise second guess.
// Leaving requires clearing the radius plus a buffer, otherwise a phone
// resting on a boundary emits arrive and leave forever.
exitBufferMeters: 40,
```

Do not add a JSDoc block to a function whose name and signature already say
everything. Reserve JSDoc for exported API surface where the contract is not
obvious, or where there is a trap.

Delete commented out code. Git remembers it.

## Database

Never put a JavaScript `Date` inside a `sql` template. The postgres-js driver
passes it through unserialised and the query fails at runtime, not at compile
time. Use the Drizzle helpers, or convert explicitly.

```ts
// Breaks at runtime.
sql`... where recorded_at < ${cutoff}`

// Correct.
lt(locationPoints.recordedAt, cutoff)
sql`... where recorded_at < ${cutoff.toISOString()}::timestamptz`
```

Schema changes go through Drizzle. Edit `server/src/db/schema.ts`, run
`pnpm db:generate`, and commit the generated SQL. Never hand edit a migration
that has already been applied anywhere.

Anything that deletes rows in bulk needs a batch limit. One unbounded DELETE
over months of location history holds locks long enough to stall the API.

## Privacy

Every read path that can expose a member's position goes through
`projectPresence` in `server/src/services/presence.ts`. If you add an endpoint
that returns coordinates, a trail, a trip, or a place, it must respect the
member's per circle sharing state.

The same rule applies to anything derived from position. Telling a circle that
somebody arrived at a named place is precise information about them, so a
circle they share approximately with must not receive it.

Push payloads carry identifiers and human readable text. They never carry
coordinates.

## Authorisation

Every circle scoped route calls `requireMembership(request, circleId, minRole)`.
Never trust a role from the token. Roles change and tokens live for fifteen
minutes.

When a route changes somebody else's role or membership, decide the check from
the target's current rank, not only from the rank being requested.

## Routes

Routes stay thin. Validate with zod, authorise, call a service, serialise.
Domain logic lives in `server/src/services`.

Responses use the mappers in `server/src/lib/serialize.ts` so the shape matches
`packages/shared/src/types.ts`. Returning a raw Drizzle row is a bug waiting to
happen, because the column names and the API field names are allowed to differ.

## Shared contract

If a response shape changes, change `packages/shared/src/types.ts` first. The
server and the app both fail to typecheck until they agree, which is the point.

`packages/shared` has no runtime dependencies. Metro consumes it as TypeScript
source. Adding a dependency there breaks the mobile build.

## Tests

Server tests run against a real Postgres and truncate between specs. Mocking
the database would test nothing, because most of the interesting behaviour is
in SQL.

Any bug you fix gets a test that fails without the fix.

```bash
TEST_DATABASE_URL=postgres://localhost:5432/hearth_test pnpm --filter @hearth/server test
```

## Before you finish

```bash
pnpm typecheck
pnpm test
pnpm lint
```
