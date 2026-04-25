## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was wrong, or what this makes possible. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes, including the server suite against a real Postgres
- [ ] `pnpm lint` passes
- [ ] Any bug fix has a test that fails without the fix
- [ ] If this touches location data, it still goes through `projectPresence`
- [ ] Schema changes include the generated migration
