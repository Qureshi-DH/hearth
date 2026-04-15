import { Pill } from "@/components/Pill"
import type { IoniconName, Tone } from "@/utils/activity"
import { formatBattery } from "@/utils/format"

export interface BatteryPillProps {
  level: number | null | undefined
  charging?: boolean | null
}

export function BatteryPill({ level, charging }: BatteryPillProps) {
  const text = formatBattery(level)
  if (!text || level == null) return null

  let icon: IoniconName = "battery-full"
  let tone: Tone = "neutral"
  if (charging) {
    icon = "battery-charging"
    tone = "success"
  } else if (level <= 0.15) {
    icon = "battery-dead"
    tone = "error"
  } else if (level <= 0.35) {
    icon = "battery-half"
    tone = "warning"
  }

  return <Pill text={text} icon={icon} tone={tone} />
}
