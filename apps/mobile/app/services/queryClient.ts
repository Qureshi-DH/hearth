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
 * A 4xx is the server's answer to this request, and asking again only gets
 * it again, each one counted by a firewall that can lock the house out for
 * them. A 429 included, since the retry lands inside the same window. A
 * dropped connection, a 408 and a 5xx may go better a moment later.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number }).status ?? 0
  if (status >= 400 && status < 500 && status !== 408) return false
  return failureCount < 2
}

/**
 * The realtime layer writes presence straight into this cache, so queries can
 * afford a longer stale time than a typical CRUD app.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: shouldRetry,
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

/** Queries whose key names a circle second, which go with the circle. */
const CIRCLE_SCOPED = new Set([
  "circle",
  "members",
  "presence",
  "places",
  "place-events",
  "events",
  "sos",
  "check-ins",
  "invites",
  "trips",
])

const scopedTo = (key: readonly unknown[], circleId: string) =>
  CIRCLE_SCOPED.has(key[0] as string) && key[1] === circleId

/**
 * Drops a circle the person is no longer in, from the list and from every
 * query about it. The hooks ask only for circles the list holds, so nothing
 * goes on polling it, and every poll would be a 403 that a firewall in front
 * of a home server can answer by locking the house out.
 */
export function forgetCircle(circleId: string) {
  queryClient.setQueryData<Array<{ id: string }>>(["circles"], (current) =>
    current?.filter((circle) => circle.id !== circleId),
  )
}

/**
 * Asks for the circles list again, even when only screens that read it
 * without asking are mounted, since a refetch skips a query nobody asks for.
 */
export function recheckCircles() {
  void queryClient
    .getQueryCache()
    .find({ queryKey: ["circles"] })
    ?.fetch()
    .catch(() => undefined)
}

let knownCircles: Set<string> | null = null

queryClient.getQueryCache().subscribe((event) => {
  if (event.query.queryKey[0] !== "circles") return
  // Signing out clears the cache, and the next account's list is not the
  // previous one's minus anything.
  if (event.type === "removed") knownCircles = null
  if (event.type !== "updated") return
  const data = event.query.state.data as Array<{ id: string }> | undefined
  if (!Array.isArray(data)) return
  const now = new Set(data.map((circle) => circle.id))
  const gone = knownCircles ? [...knownCircles].filter((id) => !now.has(id)) : []
  knownCircles = now
  for (const circleId of gone) {
    const about = {
      predicate: (query: { queryKey: readonly unknown[] }) => scopedTo(query.queryKey, circleId),
    }
    void queryClient.cancelQueries(about)
    queryClient.removeQueries(about)
  }
})

/**
 * Somebody removed from a circle, or a circle deleted, while the socket was
 * down shows up as a 403 on the next poll. One look at the circles list says
 * whether that is what happened, and the hooks then stop asking. Once in a
 * while at most, so a 403 for something else does not turn into a loop.
 */
const REFUSAL_RECHECK_MS = 30_000
let recheckedAt = -Infinity

queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.action.type !== "error") return
  const status = (event.action.error as { status?: number } | null)?.status
  const key = event.query.queryKey
  if (status !== 403 || !CIRCLE_SCOPED.has(key[0] as string)) return
  if (Date.now() - recheckedAt < REFUSAL_RECHECK_MS) return
  recheckedAt = Date.now()
  recheckCircles()
})
