import type { RegistrationMode, ServerSettings } from "@hearth/shared"

/** The settings form's fields, kept as typed rather than as the server stores them. */
export interface SettingsDraft {
  name: string
  mode: RegistrationMode
  ceiling: string
}

export function draftOf(settings: ServerSettings): SettingsDraft {
  return {
    name: settings.serverName,
    mode: settings.registrationMode,
    ceiling: settings.maxHistoryRetentionDays?.toString() ?? "",
  }
}

/** An empty ceiling hands the limit back to .env. */
export const ceilingDays = (draft: SettingsDraft): number | null =>
  draft.ceiling.trim() === "" ? null : Number(draft.ceiling)

export function changesFrom(draft: SettingsDraft, saved: ServerSettings): Partial<ServerSettings> {
  const changes: Partial<ServerSettings> = {}
  if (draft.name.trim() !== saved.serverName) changes.serverName = draft.name.trim()
  if (draft.mode !== saved.registrationMode) changes.registrationMode = draft.mode
  const days = ceilingDays(draft)
  if (days !== saved.maxHistoryRetentionDays) changes.maxHistoryRetentionDays = days
  return changes
}

/**
 * The draft once the server's values move from `seen` to `next`. A form
 * nobody has touched shows the new values. One with edits keeps them, since
 * wiping what somebody is typing is worse than showing them old values.
 */
export function followServer(
  draft: SettingsDraft,
  seen: ServerSettings,
  next: ServerSettings,
): SettingsDraft {
  return Object.keys(changesFrom(draft, seen)).length === 0 ? draftOf(next) : draft
}
