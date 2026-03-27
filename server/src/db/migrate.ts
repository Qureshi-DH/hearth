import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { migrate } from "drizzle-orm/postgres-js/migrator"

import { getDb } from "./client"

/**
 * The same code runs from TypeScript source and from the bundled output, and
 * the Docker image copies migrations next to the bundle. Probing beats
 * hard-coding one path and failing mysteriously everywhere else.
 */
export function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(here, "migrations"),
    resolve(here, "db/migrations"),
    resolve(process.cwd(), "dist/db/migrations"),
    resolve(process.cwd(), "src/db/migrations"),
    resolve(process.cwd(), "server/src/db/migrations"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Could not locate migrations. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      "Set MIGRATIONS_DIR to point at the folder containing the generated SQL.",
  )
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolveMigrationsDir()
  await migrate(getDb(), { migrationsFolder })
}
