import type { AdminAuditEntry, RegistrationMode } from "@hearth/shared"

import { SIGN_UP_LABEL } from "./labels"

/**
 * The address on a reused token is whoever presented it, which is usually the
 * member's own phone retrying. Only an administrator's own actions show theirs.
 */
const ADMINISTRATOR_ACTIONS = new Set([
  "settings.update",
  "user.update",
  "user.password",
  "session.revoke",
  "session.revoke_all",
  "portal.sign_in",
])

export function auditIp(entry: AdminAuditEntry): string | null {
  return ADMINISTRATOR_ACTIONS.has(entry.action) ? entry.ip : null
}

const signUp = (mode: string) =>
  mode in SIGN_UP_LABEL ? SIGN_UP_LABEL[mode as RegistrationMode].toLowerCase() : mode

export function describeAuditEntry(entry: AdminAuditEntry): string {
  const who = entry.actorName ?? "Somebody"
  const whom = entry.targetName ?? "an account"
  const meta = entry.meta ?? {}
  switch (entry.action) {
    case "settings.update": {
      const parts: string[] = []
      if (typeof meta.serverName === "string")
        parts.push(`renamed the server to ${meta.serverName}`)
      if (typeof meta.registrationMode === "string") {
        parts.push(`set sign-up to ${signUp(meta.registrationMode)}`)
      }
      if ("maxHistoryRetentionDays" in meta) {
        parts.push(
          meta.maxHistoryRetentionDays == null
            ? "handed the history limit back to .env"
            : `limited history to ${String(meta.maxHistoryRetentionDays)} days`,
        )
      }
      return `${who} ${parts.length > 0 ? parts.join(", ") : "saved the server settings"}`
    }
    case "user.update":
      if (meta.isActive === false) return `${who} deactivated ${whom}`
      if (meta.isActive === true) return `${who} reactivated ${whom}`
      if (meta.isAdmin === true) return `${who} made ${whom} an administrator`
      if (meta.isAdmin === false) return `${who} removed ${whom} as an administrator`
      return `${who} changed ${whom}'s account`
    case "user.password":
      return `${who} set a new password for ${whom}`
    case "session.revoke":
      return `${who} signed ${whom} out of ${typeof meta.deviceName === "string" ? meta.deviceName : "a device"}`
    case "session.revoke_all":
      return `${who} signed ${whom} out everywhere`
    case "session.refresh_reuse":
      return `A sign-in token of ${who}'s was used twice, so that session was ended`
    case "portal.sign_in":
      return `${who} signed in to the portal`
    default:
      return `${who}: ${entry.action}`
  }
}
