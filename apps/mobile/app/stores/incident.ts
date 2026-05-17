import type { DriveEvent } from "@hearth/shared"
import { create } from "zustand"

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
 */
export const useIncidentStore = create<IncidentState>()((set) => ({
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
}))
