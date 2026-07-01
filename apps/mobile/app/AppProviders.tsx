import type { ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context"

import { queryClient } from "@/services/queryClient"
import { ThemeProvider } from "@/theme/context"

/**
 * Everything a screen can reach for, in the order it has to be in.
 *
 * BottomSheetModalProvider goes last. A BottomSheetModal does not render where
 * it is written: its content is handed to a host the provider renders, and
 * that content gets the host's context, not the caller's. With the provider
 * above the theme, every modal sheet crashed on its first Text.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
