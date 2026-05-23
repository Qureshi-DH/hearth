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
    { name: "hearth.settings.v1", storage: createJSONStorage(() => mmkvStorage) },
  ),
)
