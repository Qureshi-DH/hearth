import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import { Agent } from "node:https"
import { BlockList, isIP } from "node:net"

/**
 * Addresses a user-supplied endpoint must never make the server connect to:
 * loopback, the private and link-local ranges, carrier-grade NAT, benchmark
 * and IETF protocol ranges, and IPv6's unique-local, link-local and NAT64
 * prefixes. On a home server that is the router, the NAS and every service on
 * the compose network.
 */
const internal = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
] as const) {
  internal.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  internal.addSubnet(network, prefix, "ipv6")
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "")
  const family = isIP(value)
  if (family === 4) return internal.check(value, "ipv4")
  if (family === 6) return internal.check(value, "ipv6")
  return true
}

/**
 * An https agent that refuses to connect to an internal address, checked when
 * the connection is made rather than when the endpoint was registered. A name
 * that resolved to a public address at registration can be pointed anywhere
 * afterwards.
 */
export const publicOnlyAgent = new Agent({
  lookup(hostname, options, callback) {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "", 0)
      const list = addresses as LookupAddress[]
      const blocked = list.find((entry) => isPrivateAddress(entry.address))
      if (blocked || list.length === 0) {
        const refusal = Object.assign(new Error(`${hostname} resolves to an internal address`), {
          code: "EHEARTHINTERNAL",
        })
        return callback(refusal, "", 0)
      }
      if (options.all) return callback(null, list as never)
      callback(null, list[0]!.address, list[0]!.family)
    })
  },
})

/**
 * The address a rate limit should count a client under. An IPv6 host usually
 * owns a whole /64, and counting each address in it separately hands anyone
 * with one VPS an unlimited supply of fresh buckets.
 */
export function clientBucket(address: string): string {
  const value = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "")
  if (isIP(value) !== 6) return value
  const [head = "", tail = ""] = value.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = value.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`
}
