import { useEffect, useReducer, useSyncExternalStore } from "react"

import { realtime } from "@/services/realtime"

/**
 * A socket that is reconnecting for a second is not news, and saying so
 * every time a phone changes cell would teach people to ignore it.
 */
export const REALTIME_DOWN_NOTICE_MS = 5_000

/** Whether the screens' socket has been down long enough to say so. */
export function useRealtimeDown(): boolean {
  const since = useSyncExternalStore(
    (listener) => realtime.onStatusChange(listener),
    () => realtime.downSince,
  )
  const [, wake] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (since == null) return
    const left = since + REALTIME_DOWN_NOTICE_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(wake, left + 1)
    return () => clearTimeout(timer)
  }, [since])
  return since != null && Date.now() - since >= REALTIME_DOWN_NOTICE_MS
}
