// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config")
const path = require("path")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "..", "..")

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// Monorepo: watch the workspace so edits to packages/shared hot-reload, and
// resolve modules from both the app's and the hoisted root node_modules.
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]

config.transformer.getTransformOptions = async () => ({
  transform: {
    // Inline requires defer loading of large dependencies (e.g. Reactotron).
    // See https://reactnative.dev/docs/optimizing-javascript-loading
    inlineRequires: true,
  },
})

// Prefer the "react-native"/"browser" conditions so dual-published packages
// resolve their RN builds; keep "require" for the remaining CJS-only ones.
config.resolver.unstable_conditionNames = ["react-native", "browser", "require", "default"]

// Some third-party libraries ship .cjs files.
config.resolver.sourceExts.push("cjs")

module.exports = config
