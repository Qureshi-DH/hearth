import { AppState } from "react-native"
import { focusManager, QueryClient } from "@tanstack/react-query"

import { usePlacesStore, type PlaceLite } from "@/stores/places"

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

// The tracker needs the circles' places to upload an arrival at once, and
// the map already fetches them; every places query that lands is copied to
// the store the tracker reads, so the two never disagree.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" && event.type !== "added") return
  const key = event.query.queryKey
  if (key[0] !== "places" || typeof key[1] !== "string" || !key[1]) return
  const data = event.query.state.data
  if (!Array.isArray(data)) return
  usePlacesStore.getState().setPlaces(key[1], data as PlaceLite[])
})
