import { Platform } from "react-native"
import Constants from "expo-constants"

import { translate } from "@/i18n/translate"
import { isLocalHost } from "@/utils/serverAddress"

export type PlainHttpReach = "any" | "local" | "none"

/**
 * Where this build can send plain HTTP. The OS has no way to ask, so
 * app.config.ts writes its own decision into `extra.plainHttp`. In
 * development that is read from whatever Metro evaluated, not the build.
 */
export function plainHttpReach(): PlainHttpReach {
  const extra = Constants.expoConfig?.extra as { plainHttp?: unknown } | undefined
  if (extra?.plainHttp === true) return "any"
  // The template's debug manifest turns cleartext on for every Android debug
  // build, and a release build has it off for every host, LAN included.
  if (Platform.OS === "android") return __DEV__ ? "any" : "none"
  // Every iOS build keeps NSAllowsLocalNetworking.
  return "local"
}

/** Whether this address, with http:// in front, could get anywhere from this build. */
export function plainHttpCanReach(address: string, reach: PlainHttpReach): boolean {
  if (reach !== "local") return reach === "any"
  const host = hostOf(address)
  // isLocalHost also counts names under .lan, .home.arpa and .internal, which
  // App Transport Security treats like any public name.
  return isLocalHost(host) && !/\.(lan|home\.arpa|internal)$/.test(host)
}

function hostOf(address: string): string {
  const authority = address.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? ""
  const bracketed = /^\[([^\]]+)\]/.exec(authority)
  if (bracketed) return bracketed[1]!.toLowerCase()
  return authority.replace(/:\d+$/, "").toLowerCase()
}

/** What the server screen says when none of the addresses it tried answered. */
export function describeProbeFailure(
  error: unknown,
  tried: string[],
  reach: PlainHttpReach = plainHttpReach(),
): string {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("different API")) return message
  if (message.includes("answered")) return translate("server:notHearth")
  if (/abort/i.test(message)) return translate("server:timeout")
  const plain = tried.filter((address) => !/^https:\/\//i.test(address))
  if (plain.length > 0 && plain.every((address) => !plainHttpCanReach(address, reach))) {
    return translate(plain.length === tried.length ? "server:httpBlocked" : "server:httpsOnly")
  }
  if (plain.length === 0 && tried.length > 0) {
    return tried.some((address) => plainHttpCanReach(address, reach))
      ? translate("server:noHttps")
      : translate("server:httpsOnly")
  }
  return translate("server:invalid")
}
