import { API_PREFIX } from "@hearth/shared"

/**
 * The path in front of everything Hearth serves, "/hearth" when PUBLIC_URL is
 * https://lab.example.com/hearth, and "" at the root of a domain. Doubled
 * slashes are collapsed, since //hearth as written names another host.
 */
export function basePath(publicUrl: string): string {
  return new URL(publicUrl).pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
}

/**
 * A proxy that strips the base hands on /api/v1/..., and one that does not
 * hands on /hearth/api/v1/..., so the base comes off when it is there and
 * routing never knows the difference.
 */
export function stripBasePath(url: string, base: string): string {
  // With a base of /api, a stripped request is already an API path, and
  // taking /api off it as well would leave the phones nothing to reach.
  if (!base || !url.startsWith(base) || url.startsWith(`${API_PREFIX}/`)) return url
  const rest = url.slice(base.length)
  if (rest === "" || rest.startsWith("?")) return `/${rest}`
  return rest.startsWith("/") ? rest : url
}

/** What Hearth serves outside the API, each a path a base must not start with. */
const OWN_PATHS = ["/docs", "/join", "/healthz", "/readyz"]

/**
 * Why Hearth cannot sit under this base, or null when it can. A stripped
 * request for one of Hearth's own paths that begins with the base would lose
 * it a second time, and under /join an invite link would open the portal.
 */
export function basePathConflict(base: string): string | null {
  const own = [...OWN_PATHS, API_PREFIX].find(
    (path) => base === path || base.startsWith(`${path}/`),
  )
  return own
    ? `${own} is a path Hearth serves itself. Put Hearth under one of its own, such as /hearth.`
    : null
}
