import { useState, useEffect, useRef } from "react"
import { BackHandler, Linking, Platform } from "react-native"
import {
  NavigationState,
  PartialState,
  createNavigationContainerRef,
} from "@react-navigation/native"

import Config from "@/config"
import type { PersistNavigationConfig } from "@/config/config.base"
import * as storage from "@/utils/storage"
import { useIsMounted } from "@/utils/useIsMounted"

import type { AppStackParamList, NavigationProps } from "./navigationTypes"

type Storage = typeof storage

/**
 * Reference to the root App Navigator.
 *
 * If needed, you can use this to access the navigation object outside of a
 * `NavigationContainer` context. However, it's recommended to use the `useNavigation` hook whenever possible.
 * @see [Navigating Without Navigation Prop]{@link https://reactnavigation.org/docs/navigating-without-navigation-prop/}
 *
 * The types on this reference will only let you reference top level navigators. If you have
 * nested navigators, you'll need to use the `useNavigation` with the stack navigator's ParamList type.
 */
export const navigationRef = createNavigationContainerRef<AppStackParamList>()

export function getActiveRouteName(state: NavigationState | PartialState<NavigationState>): string {
  const route = state.routes[state.index ?? 0]

  if (!route.state) return route.name as keyof AppStackParamList

  return getActiveRouteName(route.state as NavigationState<AppStackParamList>)
}

const iosExit = () => false

export function useBackButtonHandler(canExit: (routeName: string) => boolean) {
  // The reason we're using a ref here is because we need to be able
  // to update the canExit function without re-setting up all the listeners
  const canExitRef = useRef(Platform.OS !== "android" ? iosExit : canExit)

  useEffect(() => {
    canExitRef.current = canExit
  }, [canExit])

  useEffect(() => {
    const onBackPress = () => {
      if (!navigationRef.isReady()) {
        return false
      }

      const rootState = navigationRef.getRootState()
      if (!rootState) return false
      const routeName = getActiveRouteName(rootState)

      if (canExitRef.current(routeName)) {
        BackHandler.exitApp()
        return true
      }

      if (navigationRef.canGoBack()) {
        navigationRef.goBack()
        return true
      }

      return false
    }

    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)

    return () => subscription.remove()
  }, [])
}

function navigationRestoredDefaultState(persistNavigation: PersistNavigationConfig) {
  if (persistNavigation === "always") return false
  if (persistNavigation === "dev" && __DEV__) return false
  if (persistNavigation === "prod" && !__DEV__) return false

  // all other cases, disable restoration by returning true
  return true
}

export function useNavigationPersistence(storage: Storage, persistenceKey: string) {
  const [initialNavigationState, setInitialNavigationState] =
    useState<NavigationProps["initialState"]>()
  const isMounted = useIsMounted()

  const initNavState = navigationRestoredDefaultState(Config.persistNavigation)
  const [isRestored, setIsRestored] = useState(initNavState)

  const routeNameRef = useRef<keyof AppStackParamList | undefined>(undefined)

  const onNavigationStateChange = (state: NavigationState | undefined) => {
    const previousRouteName = routeNameRef.current
    if (state !== undefined) {
      const currentRouteName = getActiveRouteName(state)

      if (previousRouteName !== currentRouteName) {
        if (__DEV__) {
          console.log(currentRouteName)
        }
      }

      routeNameRef.current = currentRouteName as keyof AppStackParamList

      storage.save(persistenceKey, state)
    }
  }

  const restoreState = async () => {
    try {
      const initialUrl = await Linking.getInitialURL()

      // Only restore the state if app has not started from a deep link
      if (!initialUrl) {
        const state = (await storage.load(persistenceKey)) as NavigationProps["initialState"] | null
        if (state) setInitialNavigationState(state)
      }
    } finally {
      if (isMounted()) setIsRestored(true)
    }
  }

  useEffect(() => {
    if (!isRestored) restoreState()
    // runs once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { onNavigationStateChange, restoreState, isRestored, initialNavigationState }
}

/**
 * If you have access to the navigation prop, do not use this.
 * @see {@link https://reactnavigation.org/docs/navigating-without-navigation-prop/}
 */
export function navigate(name: unknown, params?: unknown) {
  if (navigationRef.isReady()) {
    // @ts-expect-error
    navigationRef.navigate(name as never, params as never)
  }
}

export function goBack() {
  if (navigationRef.isReady() && navigationRef.canGoBack()) {
    navigationRef.goBack()
  }
}

export function resetRoot(
  state: Parameters<typeof navigationRef.resetRoot>[0] = { index: 0, routes: [] },
) {
  if (navigationRef.isReady()) {
    navigationRef.resetRoot(state)
  }
}
