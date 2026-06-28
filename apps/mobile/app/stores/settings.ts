import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

export type ThemeMode = "system" | "light" | "dark"

interface SettingsState {
  themeMode: ThemeMode
  units: "metric" | "imperial"
  hapticsEnabled: boolean
  activeCircleId: string | null
  showTrails: boolean
  reduceMotion: boolean
  /**
   * Mirrors whether any circle the user belongs to has incident alerts on. The
   * detector runs from a background task where the query cache may be cold, so
   * the answer has to survive a process kill on its own.
   */
  incidentDetection: boolean

  setThemeMode(mode: ThemeMode): void
  setUnits(units: "metric" | "imperial"): void
  setHaptics(enabled: boolean): void
  setActiveCircle(circleId: string | null): void
  setShowTrails(show: boolean): void
  setReduceMotion(reduce: boolean): void
  setIncidentDetection(enabled: boolean): void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      themeMode: "system",
      units: "metric",
      hapticsEnabled: true,
      activeCircleId: null,
      showTrails: true,
      reduceMotion: false,
      incidentDetection: false,

      setThemeMode: (themeMode) => set({ themeMode }),
      setUnits: (units) => set({ units }),
      setHaptics: (hapticsEnabled) => set({ hapticsEnabled }),
      setActiveCircle: (activeCircleId) => set({ activeCircleId }),
      setShowTrails: (showTrails) => set({ showTrails }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setIncidentDetection: (incidentDetection) => set({ incidentDetection }),
    }),
    {
      name: "hearth.settings.v1",
      version: 1,
      storage: createJSONStorage(() => mmkvStorage),
      // v0 carried a per-device switch for the OS motion classifier. The
      // classifier runs whenever tracking does now, and the merge is a shallow
      // spread, so without this the dead key would sit in the blob for good.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<SettingsState> & { nativeMotion?: boolean }
        if (version >= 1) return state as SettingsState
        const { nativeMotion: _dropped, ...rest } = state
        return rest as SettingsState
      },
    },
  ),
)
