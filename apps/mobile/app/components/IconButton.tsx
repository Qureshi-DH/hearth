import { Pressable, type StyleProp, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { GlassPanel } from "@/components/GlassPanel"
import { useAppTheme } from "@/theme/context"
import type { IoniconName } from "@/utils/activity"
import { haptics } from "@/utils/haptics"

export interface IconButtonProps {
  icon: IoniconName
  onPress?: () => void
  accessibilityLabel: string
  size?: number
  tone?: "glass" | "tint" | "plain" | "danger" | "surface"
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  color?: string
}

/** `glass` floats over the map, `tint` is the primary action. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 44,
  tone = "surface",
  disabled,
  style,
  color,
}: IconButtonProps) {
  const { theme } = useAppTheme()
  const iconSize = Math.round(size * 0.5)

  const backgroundColor =
    tone === "tint"
      ? theme.colors.tint
      : tone === "danger"
        ? theme.colors.error
        : tone === "surface"
          ? theme.colors.surface
          : "transparent"

  const iconColor =
    color ??
    (tone === "tint" || tone === "danger"
      ? theme.colors.onTint
      : tone === "glass"
        ? theme.colors.text
        : theme.colors.text)

  const content = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={() => {
        haptics.tap()
        onPress?.()
      }}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tone === "glass" ? "transparent" : backgroundColor,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        tone === "surface" && {
          shadowColor: "#000",
          shadowOpacity: theme.isDark ? 0.4 : 0.12,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 4,
        },
        tone !== "glass" && style,
      ]}
    >
      <Ionicons name={icon} size={iconSize} color={iconColor} />
    </Pressable>
  )

  if (tone === "glass") {
    return (
      <GlassPanel radius={size / 2} style={[{ width: size, height: size }, style]}>
        {content}
      </GlassPanel>
    )
  }

  return content
}
