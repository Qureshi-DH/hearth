import type { DriveEvent } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

export interface PendingIncident {
  detectedAt: number
  peakDeltaG: number
  corroborations: number
}

interface IncidentState {
  pending: PendingIncident | null
  raise(event: Extract<DriveEvent, { kind: "possibleImpact" }>): void
  clear(): void
}

/**
 * A detector this sensitive must never alert a family on its own. It puts the
 * incident here, the app asks the person, and only silence escalates.
 *
 * Persisted, because the phone that just took the impact is the one most likely
 * to be restarted by it. An incident that only lived in memory would be lost by
 * the process that comes back, which is the one case the whole feature is for.
 */
export const useIncidentStore = create<IncidentState>()(
  persist(
    (set) => ({
      pending: null,
      raise: (event) =>
        set({
          pending: {
            detectedAt: event.at,
            peakDeltaG: event.peakDeltaG,
            corroborations: event.corroborations,
          },
        }),
      clear: () => set({ pending: null }),
    }),
    { name: "hearth.incident.v1", storage: createJSONStorage(() => mmkvStorage) },
  ),
)
