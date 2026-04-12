import { Platform } from "react-native"
import * as Application from "expo-application"
import * as Device from "expo-device"
import type { CurrentUser, ServerInfo } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

export type AuthStatus = "booting" | "no_server" | "signed_out" | "signed_in"

interface AuthState {
  status: AuthStatus
  serverUrl: string | null
  serverInfo: ServerInfo | null
  user: CurrentUser | null
  /** Stable per install. The server keys sessions and dedupes fixes on it. */
  deviceId: string
  pendingInviteCode: string | null

  setServer(url: string, info: ServerInfo): void
  setServerInfo(info: ServerInfo): void
  clearServer(): void
  signedIn(user: CurrentUser): void
  updateUser(patch: Partial<CurrentUser>): void
  signedOut(): void
  setPendingInvite(code: string | null): void
  markBooted(): void
}

function generateDeviceId(): string {
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    "",
  )
  return `${Platform.OS}-${random}`
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      status: "booting",
      serverUrl: null,
      serverInfo: null,
      user: null,
      deviceId: generateDeviceId(),
      pendingInviteCode: null,

      setServer: (url, info) => set({ serverUrl: url.replace(/\/+$/, ""), serverInfo: info }),
      setServerInfo: (info) => set({ serverInfo: info }),
      clearServer: () =>
        set({ serverUrl: null, serverInfo: null, user: null, status: "no_server" }),
      signedIn: (user) => set({ user, status: "signed_in" }),
      updateUser: (patch) => {
        const current = get().user
        if (current) set({ user: { ...current, ...patch } })
      },
      signedOut: () => set({ user: null, status: get().serverUrl ? "signed_out" : "no_server" }),
      setPendingInvite: (code) => set({ pendingInviteCode: code }),
      markBooted: () => {
        const { serverUrl, user } = get()
        set({ status: !serverUrl ? "no_server" : user ? "signed_in" : "signed_out" })
      },
    }),
    {
      name: "hearth.auth.v1",
      storage: createJSONStorage(() => mmkvStorage),
      // Status is derived at boot. Tokens live in the keychain, see tokenVault.ts.
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        serverInfo: state.serverInfo,
        user: state.user,
        deviceId: state.deviceId,
        pendingInviteCode: state.pendingInviteCode,
      }),
    },
  ),
)

export function describeDevice() {
  return {
    deviceId: useAuthStore.getState().deviceId,
    deviceName:
      Device.deviceName ??
      (`${Device.manufacturer ?? ""} ${Device.modelName ?? ""}`.trim() || null),
    platform: (Platform.OS === "ios" || Platform.OS === "android" || Platform.OS === "web"
      ? Platform.OS
      : "other") as "ios" | "android" | "web" | "other",
    appVersion: Application.nativeApplicationVersion ?? null,
    osVersion: Device.osVersion ?? null,
  }
}
