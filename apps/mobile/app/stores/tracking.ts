import type { LocationFixInput } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

export type PermissionLevel = "unknown" | "denied" | "foreground" | "always"

export interface TrackingPolicy {
  minUpdateIntervalSeconds: number
  distanceFilterMeters: number
}

interface TrackingState {
  /** The user's master switch. Off means no location leaves the phone. */
  enabled: boolean
  permission: PermissionLevel
  backgroundActive: boolean
  /** Android only. Records that the dialog was shown, not that it was granted. */
  batteryExemptionRequested: boolean
  onboardedPermissions: boolean
  policy: TrackingPolicy
  lastFix: LocationFixInput | null
  lastUploadAt: string | null
  lastError: string | null
  queue: LocationFixInput[]
  /** What the server accepted, not what was sent. */
  uploadedCount: number

  setEnabled(enabled: boolean): void
  setPermission(level: PermissionLevel): void
  setBackgroundActive(active: boolean): void
  setBatteryExemptionRequested(value: boolean): void
  setOnboardedPermissions(value: boolean): void
  setPolicy(policy: TrackingPolicy): void
  enqueue(fixes: LocationFixInput[]): void
  dequeue(fixes: LocationFixInput[]): void
  recordUpload(accepted: number): void
  setError(message: string | null): void
  reset(): void
}

/** An offline week of breadcrumbs must not blow up storage. The newest win. */
const MAX_QUEUE = 2000

export const useTrackingStore = create<TrackingState>()(
  persist(
    (set, get) => ({
      enabled: true,
      permission: "unknown",
      backgroundActive: false,
      batteryExemptionRequested: false,
      onboardedPermissions: false,
      policy: { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 },
      lastFix: null,
      lastUploadAt: null,
      lastError: null,
      queue: [],
      uploadedCount: 0,

      setEnabled: (enabled) => set({ enabled }),
      setPermission: (permission) => set({ permission }),
      setBackgroundActive: (backgroundActive) => set({ backgroundActive }),
      setBatteryExemptionRequested: (batteryExemptionRequested) =>
        set({ batteryExemptionRequested }),
      setOnboardedPermissions: (onboardedPermissions) => set({ onboardedPermissions }),
      setPolicy: (policy) => set({ policy }),
      enqueue: (fixes) => {
        const merged = [...get().queue, ...fixes]
        set({
          queue: merged.length > MAX_QUEUE ? merged.slice(merged.length - MAX_QUEUE) : merged,
          lastFix: fixes[fixes.length - 1] ?? get().lastFix,
        })
      },
      dequeue: (fixes) => {
        // Match by timestamp, not position. `enqueue` may have trimmed the head
        // while an upload was in flight, and a positional slice would then throw
        // away fixes that were never sent.
        const sent = new Set(fixes.map((fix) => fix.recordedAt))
        set({ queue: get().queue.filter((fix) => !sent.has(fix.recordedAt)) })
      },
      recordUpload: (accepted) =>
        set({
          lastUploadAt: new Date().toISOString(),
          lastError: null,
          uploadedCount: get().uploadedCount + accepted,
        }),
      setError: (lastError) => set({ lastError }),
      reset: () =>
        set({
          backgroundActive: false,
          lastFix: null,
          lastUploadAt: null,
          lastError: null,
          queue: [],
          uploadedCount: 0,
        }),
    }),
    {
      name: "hearth.tracking.v1",
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        permission: state.permission,
        batteryExemptionRequested: state.batteryExemptionRequested,
        onboardedPermissions: state.onboardedPermissions,
        policy: state.policy,
        queue: state.queue,
        lastFix: state.lastFix,
        lastUploadAt: state.lastUploadAt,
      }),
    },
  ),
)
