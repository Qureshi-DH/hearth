import { AppState } from "react-native"
import { focusManager, QueryClient } from "@tanstack/react-query"

/**
 * React Native has no document to read a visibility state from, so without this
 * the library considers the app focused forever and every refetch interval
 * keeps firing from a phone in someone's pocket.
 */
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener("change", (state) => {
    handleFocus(state === "active")
  })
  return () => subscription.remove()
})

/**
 * The realtime layer writes presence straight into this cache, so queries can
 * afford a longer stale time than a typical CRUD app.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status ?? 0
        // These are deterministic. Retrying them only burns battery.
        if (status === 401 || status === 403 || status === 400 || status === 404) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
})
