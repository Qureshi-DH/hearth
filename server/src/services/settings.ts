import type { RegistrationMode, ServerSettings } from "@hearth/shared"
import { eq } from "drizzle-orm"

import type { Database } from "../db/client"
import { serverSettings } from "../db/schema"
import { getConfig } from "../env"

const KEY = "server"

/**
 * Env is the floor an operator sets in their compose file. Database overrides
 * sit on top so admins can change the mutable subset without redeploying.
 */
export async function getServerSettings(db: Database): Promise<ServerSettings> {
  const config = getConfig()
  const defaults: ServerSettings = {
    serverName: config.SERVER_NAME,
    registrationMode: config.REGISTRATION_MODE,
    maxHistoryRetentionDays: config.MAX_HISTORY_RETENTION_DAYS,
    nativeMotion: false,
  }

  const [row] = await db
    .select({ value: serverSettings.value })
    .from(serverSettings)
    .where(eq(serverSettings.key, KEY))
    .limit(1)

  if (!row) return defaults
  return { ...defaults, ...(row.value as Partial<ServerSettings>) }
}

export async function updateServerSettings(
  db: Database,
  patch: Partial<ServerSettings>,
): Promise<ServerSettings> {
  const current = await getServerSettings(db)
  const next = { ...current, ...patch }

  await db
    .insert(serverSettings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: serverSettings.key,
      set: { value: next, updatedAt: new Date() },
    })

  return next
}

export async function registrationMode(db: Database): Promise<RegistrationMode> {
  return (await getServerSettings(db)).registrationMode
}
