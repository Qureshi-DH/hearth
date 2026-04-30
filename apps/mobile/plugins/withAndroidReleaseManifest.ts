import { withDangerousMod, type ConfigPlugin } from "@expo/config-plugins"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * React Native asks for SYSTEM_ALERT_WINDOW so the dev menu can draw over other
 * apps. Android shows that to users as "Display over other apps", which is a
 * lot to ask for a family locator that has no overlay, and it is the kind of
 * thing people rightly look for in an app that can see where they are.
 *
 * A release-only manifest drops it from shipped builds while debug builds keep
 * the dev menu. The manifest merger applies this on top of the main manifest.
 */
const RELEASE_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove" />
</manifest>
`

const withAndroidReleaseManifest: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    "android",
    (dangerousConfig) => {
      const releaseDir = join(
        dangerousConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "release",
      )
      mkdirSync(releaseDir, { recursive: true })
      writeFileSync(join(releaseDir, "AndroidManifest.xml"), RELEASE_MANIFEST)
      return dangerousConfig
    },
  ])

export default withAndroidReleaseManifest
