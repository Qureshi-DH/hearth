import type { CircleInvite, InvitePreview } from "@hearth/shared"

import { translate } from "@/i18n/translate"

/**
 * What the join field holds, whether typed or carried in by a link. The
 * server refuses anything else with a 400, and the preview asks it on every
 * keystroke.
 */
export function cleanInviteCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16)
}

export interface InviteLink {
  code: string
  /** Where the code can be looked up, when the link says. */
  server: string | null
}

const CODE = /^[A-Za-z0-9]{4,16}$/

/**
 * Reads what a QR, a shared link or the join page hands the app. The code is
 * always the path after /join/, which is all older links carry. The server is
 * the web link's own address, or the `server` the join page adds to the app
 * link.
 */
export function parseInviteLink(raw: string): InviteLink | null {
  const text = raw.trim()
  if (CODE.test(text)) return { code: text.toUpperCase(), server: null }

  const split = text.search(/[?#]/)
  const path = split === -1 ? text : text.slice(0, split)
  const query = split === -1 ? "" : text.slice(split + 1)
  const match = /^(.*)\/join\/([A-Za-z0-9]{4,16})\/?$/.exec(path)
  if (!match || !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null

  const isWeb = /^https?:\/\//i.test(path)
  return {
    code: match[2]!.toUpperCase(),
    server: webAddress(isWeb ? match[1]! : queryValue(query, "server")),
  }
}

function queryValue(query: string, key: string): string | null {
  for (const pair of query.split("&")) {
    const [name, value = ""] = pair.split("=")
    if (name !== key) continue
    try {
      return decodeURIComponent(value.replace(/\+/g, " "))
    } catch {
      return null
    }
  }
  return null
}

/** Only an http or https address is fit to fill the server field with. */
function webAddress(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim().replace(/\/+$/, "")
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(trimmed) ? trimmed : null
}

/**
 * The server's own web link. A phone camera opens it in the browser, where
 * the join page walks somebody without the app through the rest. Hearth's own
 * scanner reads the server from it, and an older one still finds the code at
 * the end.
 */
export function inviteQrValue(invite: Pick<CircleInvite, "code" | "url">): string {
  const link = parseInviteLink(invite.url)
  return link?.server && link.code === invite.code ? invite.url : `hearth://join/${invite.code}`
}

/** Why a code cannot be used, in the words the join screen uses. */
export function inviteRefusalText(reason: InvitePreview["reason"] | "failed"): string | null {
  switch (reason) {
    case "expired":
      return translate("join:expired")
    case "revoked":
      return translate("join:revoked")
    case "exhausted":
      return translate("join:exhausted")
    case "already_member":
      return translate("join:alreadyMember")
    case "not_found":
      return translate("join:notFound")
    case "removed":
      return translate("join:removed")
    default:
      return null
  }
}
