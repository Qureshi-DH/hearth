import { withPodfile, type ConfigPlugin } from "@expo/config-plugins"
import { mergeContents } from "@expo/config-plugins/build/utils/generateCode"

/**
 * The app's own deployment target, the one expo-build-properties sets in
 * app.json. Pods that still declare an older one are raised to it.
 */
const DEPLOYMENT_TARGET = "16.0"

/**
 * Xcode 27 refuses to build a target older than iOS 15 rather than warning
 * about it, and a few pods still declare 9.0 or 12.4 (SDWebImage, RNSVG's
 * filters). They run on the app's own minimum anyway, so they are built for
 * it.
 */
const withPodDeploymentTarget: ConfigPlugin = (config) =>
  withPodfile(config, (podfile) => {
    podfile.modResults.contents = mergeContents({
      tag: "hearth-pod-deployment-target",
      src: podfile.modResults.contents,
      newSrc: [
        "    installer.pods_project.targets.each do |target|",
        "      target.build_configurations.each do |build|",
        `        if build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < ${DEPLOYMENT_TARGET}`,
        `          build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${DEPLOYMENT_TARGET}'`,
        "        end",
        "      end",
        "    end",
      ].join("\n"),
      anchor: /post_install do \|installer\|/,
      offset: 1,
      comment: "#",
    }).contents
    return podfile
  })

export default withPodDeploymentTarget
