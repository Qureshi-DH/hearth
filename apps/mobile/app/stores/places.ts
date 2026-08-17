import { haversineMeters } from "@hearth/shared"
import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { mmkvStorage } from "./mmkv"

/**
 * The circles' places, kept on the phone for the tracker. Arriving somewhere
 * the family named is the moment they want to hear about, and the fix that
 * crosses into the circle used to sit behind the upload gate until the park
 * fix went out minutes later. With the places here the tracker uploads the
 * crossing fix at once. The map fills this whenever it loads places; the
 * tracker refreshes it on its own when it is a day old, so a phone that is
 * never opened still knows where home is.
 */
export interface PlaceLite {
  id: string
  lat: number
  lon: number
  radiusMeters: number
}

interface PlacesState {
  byCircle: Record<string, PlaceLite[]>
  /** ISO time the tracker last fetched every circle's places itself. */
  refreshedAt: string | null
  setPlaces(circleId: string, places: PlaceLite[]): void
  setRefreshedAt(at: string): void
  reset(): void
}

export const usePlacesStore = create<PlacesState>()(
  persist(
    (set) => ({
      byCircle: {},
      refreshedAt: null,
      setPlaces: (circleId, places) =>
        set((state) => ({
          byCircle: {
            ...state.byCircle,
            [circleId]: places.map(({ id, lat, lon, radiusMeters }) => ({
              id,
              lat,
              lon,
              radiusMeters,
            })),
          },
        })),
      setRefreshedAt: (refreshedAt) => set({ refreshedAt }),
      reset: () => set({ byCircle: {}, refreshedAt: null }),
    }),
    { name: "hearth.places.v1", storage: createJSONStorage(() => mmkvStorage) },
  ),
)

/** Every known place, across circles. */
export function knownPlaces(): PlaceLite[] {
  return Object.values(usePlacesStore.getState().byCircle).flat()
}

/** The ids of the places a point is inside. */
export function placesAround(
  point: { lat: number; lon: number },
  places = knownPlaces(),
): Set<string> {
  const inside = new Set<string>()
  for (const place of places) {
    if (haversineMeters(point, place) <= place.radiusMeters) inside.add(place.id)
  }
  return inside
}

/** Whether moving from one point to the other enters or leaves any known place. */
export function crossesPlace(
  from: { lat: number; lon: number } | null,
  to: { lat: number; lon: number },
  places = knownPlaces(),
): boolean {
  if (!from || places.length === 0) return false
  const before = placesAround(from, places)
  const after = placesAround(to, places)
  if (before.size !== after.size) return true
  for (const id of after) if (!before.has(id)) return true
  return false
}
