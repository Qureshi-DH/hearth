import { useEffect, useState } from "react"

import { useSettingsStore } from "@/stores/settings"
import { cachedNearby, gridKey, nearby } from "@/utils/geocode"

/**
 * A street name for a spot, or null while the geocoder thinks or has
 * nothing. Off entirely when the person has said they would rather their
 * phone did not ask a geocoder about the family's whereabouts. Reads the
 * cache synchronously so a list scrolled back up does not flicker.
 */
export function useNearby(lat: number | null | undefined, lon: number | null | undefined) {
  const enabled = useSettingsStore((state) => state.streetNames)
  const has = lat != null && lon != null
  const key = has ? gridKey(lat, lon) : null
  const [label, setLabel] = useState<string | null>(() =>
    enabled && has ? (cachedNearby(lat, lon) ?? null) : null,
  )

  useEffect(() => {
    if (!enabled || !has) return
    const known = cachedNearby(lat, lon)
    if (known !== undefined) {
      setLabel(known)
      return
    }
    let current = true
    void nearby(lat, lon).then((found) => {
      if (current) setLabel(found)
    })
    return () => {
      current = false
    }
    // The grid cell is the identity of the spot; the raw coordinates jitter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key])

  return enabled && has ? label : null
}
