# Contributing

Thanks for looking. Hearth is a small project with a specific goal, so this is
short.

## Getting set up

You need Node 20.18 or newer, pnpm 9+, and a Postgres you can create databases
in.

```bash
pnpm install
createdb hearth_dev
cp .env.example .env

pnpm dev                  # API on :4000
pnpm seed                 # demo family, prints the login details
```

In `.env`, uncomment `DATABASE_URL` and point it at `hearth_dev`. Everything
else has a working default outside production. Set `JWT_SECRET` as well unless
you enjoy being signed out: without one, development generates a fresh secret on
every restart, which invalidates the tokens it issued before it.

`pnpm install` also installs the git hooks. They format and lint what you
staged, and check the commit message.

For the app, see [docs/docs/developer/mobile.md](docs/docs/developer/mobile.md). Short version:
`npx expo prebuild && npx expo run:ios`.

## Before you open a pull request

```bash
pnpm verify
```

That runs format checking, lint, typecheck and tests. The pre-push hook runs a
subset of it, and CI runs all of it plus a Docker build.

Server tests need a database of their own, which they truncate between specs:

```bash
createdb hearth_test
TEST_DATABASE_URL=postgres://localhost:5432/hearth_test pnpm test
```

They live in `server/src/test`, one folder per feature (alerts, trips, places,
sharing and so on), and run against real Postgres on purpose. A lot of the behaviour worth testing
lives in SQL, in the geofence replay and the presence projection, and mocking
the database would test the mock.

## Conventions

The rules that come up most:

**Comments explain why, not what.** If the name says it, don't write it. Never
write a comment that restates a value, because it goes stale the moment somebody
changes the value.

**Never put a JavaScript `Date` inside a `sql` template.** The postgres-js
driver passes it through unserialised and it fails at runtime, not at compile
time. Use `gt(column, date)` or convert with `.toISOString()` explicitly. This
has bitten us twice.

**Anything that can expose a position goes through `projectPresence`.** That
includes things derived from position. Telling a circle somebody arrived at a
named place is precise information about them, so a circle they share
approximately with must not get it.

**Routes stay thin.** Validate, authorise with `requireMembership`, call a
service, serialise. Logic lives in `server/src/services`.

**Change the shared types first.** If a response shape moves, edit
`packages/shared/src/types.ts` and let both sides fail to compile.

**Schema changes go through Drizzle.** Edit the schema, run `pnpm db:generate`,
commit the SQL it produces. CI fails if the two drift.

## Commits

Conventional commits, checked by a hook and by CI:

```text
feat(server): add speed alerts per circle
fix(mobile): stop the sheet hiding behind the tab bar
docs: explain the ntfy setup properly
```

Scopes: `server`, `mobile`, `shared`, `docs`, `ci`, `deps`, `db`, `deploy`,
`repo`.

Any bug fix should come with a test that fails without it.

## Reporting bugs

Open an issue with the template. Include server logs with `LOG_LEVEL=debug`, and
please redact coordinates and invite codes before pasting.

Security problems go through a private advisory instead. See
[SECURITY.md](SECURITY.md).

## What I'm unlikely to merge

Anything that sends location data to a third party by default, or that makes the
privacy modes advisory rather than enforced on the server. If you think there's
a good reason, open an issue first and let's talk about it.
