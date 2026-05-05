/**
 * The server stores avatars as a path rather than an absolute URL, so moving a
 * server to a new hostname does not break every picture at once. Resolve
 * against whichever server this device is signed in to.
 */
export function resolveMediaUrl(
  path: string | null | undefined,
  baseUrl: string | null | undefined,
): string | undefined {
  if (!path) return undefined
  if (/^https?:\/\//i.test(path)) return path
  if (!baseUrl) return undefined
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`
}
