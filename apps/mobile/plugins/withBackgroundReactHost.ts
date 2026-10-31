import { withAppDelegate, type ConfigPlugin } from "@expo/config-plugins"
import { mergeContents } from "@expo/config-plugins/build/utils/generateCode"

/**
 * Under the scene life cycle, which the iOS 27 SDK requires, React Native
 * starts when a scene connects. iOS wakes a closed Hearth in the background,
 * with no scene, to deliver the server's ping, run background refresh or hand
 * over a location, and nothing then starts the JavaScript that answers. Before
 * scenes, the app delegate started it at every launch.
 *
 * This starts the host, and only the host, when a launch is still without a
 * scene a moment later. A scene that connects afterwards draws its view on the
 * same host. A normal launch is left to the scene, because the host keeps the
 * launch options it was made with and only the scene's carry a link that
 * opened the app.
 */
const START_HOST = [
  "    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak factory] in",
  "      guard let factory, UIApplication.shared.connectedScenes.isEmpty else { return }",
  "      factory.rootViewFactory.initializeReactHost(",
  "        launchOptions: launchOptions,",
  "        bundleConfiguration: factory.bundleConfiguration,",
  "        devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default()",
  "      )",
  "    }",
].join("\n")

const withBackgroundReactHost: ConfigPlugin = (config) =>
  withAppDelegate(config, (appDelegate) => {
    if (appDelegate.modResults.language !== "swift") {
      throw new Error("withBackgroundReactHost expects a Swift AppDelegate")
    }
    // Stops the build if Expo's template moves, rather than shipping an app
    // that quietly stops answering pings while closed.
    const { contents, didMerge, didClear } = mergeContents({
      tag: "hearth-background-react-host",
      src: appDelegate.modResults.contents,
      newSrc: START_HOST,
      anchor:
        /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
      offset: 0,
      comment: "//",
    })
    if (!didMerge && !didClear && !contents.includes("hearth-background-react-host")) {
      throw new Error("withBackgroundReactHost found no didFinishLaunching to extend")
    }
    appDelegate.modResults.contents = contents
    return appDelegate
  })

export default withBackgroundReactHost
