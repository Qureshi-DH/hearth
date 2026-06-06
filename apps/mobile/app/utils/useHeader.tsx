import { useEffect, useLayoutEffect } from "react"
import { Platform } from "react-native"
import { useNavigation } from "@react-navigation/native"

import { Header, HeaderProps } from "@/components/Header"

/** @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/utils/useHeader.tsx/} */
export function useHeader(
  headerProps: HeaderProps,
  deps: Parameters<typeof useLayoutEffect>[1] = [],
) {
  const navigation = useNavigation()

  /**
   * We need to have multiple implementations of this hook for web and mobile.
   * Web needs to use useEffect to avoid a rendering loop.
   * In mobile and also to avoid a visible header jump when navigating between screens, we use
   * `useLayoutEffect`, which will apply the settings before the screen renders.
   */
  const usePlatformEffect = Platform.OS === "web" ? useEffect : useLayoutEffect

  usePlatformEffect(() => {
    navigation.setOptions({
      headerShown: true,
      header: () => <Header {...headerProps} />,
    })
    // intentionally created API to have user set when they want to update the header via `deps`
  }, [...deps, navigation])
}
