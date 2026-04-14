import { useEffect } from "react"

import { useCircles } from "@/hooks/queries"
import { useSettingsStore } from "@/stores/settings"

/**
 * Falls back to the first circle when the remembered one is gone, so the map
 * never points at nothing after the user leaves or a circle is deleted.
 */
export function useActiveCircle() {
  const { data: circles, isLoading } = useCircles()
  const activeCircleId = useSettingsStore((state) => state.activeCircleId)
  const setActiveCircle = useSettingsStore((state) => state.setActiveCircle)

  const resolved = circles?.find((circle) => circle.id === activeCircleId) ?? circles?.[0] ?? null

  useEffect(() => {
    if (resolved && resolved.id !== activeCircleId) setActiveCircle(resolved.id)
  }, [resolved, activeCircleId, setActiveCircle])

  return { circle: resolved, circles: circles ?? [], isLoading, setActiveCircle }
}
