import type {
  AdminAuditEntry,
  AdminCheck,
  AdminCircleSummary,
  AdminOutboxEntry,
  AdminOverview,
  AdminStats,
  AdminUserSummary,
  ServerInfo,
  ServerSettings,
  SessionSummary,
} from "@hearth/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { client } from "./client"

/** The public facts every page and the sign-in screen use. Needs no session. */
export function useServerInfo() {
  return useQuery({
    queryKey: ["server-info"],
    queryFn: () => client.request<ServerInfo>("/server-info"),
    staleTime: 5 * 60_000,
  })
}

/**
 * The database's size and row counts cost the server a few scans, so only a
 * page that shows them polls, at `every` milliseconds.
 */
export function useStats({ every }: { every?: number } = {}) {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => client.request<AdminStats>("/admin/stats"),
    refetchInterval: every ?? false,
  })
}

/** The viewer's own days, so "today" on the dashboard is today where they sit. */
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

export const OVERVIEW_EVERY_MS = 60_000

export function useOverview() {
  const timeZone = viewerTimeZone()
  return useQuery({
    // A laptop that crosses a time zone gets its own days, not the cached ones.
    queryKey: ["overview", timeZone],
    queryFn: () =>
      client.request<AdminOverview>(`/admin/overview?tz=${encodeURIComponent(timeZone)}`),
    refetchInterval: OVERVIEW_EVERY_MS,
  })
}

export type OverviewQuery = ReturnType<typeof useOverview>

export function useChecks() {
  return useQuery({
    queryKey: ["checks"],
    queryFn: () => client.request<AdminCheck[]>("/admin/checks"),
    refetchInterval: 60_000,
  })
}

export function useUsers(query = "") {
  return useQuery({
    queryKey: ["users", query],
    queryFn: () =>
      client.request<AdminUserSummary[]>(
        `/admin/users?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}`,
      ),
    placeholderData: (previous) => previous,
  })
}

export function useUserSessions(userId: string | null) {
  return useQuery({
    queryKey: ["sessions", userId],
    queryFn: () => client.request<SessionSummary[]>(`/admin/users/${userId}/sessions`),
    enabled: userId != null,
  })
}

export function useCircles() {
  return useQuery({
    queryKey: ["circles"],
    queryFn: () => client.request<AdminCircleSummary[]>("/admin/circles"),
  })
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => client.request<ServerSettings>("/admin/settings"),
  })
}

export const OUTBOX_EVERY_MS = 15_000

export function useOutbox(status: AdminOutboxEntry["status"] | "all") {
  return useQuery({
    queryKey: ["outbox", status],
    queryFn: () =>
      client.request<AdminOutboxEntry[]>(
        `/admin/push/queue?limit=100${status === "all" ? "" : `&status=${status}`}`,
      ),
    refetchInterval: OUTBOX_EVERY_MS,
    placeholderData: (previous) => previous,
  })
}

export function useAudit() {
  return useQuery({
    queryKey: ["audit"],
    queryFn: () => client.request<AdminAuditEntry[]>("/admin/audit?limit=200"),
  })
}

/** A change to the server: refreshes what it touched, and the audit log it wrote to. */
export function useAdminAction<Input, Result = unknown>(
  run: (input: Input) => Promise<Result>,
  touches: string[],
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSettled: () => {
      for (const key of [...touches, "audit", "checks", "stats", "overview"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
}
