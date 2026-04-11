import { ExpoConfig, ConfigContext } from "@expo/config"

/**
 * Use tsx/cjs here so we can use TypeScript for our Config Plugins
 * and not have to compile them to JavaScript.
 *
 * See https://docs.expo.dev/config-plugins/plugins/#add-typescript-support-and-convert-to-dynamic-app-config
 */
import "tsx/cjs"

/**
 * Plain-HTTP servers.
 *
 * Both platforms block cleartext traffic by default, which is right for a
 * public deployment (put TLS in front — see docs/SELF-HOSTING.md). Families
 * trying Hearth on a LAN at http://192.168.x.x need it allowed, so development
 * builds allow it and production builds can opt in with HEARTH_ALLOW_HTTP=1.
 */
const allowInsecureHttp =
  process.env.HEARTH_ALLOW_HTTP === "1" ||
  (process.env.HEARTH_ALLOW_HTTP !== "0" &&
    process.env.EAS_BUILD_PROFILE !== "production" &&
    process.env.NODE_ENV !== "production")

module.exports = ({ config }: ConfigContext): Partial<ExpoConfig> => {
  type Plugin = NonNullable<ExpoConfig["plugins"]>[number]
  const existingPlugins: Plugin[] = (config.plugins ?? []).map((plugin): Plugin => {
    if (Array.isArray(plugin) && plugin[0] === "expo-build-properties") {
      const [name, props] = plugin as [string, Record<string, Record<string, unknown>>]
      return [
        name,
        {
          ...props,
          android: { ...(props.android ?? {}), usesCleartextTraffic: allowInsecureHttp },
        },
      ]
    }
    return plugin
  })

  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        // iOS ignores NSAllowsArbitraryLoads whenever NSAllowsLocalNetworking is
        // also present, so the two are mutually exclusive here:
        //   default  -> local networking only (RFC1918, link-local, .local names)
        //   opted in -> arbitrary loads, which already covers local hosts too
        NSAppTransportSecurity: allowInsecureHttp
          ? { NSAllowsArbitraryLoads: true }
          : { NSAllowsLocalNetworking: true },
      },
      // This privacyManifests is to get you started.
      // See Expo's guide on apple privacy manifests here:
      // https://docs.expo.dev/guides/apple-privacy/
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
            NSPrivacyAccessedAPITypeReasons: ["CA92.1"], // CA92.1 = "Access info from same app, per documentation"
          },
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
            NSPrivacyAccessedAPITypeReasons: ["C617.1"], // files inside the app container (MMKV, export cache)
          },
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
            NSPrivacyAccessedAPITypeReasons: ["35F9.1"], // elapsed-time measurement (location timestamps)
          },
        ],
      },
    },
    plugins: [...existingPlugins],
  }
}
