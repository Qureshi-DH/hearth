import type { DriveEvent } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

/** Which notification is up for the incident, so a pass that changes nothing posts nothing. */
export type IncidentNotice = "countdown" | "waiting" | "stale"

export interface PendingIncident {
  detectedAt: number
  peakDeltaG: number
  corroborations: number
  /** The account signed in when it happened. Another one signed in since does not raise it. */
  userId?: string | null
  /**
   * When the alert was decided on, by the countdown or by the person. From
   * then on it is an SOS waiting for a connection, not a question.
   */
  escalatedAt?: number | null
  /** The last attempt to send it, so a phone with no signal is not retrying on every fix. */
  triedAt?: number | null
  attempts?: number
  /**
   * Why the last attempt failed. Only a request that never reached Hearth is
   * tried again the moment an upload gets through. One Hearth answered, a 429
   * or a 5xx, waits its turn.
   */
  failure?: "network" | "server" | null
  /** Not persisted. A reboot clears every notification, and this has to say so. */
  notice?: IncidentNotice | null
}

interface IncidentState {
  pending: PendingIncident | null
  raise(event: Extract<DriveEvent, { kind: "possibleImpact" }>, userId?: string | null): void
  update(patch: Partial<PendingIncident>): void
  clear(): void
}

/**
 * A detector this sensitive must never alert a family on its own. It puts the
 * incident here, the app asks the person, and only silence escalates.
 *
 * Persisted, because the phone that just took the impact is the one most likely
 * to be restarted by it. An incident that only lived in memory would be lost by
 * the process that comes back, which is the one case the whole feature is for.
 * The same goes for an alert decided on with no signal to send it. It stays
 * here until it goes, see services/incidentAlarm.ts.
 */
export const useIncidentStore = create<IncidentState>()(
  persist(
    (set) => ({
      pending: null,
      raise: (event, userId) =>
        set((state) =>
          // A second jolt must not turn an alert already on its way back into a question.
          state.pending?.escalatedAt
            ? state
            : {
                pending: {
                  detectedAt: event.at,
                  peakDeltaG: event.peakDeltaG,
                  corroborations: event.corroborations,
                  userId: userId ?? null,
                  escalatedAt: null,
                  triedAt: null,
                  attempts: 0,
                  failure: null,
                  notice: null,
                },
              },
        ),
      update: (patch) =>
        set((state) => (state.pending ? { pending: { ...state.pending, ...patch } } : state)),
      clear: () => set({ pending: null }),
    }),
    {
      name: "hearth.incident.v1",
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        pending: state.pending ? { ...state.pending, notice: null } : null,
      }),
    },
  ),
)
