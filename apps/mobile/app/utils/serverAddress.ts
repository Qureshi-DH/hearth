/**
 * The addresses to try for what somebody typed in the server field. A bare
 * name is tried over HTTPS, and over plain HTTP only when it can only be on
 * the local network. Anywhere else a failed HTTPS attempt is what somebody on
 * the same café Wi-Fi would arrange, and falling back would hand them the
 * password and keep the http:// address for good.
 */
export function serverCandidates(raw: string): string[] {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) return []
  if (/^https?:\/\//i.test(trimmed)) return [trimmed]
  const https = `https://${trimmed}`
  return isLocalHost(hostOf(trimmed)) ? [https, `http://${trimmed}`] : [https]
}

function hostOf(address: string): string {
  const authority = address.split(/[/?#]/)[0] ?? ""
  const bracketed = /^\[([^\]]+)\]/.exec(authority)
  if (bracketed) return bracketed[1]!.toLowerCase()
  return authority.replace(/:\d+$/, "").toLowerCase()
}

export function isLocalHost(host: string): boolean {
  if (!host) return false
  if (host === "localhost") return true
  if (!host.includes(".") && !host.includes(":")) return true
  if (/\.(local|lan|home\.arpa|internal)$/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT, which is also where Tailscale puts its devices.
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (host.includes(":")) {
    return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  return false
}
