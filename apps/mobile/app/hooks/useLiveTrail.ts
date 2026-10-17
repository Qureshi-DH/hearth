import { useCallback, useMemo } from "react"
import type { TrailFix } from "@hearth/shared"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { endpoints } from "@/services/api"
import { mergeTrail } from "@/utils/trail"

import { queryKeys } from "./queryKeys"

/**
 * The trail of one person on Live. It holds every fix the socket carried
 * while the page was open, and what it missed while the app was away or the
 * socket was down, filled from the server when the page asks. The socket writes
 * here only while this is mounted, and it is dropped when the page closes,
 * so a page opened again starts from where they are.
 */
export function useLiveTrail(circleId: string, userId: string, canFill: boolean) {
  const queryClient = useQueryClient()
  const key = useMemo(() => queryKeys.liveTrail(circleId, userId), [circleId, userId])
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const current = queryClient.getQueryData<TrailFix[]>(key) ?? []
      const last = current[current.length - 1]
      if (!canFill || !last) return current
      const missed = await endpoints.locations.liveTrail(circleId, userId, last.recordedAt)
      return mergeTrail(queryClient.getQueryData<TrailFix[]>(key) ?? [], missed)
    },
    initialData: [] as TrailFix[],
    staleTime: Infinity,
    gcTime: 0,
    // A fill that fails leaves the trail as it was, and the next return to
    // the page or the next reconnect tries again.
    retry: false,
  })
  const { refetch } = query
  const add = useCallback(
    (fixes: TrailFix[]) =>
      queryClient.setQueryData<TrailFix[]>(key, (current) => mergeTrail(current ?? [], fixes)),
    [queryClient, key],
  )
  const fill = useCallback(() => void refetch(), [refetch])
  return { points: query.data, add, fill }
}
