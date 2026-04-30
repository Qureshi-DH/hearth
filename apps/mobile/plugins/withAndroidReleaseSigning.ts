import { withAppBuildGradle, type ConfigPlugin } from "@expo/config-plugins"

/**
 * Expo's Android template signs release builds with the debug keystore, whose
 * password is published in every React Native tutorial. Anyone could sign a
 * build that Android would then accept as an update to an installed Hearth.
 *
 * Set the four properties below to sign with a real key, either on the gradle
 * command line or in ~/.gradle/gradle.properties. Without them the build falls
 * back to the debug key so a fresh clone still compiles, and the APK it
 * produces is fine for trying the app but must not be handed to anyone.
 */
const STORE_PROPERTY = "HEARTH_UPLOAD_STORE_FILE"

const RELEASE_SIGNING_CONFIG = `        release {
            if (project.hasProperty('${STORE_PROPERTY}')) {
                storeFile file(${STORE_PROPERTY})
                storePassword HEARTH_UPLOAD_STORE_PASSWORD
                keyAlias HEARTH_UPLOAD_KEY_ALIAS
                keyPassword HEARTH_UPLOAD_KEY_PASSWORD
            }
        }`

const DEBUG_SIGNING_BLOCK = `            keyPassword 'android'
        }
    }`

const RELEASE_BUILD_TYPE = `            signingConfig signingConfigs.debug
            def enableShrinkResources`

/**
 * Both replacements are anchored to text the Expo template generates. If a
 * template change moves that text we want the build to stop here, because the
 * quiet failure is an APK signed with the debug key that looks releasable.
 */
const withAndroidReleaseSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (gradleConfig) => {
    const contents = gradleConfig.modResults.contents

    if (contents.includes(STORE_PROPERTY)) return gradleConfig

    if (!contents.includes(DEBUG_SIGNING_BLOCK) || !contents.includes(RELEASE_BUILD_TYPE)) {
      throw new Error(
        "withAndroidReleaseSigning could not find the signing config in app/build.gradle. " +
          "The Expo template changed, so update plugins/withAndroidReleaseSigning.ts before releasing.",
      )
    }

    gradleConfig.modResults.contents = contents
      .replace(
        DEBUG_SIGNING_BLOCK,
        `            keyPassword 'android'\n        }\n${RELEASE_SIGNING_CONFIG}\n    }`,
      )
      .replace(
        RELEASE_BUILD_TYPE,
        `            signingConfig project.hasProperty('${STORE_PROPERTY}') ? signingConfigs.release : signingConfigs.debug\n            def enableShrinkResources`,
      )

    return gradleConfig
  })

export default withAndroidReleaseSigning
