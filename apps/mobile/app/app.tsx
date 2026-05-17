/* eslint-disable import/first */
/**
 * Root of the Hearth mobile app.
 *
 * Boot sequence: fonts + i18n load, the keychain token vault hydrates, the
 * auth store derives its status, and only then does the navigator render.
 * The first frame is already the right screen.
 */
if (__DEV__) {
  // Reactotron relies on metro's `inlineRequires` (see metro.config.js).
  require("./devtools/ReactotronConfig.ts")
}
import "./utils/gestureHandler"

import { useEffect, useState } from "react"
import { AppState } from "react-native"
import { useFonts } from "expo-font"
import * as Linking from "expo-linking"
import * as SplashScreen from "expo-splash-screen"
import { QueryClientProvider } from "@tanstack/react-query"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context"

import { IncidentPrompt } from "./components/IncidentPrompt"
import { ToastHost } from "./components/Toast"
import { initI18n } from "./i18n"
import { AppNavigator } from "./navigators/AppNavigator"
import { useNavigationPersistence } from "./navigators/navigationUtilities"
// Importing this module also registers the OS background tasks, which have to
// be defined at module scope before the app finishes launching.
import { refreshLocationStatus, resumeIfEnabled } from "./services/location/tracker"
import { setupChannels } from "./services/notifications"
import { queryClient } from "./services/queryClient"
import { useAuthStore } from "./stores/auth"
import { tokenVault } from "./stores/tokenVault"
import { ThemeProvider } from "./theme/context"
import { customFontsToLoad } from "./theme/typography"
import { loadDateFnsLocale } from "./utils/formatDate"
import * as storage from "./utils/storage"

/**
 * Hold the native splash until the first real screen can draw. Without this it
 * disappears as soon as the bundle loads, so the user watches a blank frame
 * while fonts, translations and the stored session come up.
 */
SplashScreen.preventAutoHideAsync().catch(() => {})
SplashScreen.setOptions({ duration: 300, fade: true })

export const NAVIGATION_PERSISTENCE_KEY = "NAVIGATION_STATE"

/** Pull an invite code out of a join link; null for anything else. */
export function extractInviteCode(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/join\/([A-Za-z0-9]{4,16})/)
  return match ? match[1]!.toUpperCase() : null
}

const prefix = Linking.createURL("/")

/**
 * Deep links: `hearth://join/CODE` from a QR, `https://<server>/join/CODE`
 * from a shared link, and the notification payloads mapped in AppNavigator.
 */
const linkingConfig = {
  screens: {
    JoinCircle: "join/:code",
    Main: {
      screens: {
        Map: "map",
        Places: "places",
        Activity: "activity",
        You: "you",
      },
    },
    MemberDetail: "circles/:circleId/members/:userId",
    Sos: "circles/:circleId/sos",
  },
}

export function App() {
  const {
    initialNavigationState,
    onNavigationStateChange,
    isRestored: isNavigationStateRestored,
  } = useNavigationPersistence(storage, NAVIGATION_PERSISTENCE_KEY)

  const [areFontsLoaded, fontLoadError] = useFonts(customFontsToLoad)
  const [isI18nInitialized, setIsI18nInitialized] = useState(false)
  const [isSessionHydrated, setIsSessionHydrated] = useState(false)

  useEffect(() => {
    initI18n()
      .then(() => setIsI18nInitialized(true))
      .then(() => loadDateFnsLocale())
  }, [])

  // Invite links (hearth://join/CODE or https://<server>/join/CODE) can arrive
  // before there is a session. Park the code; AppNavigator redeems it later.
  useEffect(() => {
    const capture = (url: string | null) => {
      const code = extractInviteCode(url)
      if (code) useAuthStore.getState().setPendingInvite(code)
    }
    void Linking.getInitialURL().then(capture)
    const subscription = Linking.addEventListener("url", (event) => capture(event.url))
    return () => subscription.remove()
  }, [])

  // Permission and the OS location switch can both be turned off while the app
  // is away, and nothing tells us. Re-read them every time we come back.
  useEffect(() => {
    void refreshLocationStatus()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshLocationStatus()
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const tokens = await tokenVault.hydrate()
      const store = useAuthStore.getState()
      // A persisted user without tokens (keychain wiped, reinstall) is signed out.
      if (!tokens && store.user) store.signedOut()
      store.markBooted()
      await setupChannels()
      if (!cancelled) setIsSessionHydrated(true)
      if (useAuthStore.getState().status === "signed_in") void resumeIfEnabled()
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const isReady =
    isNavigationStateRestored &&
    isI18nInitialized &&
    isSessionHydrated &&
    (areFontsLoaded || !!fontLoadError)

  useEffect(() => {
    if (isReady) void SplashScreen.hideAsync()
  }, [isReady])

  if (!isReady) return null

  const linking = { prefixes: [prefix, "hearth://"], config: linkingConfig }

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AppNavigator
              linking={linking}
              initialState={initialNavigationState}
              onStateChange={onNavigationStateChange}
            />
            <IncidentPrompt />
            <ToastHost />
          </ThemeProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}
