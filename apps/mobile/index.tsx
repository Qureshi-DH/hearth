import "@expo/metro-runtime" // fast refresh on web without expo-router
import { registerRootComponent } from "expo"
import { AppRegistry } from "react-native"

import { App } from "@/app"
import { HEADLESS_TASK, runHeadlessTask } from "@/services/location/tracker"

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets the environment up for both Expo Go and native builds.
registerRootComponent(App)

// Android starts this task in a process it woke for a location event, with
// no screen: the native side has already started the service and buffered
// what it saw, and this drains it. Registered here, at the entry, so it
// exists the moment the bundle has run.
AppRegistry.registerHeadlessTask(HEADLESS_TASK, () => runHeadlessTask)
