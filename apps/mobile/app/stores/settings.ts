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

  setThemeMode(mode: ThemeMode): void
  setUnits(units: "metric" | "imperial"): void
  setHaptics(enabled: boolean): void
  setActiveCircle(circleId: string | null): void
  setShowTrails(show: boolean): void
  setReduceMotion(reduce: boolean): void
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

      setThemeMode: (themeMode) => set({ themeMode }),
      setUnits: (units) => set({ units }),
      setHaptics: (hapticsEnabled) => set({ hapticsEnabled }),
      setActiveCircle: (activeCircleId) => set({ activeCircleId }),
      setShowTrails: (showTrails) => set({ showTrails }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
    }),
    { name: "hearth.settings.v1", storage: createJSONStorage(() => mmkvStorage) },
  ),
)
