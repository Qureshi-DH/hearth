import { control } from "@/services/location/control"
import { realtime } from "@/services/realtime"
import { sessionExpired } from "@/services/session"
import { useAuthStore } from "@/stores/auth"
import { tokenVault } from "@/stores/tokenVault"

import { ApiClient } from "./client"
import { createEndpoints } from "./endpoints"
import { tokenListeners } from "./tokenListeners"

export const api = new ApiClient({
  getBaseUrl: () => useAuthStore.getState().serverUrl,
  getDeviceId: () => useAuthStore.getState().deviceId,
  getTokens: () => tokenVault.peek(),
  setTokens: async (tokens) => {
    await tokenVault.set(tokens)
    // The websocket authenticates with the access token in its URL, so a
    // rotated token leaves the open socket holding a dead credential.
    if (tokens) {
      realtime.refresh()
      control.refresh()
    }
    for (const listener of tokenListeners) listener()
  },
  onSessionExpired: () => {
    void sessionExpired()
  },
})

export const endpoints = createEndpoints(api)

export { ApiError } from "./client"
export type { Endpoints } from "./endpoints"
