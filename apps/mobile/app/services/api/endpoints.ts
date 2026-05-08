import type {
  AdminStats,
  AdminUserSummary,
  AuthResponse,
  CheckIn,
  Circle,
  CircleMessage,
  CircleInvite,
  CircleMember,
  CircleRole,
  CircleSettings,
  CurrentUser,
  DeviceInfo,
  FeedEvent,
  HistoryPoint,
  InvitePreview,
  LocationBatchResponse,
  LocationFixInput,
  MemberNotificationPrefs,
  MemberPresence,
  Paginated,
  Place,
  PlaceEvent,
  PlaceIcon,
  PushConfig,
  PushProvider,
  ServerInfo,
  ServerSettings,
  SessionSummary,
  SharingState,
  SosAlert,
  Trip,
} from "@hearth/shared"

import type { ApiClient } from "./client"

/**
 * No caching, no retries, no state. The React Query hooks in app/hooks compose
 * these. Screens never call them directly.
 */
export function createEndpoints(api: ApiClient) {
  return {
    system: {
      async probe(baseUrl: string, timeoutMs = 8000): Promise<ServerInfo> {
        const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/server-info`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          })
          // Reached *something*. Failures from here on mean "not Hearth", which
          // is a different problem for the user than "wrong address".
          if (!response.ok) throw new Error(`Server answered ${response.status}.`)

          let body: Partial<ServerInfo>
          try {
            body = (await response.json()) as Partial<ServerInfo>
          } catch {
            throw new Error("Server answered, but not with JSON.")
          }
          if (!body || typeof body.serverName !== "string" || typeof body.apiVersion !== "string") {
            throw new Error("Server answered, but it is not Hearth.")
          }
          if (body.apiVersion !== "v1")
            throw new Error("That server speaks a different API version.")
          return body as ServerInfo
        } finally {
          clearTimeout(timer)
        }
      },
      info: () => api.get<ServerInfo>("/server-info", { auth: false }),
    },

    auth: {
      register: (body: {
        email: string
        password: string
        displayName: string
        inviteCode?: string
        device: DeviceInfo
      }) => api.post<AuthResponse>("/auth/register", body, { auth: false }),
      login: (body: { email: string; password: string; device: DeviceInfo }) =>
        api.post<AuthResponse>("/auth/login", body, { auth: false }),
      logout: () => api.post<{ ok: true }>("/auth/logout"),
      me: () => api.get<CurrentUser>("/auth/me"),
      updateMe: (patch: Partial<Pick<CurrentUser, "displayName" | "locale" | "units">>) =>
        api.patch<CurrentUser>("/auth/me", patch),
      uploadAvatar: (file: { uri: string; name: string; type: string }) => {
        const form = new FormData()
        // React Native's FormData takes this shape for a file part.
        form.append("file", file as unknown as Blob)
        return api.post<CurrentUser>("/auth/me/avatar", form)
      },
      removeAvatar: () => api.delete<CurrentUser>("/auth/me/avatar"),
      changePassword: (body: { currentPassword: string; newPassword: string }) =>
        api.post<{ ok: true; revokedSessions: number }>("/auth/password", body),
      sessions: () => api.get<SessionSummary[]>("/auth/sessions"),
      revokeSession: (sessionId: string) => api.delete<{ ok: true }>(`/auth/sessions/${sessionId}`),
      revokeAll: () => api.post<{ ok: true; revokedSessions: number }>("/auth/sessions/revoke-all"),
      exportData: () => api.get<unknown>("/me/export", { timeoutMs: 60_000 }),
      deleteAccount: (password: string) => api.delete<{ ok: true }>("/me", { password }),
    },

    circles: {
      list: () => api.get<Circle[]>("/circles"),
      get: (circleId: string) => api.get<Circle>(`/circles/${circleId}`),
      create: (body: { name: string; emoji?: string | null; color?: string | null }) =>
        api.post<Circle & { invite: CircleInvite }>("/circles", body),
      update: (
        circleId: string,
        patch: {
          name?: string
          emoji?: string | null
          color?: string | null
          settings?: Partial<CircleSettings>
        },
      ) => api.patch<Circle>(`/circles/${circleId}`, patch),
      remove: (circleId: string) => api.delete<{ ok: true }>(`/circles/${circleId}`),
      members: (circleId: string) => api.get<CircleMember[]>(`/circles/${circleId}/members`),
      updateMember: (
        circleId: string,
        userId: string,
        patch: { role?: CircleRole; nickname?: string | null },
      ) => api.patch<CircleMember>(`/circles/${circleId}/members/${userId}`, patch),
      removeMember: (circleId: string, userId: string) =>
        api.delete<{ ok: true }>(`/circles/${circleId}/members/${userId}`),
      setSharing: (
        circleId: string,
        body: { sharingState: SharingState; pausedUntil?: string | null },
      ) => api.patch<CircleMember>(`/circles/${circleId}/sharing`, body),
      setNotifications: (circleId: string, body: Partial<MemberNotificationPrefs>) =>
        api.patch<MemberNotificationPrefs>(`/circles/${circleId}/notifications`, body),
      invites: (circleId: string) => api.get<CircleInvite[]>(`/circles/${circleId}/invites`),
      createInvite: (
        circleId: string,
        body: {
          role?: "member" | "admin"
          maxUses?: number | null
          expiresInHours?: number | null
        } = {},
      ) => api.post<CircleInvite>(`/circles/${circleId}/invites`, body),
      revokeInvite: (circleId: string, inviteId: string) =>
        api.delete<{ ok: true }>(`/circles/${circleId}/invites/${inviteId}`),
    },

    invites: {
      preview: (code: string) => api.get<InvitePreview>(`/invites/${encodeURIComponent(code)}`),
      accept: (code: string) =>
        api.post<{
          circleId: string
          circleName: string
          role: CircleRole
          alreadyMember: boolean
        }>(`/invites/${encodeURIComponent(code)}/accept`),
    },

    locations: {
      upload: (points: LocationFixInput[]) =>
        api.post<LocationBatchResponse>("/locations/batch", { points }, { timeoutMs: 30_000 }),
      presence: (circleId: string) => api.get<MemberPresence[]>(`/circles/${circleId}/locations`),
      history: (
        circleId: string,
        userId: string,
        query: { from?: string; to?: string; limit?: number } = {},
      ) => api.get<HistoryPoint[]>(`/circles/${circleId}/members/${userId}/history`, { query }),
      eraseMine: (before?: string) =>
        api.delete<{ ok: true; deleted: number }>("/me/history", undefined, { query: { before } }),
      myStats: () =>
        api.get<{
          locationPoints: number
          oldestPointAt: string | null
          newestPointAt: string | null
        }>("/me/stats"),
    },

    places: {
      list: (circleId: string) => api.get<Place[]>(`/circles/${circleId}/places`),
      create: (
        circleId: string,
        body: {
          name: string
          icon?: PlaceIcon | null
          color?: string | null
          lat: number
          lon: number
          radiusMeters: number
          address?: string | null
        },
      ) => api.post<Place>(`/circles/${circleId}/places`, body),
      update: (
        circleId: string,
        placeId: string,
        patch: Partial<{
          name: string
          icon: PlaceIcon | null
          color: string | null
          lat: number
          lon: number
          radiusMeters: number
          address: string | null
        }>,
      ) => api.patch<Place>(`/circles/${circleId}/places/${placeId}`, patch),
      remove: (circleId: string, placeId: string) =>
        api.delete<{ ok: true }>(`/circles/${circleId}/places/${placeId}`),
      events: (circleId: string, placeId: string, limit = 100) =>
        api.get<PlaceEvent[]>(`/circles/${circleId}/places/${placeId}/events`, {
          query: { limit },
        }),
    },

    events: {
      list: (circleId: string, query: { limit?: number; cursor?: string } = {}) =>
        api.get<Paginated<FeedEvent>>(`/circles/${circleId}/events`, { query }),
      markRead: (circleId: string) =>
        api.post<{ ok: true; readAt: string }>(`/circles/${circleId}/events/read`),
      unreadCount: (circleId: string) =>
        api.get<{ unread: number }>(`/circles/${circleId}/events/unread-count`),
    },

    messages: {
      list: (circleId: string, query: { limit?: number; cursor?: string } = {}) =>
        api.get<Paginated<CircleMessage>>(`/circles/${circleId}/messages`, { query }),
      send: (circleId: string, body: { body?: string; quickKey?: string; toUserId?: string }) =>
        api.post<CircleMessage>(`/circles/${circleId}/messages`, body),
    },

    safety: {
      raiseSos: (circleId: string, note?: string | null) =>
        api.post<SosAlert & { notifiedMembers: number }>(`/circles/${circleId}/sos`, { note }),
      resolveSos: (alertId: string) => api.post<{ ok: true }>(`/sos/${alertId}/resolve`),
      sosHistory: (circleId: string, activeOnly = false) =>
        api.get<SosAlert[]>(`/circles/${circleId}/sos`, { query: { activeOnly } }),
      checkIn: (circleId: string, body: { lat: number; lon: number; note?: string | null }) =>
        api.post<CheckIn>(`/circles/${circleId}/check-in`, body),
      checkIns: (circleId: string, limit = 50) =>
        api.get<CheckIn[]>(`/circles/${circleId}/check-ins`, { query: { limit } }),
      nudge: (circleId: string, userId: string) =>
        api.post<{ ok: true }>(`/circles/${circleId}/nudge/${userId}`),
    },

    trips: {
      forMember: (circleId: string, userId: string, limit = 50) =>
        api.get<Trip[]>(`/circles/${circleId}/members/${userId}/trips`, { query: { limit } }),
      mine: (limit = 50) => api.get<Trip[]>("/me/trips", { query: { limit } }),
      get: (tripId: string) =>
        api.get<
          Trip & {
            path: Array<{ recordedAt: string; lat: number; lon: number; speedMps: number | null }>
          }
        >(`/trips/${tripId}`),
    },

    push: {
      config: () => api.get<PushConfig>("/push/config", { auth: false }),
      register: (body: { provider: PushProvider; token?: string }) =>
        api.post<{
          ok: true
          provider: PushProvider
          ntfyTopic: string | null
          ntfyBaseUrl: string | null
        }>("/push/register", body),
      unregister: () => api.delete<{ ok: true }>("/push/register"),
      test: () => api.post<{ ok: true; queued: boolean }>("/push/test"),
    },

    admin: {
      settings: () => api.get<ServerSettings>("/admin/settings"),
      updateSettings: (patch: Partial<ServerSettings>) =>
        api.patch<ServerSettings>("/admin/settings", patch),
      users: (q?: string) => api.get<AdminUserSummary[]>("/admin/users", { query: { q } }),
      updateUser: (userId: string, patch: { isActive?: boolean; isAdmin?: boolean }) =>
        api.patch<{ ok: true }>(`/admin/users/${userId}`, patch),
      stats: () => api.get<AdminStats & { pushProvider: PushProvider }>("/admin/stats"),
      drainPush: () =>
        api.post<{ processed: number; sent: number; failed: number; skipped: number }>(
          "/admin/push/drain",
        ),
    },
  }
}

export type Endpoints = ReturnType<typeof createEndpoints>
