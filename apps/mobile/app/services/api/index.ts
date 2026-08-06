import { stopTracking } from "@/services/location/tracker"
import { queryClient } from "@/services/queryClient"
import { realtime } from "@/services/realtime"
import { useAuthStore } from "@/stores/auth"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore } from "@/stores/tracking"

import { ApiClient } from "./client"
import { createEndpoints } from "./endpoints"

export const api = new ApiClient({
  getBaseUrl: () => useAuthStore.getState().serverUrl,
  getDeviceId: () => useAuthStore.getState().deviceId,
  getTokens: () => tokenVault.peek(),
  setTokens: async (tokens) => {
    await tokenVault.set(tokens)
    // The websocket authenticates with the access token in its URL, so a
    // rotated token leaves the open socket holding a dead credential.
    if (tokens) realtime.refresh()
  },
  onSessionExpired: () => {
    // The next account to sign in on this phone must not upload the previous
    // account's queued breadcrumbs.
    void stopTracking()
    useTrackingStore.getState().reset()
    useAuthStore.getState().signedOut()
    queryClient.clear()
  },
})

export const endpoints = createEndpoints(api)

export { ApiError } from "./client"
export type { Endpoints } from "./endpoints"
