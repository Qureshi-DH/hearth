import { View, type StyleProp, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { Text } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import type { IoniconName, Tone } from "@/utils/activity"
import { withAlpha } from "@/utils/color"

export interface PillProps {
  text: string
  tone?: Tone
  icon?: IoniconName
  size?: "sm" | "md"
  style?: StyleProp<ViewStyle>
}

export function toneColor(
  tone: Tone,
  colors: ReturnType<typeof useAppTheme>["theme"]["colors"],
): string {
  switch (tone) {
    case "tint":
      return colors.tint
    case "success":
      return colors.success
    case "warning":
      return colors.warning
    case "error":
      return colors.error
    case "info":
      return colors.info
    default:
      return colors.textDim
  }
}

export function Pill({ text, tone = "neutral", icon, size = "sm", style }: PillProps) {
  const { theme } = useAppTheme()
  const color = toneColor(tone, theme.colors)
  const padded = size === "md"

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: padded ? 10 : 8,
          paddingVertical: padded ? 5 : 3,
          borderRadius: 999,
          backgroundColor: withAlpha(color, theme.isDark ? 0.18 : 0.12),
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={padded ? 14 : 12} color={color} /> : null}
      <Text size="xxs" weight="medium" style={{ color, lineHeight: 16 }}>
        {text}
      </Text>
    </View>
  )
}
