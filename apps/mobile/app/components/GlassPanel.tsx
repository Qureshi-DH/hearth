import type { ReactNode } from "react"
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"
import { BlurView } from "expo-blur"

import { useAppTheme } from "@/theme/context"

export interface GlassPanelProps {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  radius?: number
  intensity?: number
}

export function GlassPanel({ children, style, radius = 22, intensity }: GlassPanelProps) {
  const { theme } = useAppTheme()
  const resolvedIntensity = intensity ?? 60

  return (
    <View
      style={[
        {
          borderRadius: radius,
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.glassBorder,
          backgroundColor: theme.colors.glass,
        },
        style,
      ]}
    >
      {/* Android's experimental blur needs a blurTarget we do not have, so blur
          is iOS-only and the tinted backdrop carries legibility there. */}
      {Platform.OS === "ios" && (
        <BlurView
          intensity={resolvedIntensity}
          tint={theme.isDark ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      )}
      {children}
    </View>
  )
}
