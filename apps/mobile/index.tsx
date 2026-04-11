import "@expo/metro-runtime" // fast refresh on web without expo-router
import { registerRootComponent } from "expo"

import { App } from "@/app"

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets the environment up for both Expo Go and native builds.
registerRootComponent(App)
