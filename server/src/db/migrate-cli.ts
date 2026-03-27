/**
 * `pnpm db:migrate` / `node dist/db/migrate-cli.js`.
 *
 * Kept separate from migrate.ts because detecting "am I the entrypoint?" from
 * inside a bundled module is unreliable. index.js and this file end up with
 * the same import.meta.url, and getting that wrong once meant the server ran
 * migrations twice and exited mid-boot.
 */
import { closeDb } from "./client"
import { runMigrations } from "./migrate"
import { getConfig } from "../env"

getConfig()
runMigrations()
  .then(async () => {
    console.log("✔ migrations applied")
    await closeDb()
    process.exit(0)
  })
  .catch(async (error: unknown) => {
    console.error("✖ migration failed:", error)
    await closeDb().catch(() => {})
    process.exit(1)
  })
