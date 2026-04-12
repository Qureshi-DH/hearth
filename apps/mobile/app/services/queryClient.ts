import { QueryClient } from "@tanstack/react-query"

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
        // These four are deterministic. Retrying them only burns battery.
        if (status === 401 || status === 403 || status === 400 || status === 404) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
})
