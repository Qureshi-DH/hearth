import { useEffect } from "react"
import type {
  CircleInvite,
  CircleMember,
  CircleSettings,
  CurrentUser,
  FeedEvent,
  MemberNotificationPrefs,
  Paginated,
  Place,
  PlaceIcon,
  QuickMessageKey,
  SharingState,
} from "@hearth/shared"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query"

import { endpoints } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { refreshMotionWatch } from "@/services/location/tracker"
import { useSettingsStore } from "@/stores/settings"

import { queryKeys } from "./queryKeys"

export function useMe() {
  const signedIn = useAuthStore((state) => state.status === "signed_in")
  const updateUser = useAuthStore((state) => state.updateUser)
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const me = await endpoints.auth.me()
      updateUser(me)
      return me
    },
    enabled: signedIn,
    staleTime: 5 * 60_000,
  })
}

export function useUpdateMe() {
  const queryClient = useQueryClient()
  const updateUser = useAuthStore((state) => state.updateUser)
  return useMutation({
    mutationFn: (patch: Partial<Pick<CurrentUser, "displayName" | "locale" | "units">>) =>
      endpoints.auth.updateMe(patch),
    onSuccess: (user) => {
      updateUser(user)
      queryClient.setQueryData(queryKeys.me, user)
    },
  })
}

export function useUploadAvatar() {
  const queryClient = useQueryClient()
  const updateUser = useAuthStore((state) => state.updateUser)
  return useMutation({
    mutationFn: (file: { uri: string; name: string; type: string }) =>
      endpoints.auth.uploadAvatar(file),
    onSuccess: (user) => {
      updateUser(user)
      queryClient.setQueryData(queryKeys.me, user)
      // Every circle roster carries a copy of the picture.
      void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
    },
  })
}

export function useRemoveAvatar() {
  const queryClient = useQueryClient()
  const updateUser = useAuthStore((state) => state.updateUser)
  return useMutation({
    mutationFn: () => endpoints.auth.removeAvatar(),
    onSuccess: (user) => {
      updateUser(user)
      queryClient.setQueryData(queryKeys.me, user)
      void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
    },
  })
}

export function useSessions() {
  return useQuery({ queryKey: queryKeys.sessions, queryFn: endpoints.auth.sessions })
}

export function useRevokeSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => endpoints.auth.revokeSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  })
}

export function useMyStats() {
  return useQuery({ queryKey: queryKeys.myStats, queryFn: endpoints.locations.myStats })
}

export function useCircles() {
  const signedIn = useAuthStore((state) => state.status === "signed_in")
  const query = useQuery({
    queryKey: queryKeys.circles,
    queryFn: endpoints.circles.list,
    enabled: signedIn,
    staleTime: 60_000,
  })

  // Crash detection runs the sensors hard and can raise an SOS, so it may only
  // run where a circle has actually asked for it. The tracker reads this from
  // the background, long after any of this is mounted.
  const circles = query.data
  useEffect(() => {
    if (!circles) return
    const wanted = circles.some((circle) => circle.settings.incidentDetection)
    if (wanted !== useSettingsStore.getState().incidentDetection) {
      useSettingsStore.getState().setIncidentDetection(wanted)
      void refreshMotionWatch()
    }
  }, [circles])

  return query
}

export function useCircle(circleId: string | null) {
  const { data: circles } = useCircles()
  return circles?.find((circle) => circle.id === circleId) ?? null
}

export function useCreateCircle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; emoji?: string | null; color?: string | null }) =>
      endpoints.circles.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.circles }),
  })
}

export function useUpdateCircle(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: {
      name?: string
      emoji?: string | null
      color?: string | null
      settings?: Partial<CircleSettings>
    }) => endpoints.circles.update(circleId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.circles }),
  })
}

export function useDeleteCircle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (circleId: string) => endpoints.circles.remove(circleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.circles }),
  })
}

export function useMembers(circleId: string | null) {
  return useQuery({
    queryKey: queryKeys.members(circleId ?? ""),
    queryFn: () => endpoints.circles.members(circleId!),
    enabled: Boolean(circleId),
  })
}

export function useMember(circleId: string | null, userId: string | null): CircleMember | null {
  const { data } = useMembers(circleId)
  return data?.find((member) => member.userId === userId) ?? null
}

export function useUpdateMember(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      userId,
      ...patch
    }: {
      userId: string
      role?: CircleMember["role"]
      nickname?: string | null
    }) => endpoints.circles.updateMember(circleId, userId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(circleId) }),
  })
}

export function useRemoveMember(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => endpoints.circles.removeMember(circleId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(circleId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.circles })
    },
  })
}

export function useSetSharing(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { sharingState: SharingState; pausedUntil?: string | null }) =>
      endpoints.circles.setSharing(circleId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(circleId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.presence(circleId) })
    },
  })
}

export function useSetNotifications(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<MemberNotificationPrefs>) =>
      endpoints.circles.setNotifications(circleId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(circleId) }),
  })
}

export function useInvites(circleId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.invites(circleId ?? ""),
    queryFn: () => endpoints.circles.invites(circleId!),
    enabled: Boolean(circleId) && enabled,
  })
}

export function useCreateInvite(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (
      body: {
        role?: "member" | "admin"
        maxUses?: number | null
        expiresInHours?: number | null
      } = {},
    ) => endpoints.circles.createInvite(circleId, body),
    onSuccess: (invite: CircleInvite) => {
      queryClient.setQueryData<CircleInvite[]>(queryKeys.invites(circleId), (current) => [
        invite,
        ...(current ?? []),
      ])
    },
  })
}

export function useRevokeInvite(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) => endpoints.circles.revokeInvite(circleId, inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites(circleId) }),
  })
}

export function useInvitePreview(code: string | null) {
  return useQuery({
    queryKey: queryKeys.invitePreview(code ?? ""),
    queryFn: () => endpoints.invites.preview(code!),
    enabled: Boolean(code && code.length >= 4),
    retry: false,
  })
}

export function useAcceptInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => endpoints.invites.accept(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.circles }),
  })
}

export function usePresence(circleId: string | null) {
  return useQuery({
    queryKey: queryKeys.presence(circleId ?? ""),
    queryFn: () => endpoints.locations.presence(circleId!),
    enabled: Boolean(circleId),
    // The socket keeps this fresh. The poll is only a fallback for a dead socket.
    refetchInterval: 60_000,
    staleTime: 15_000,
  })
}

export function usePlaces(circleId: string | null) {
  return useQuery({
    queryKey: queryKeys.places(circleId ?? ""),
    queryFn: () => endpoints.places.list(circleId!),
    enabled: Boolean(circleId),
    staleTime: 5 * 60_000,
  })
}

export interface PlaceInput {
  name: string
  icon?: PlaceIcon | null
  color?: string | null
  lat: number
  lon: number
  radiusMeters: number
  address?: string | null
}

export function useSavePlace(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ placeId, ...body }: PlaceInput & { placeId?: string }) =>
      placeId
        ? endpoints.places.update(circleId, placeId, body)
        : endpoints.places.create(circleId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.places(circleId) }),
  })
}

export function useDeletePlace(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (placeId: string) => endpoints.places.remove(circleId, placeId),
    onSuccess: (_result, placeId) => {
      queryClient.setQueryData<Place[]>(queryKeys.places(circleId), (current) =>
        current?.filter((place) => place.id !== placeId),
      )
    },
  })
}

export function usePlaceEvents(circleId: string | null, placeId: string | null) {
  return useQuery({
    queryKey: queryKeys.placeEvents(circleId ?? "", placeId ?? ""),
    queryFn: () => endpoints.places.events(circleId!, placeId!),
    enabled: Boolean(circleId && placeId),
  })
}

export function useHistory(
  circleId: string | null,
  userId: string | null,
  range: { from: string; to: string } | null,
  options: Partial<UseQueryOptions> = {},
) {
  return useQuery({
    queryKey: queryKeys.history(circleId ?? "", userId ?? "", range?.from ?? "", range?.to ?? ""),
    queryFn: () => endpoints.locations.history(circleId!, userId!, { ...range, limit: 3000 }),
    enabled: Boolean(circleId && userId && range) && options.enabled !== false,
    staleTime: 60_000,
  })
}

export function useEvents(circleId: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.events(circleId ?? ""),
    queryFn: ({ pageParam }) =>
      endpoints.events.list(circleId!, { limit: 50, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Paginated<FeedEvent>) => last.nextCursor ?? undefined,
    enabled: Boolean(circleId),
    staleTime: 30_000,
  })
}

export function useMarkFeedRead(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => endpoints.events.markRead(circleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.circles }),
  })
}

/**
 * Nothing is cached: the message is shown to the recipient once and recorded in
 * their feed by the server, so the sender has no list to keep in step.
 */
export function useActiveSos(circleId: string | null) {
  return useQuery({
    queryKey: queryKeys.sos(circleId ?? ""),
    queryFn: () => endpoints.safety.sosHistory(circleId!, true),
    enabled: Boolean(circleId),
    refetchInterval: 30_000,
  })
}

export function useRaiseSos(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (note?: string | null) => endpoints.safety.raiseSos(circleId, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sos(circleId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.presence(circleId) })
    },
  })
}

export function useResolveSos(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (alertId: string) => endpoints.safety.resolveSos(alertId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sos(circleId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.presence(circleId) })
    },
  })
}

export function useCheckIn(circleId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { lat: number; lon: number; note?: string | null }) =>
      endpoints.safety.checkIn(circleId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.checkIns(circleId) }),
  })
}

export function useNudge(circleId: string) {
  return useMutation({
    mutationFn: (input: { userId: string; quickKey?: QuickMessageKey; body?: string }) =>
      endpoints.safety.nudge(circleId, input.userId, {
        quickKey: input.quickKey,
        body: input.body,
      }),
  })
}

export function useTrips(circleId: string | null, userId: string | null) {
  return useQuery({
    queryKey: queryKeys.trips(circleId ?? "", userId ?? ""),
    queryFn: () => endpoints.trips.forMember(circleId!, userId!),
    enabled: Boolean(circleId && userId),
    staleTime: 5 * 60_000,
  })
}

export function useTrip(tripId: string | null) {
  return useQuery({
    queryKey: queryKeys.trip(tripId ?? ""),
    queryFn: () => endpoints.trips.get(tripId!),
    enabled: Boolean(tripId),
    staleTime: Infinity,
  })
}

export function useAdminStats(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.admin.stats, queryFn: endpoints.admin.stats, enabled })
}

export function useAdminSettings(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: endpoints.admin.settings,
    enabled,
  })
}

export function useUpdateAdminSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: endpoints.admin.updateSettings,
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.admin.settings, settings),
  })
}

export function useAdminUsers(enabled: boolean, q?: string) {
  return useQuery({
    queryKey: queryKeys.admin.users(q),
    queryFn: () => endpoints.admin.users(q),
    enabled,
  })
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, ...patch }: { userId: string; isActive?: boolean; isAdmin?: boolean }) =>
      endpoints.admin.updateUser(userId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  })
}
