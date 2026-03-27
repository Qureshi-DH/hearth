import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import { getConfig } from "../env"
import * as schema from "./schema"

export type Database = ReturnType<typeof drizzle<typeof schema>>

let client: postgres.Sql | null = null
let database: Database | null = null

export function getSql(): postgres.Sql {
  if (!client) {
    const config = getConfig()
    client = postgres(config.DATABASE_URL, {
      max: config.DATABASE_POOL_MAX,
      // Postgres notices are noise in application logs.
      onnotice: () => {},
      prepare: true,
    })
  }
  return client
}

export function getDb(): Database {
  if (!database) {
    database = drizzle(getSql(), { schema })
  }
  return database
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 })
    client = null
    database = null
  }
}

export { schema }
