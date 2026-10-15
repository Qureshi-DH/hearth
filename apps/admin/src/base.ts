interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null
}

/**
 * The path the server is behind, "/hearth" under a proxy at a path and "" at
 * the root of a domain. The server writes it into the page, because the
 * page's policy allows no inline script to say it.
 */
export function readBase(page: Page | undefined): string {
  const content = page?.querySelector('meta[name="hearth-base"]')?.getAttribute("content")
  return (content ?? "").replace(/\/+$/, "")
}

export const BASE = readBase(typeof document === "undefined" ? undefined : document)

/** What the Hearth app needs typed in to reach this server. */
export function serverAddress(): string {
  return `${window.location.origin}${BASE}`
}
