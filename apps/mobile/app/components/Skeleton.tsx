import { useEffect, type ReactNode } from "react"
import { View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native"
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated"

import { useAppTheme } from "@/theme/context"

export interface SkeletonProps {
  /** Read out once for the whole placeholder, in place of its shapes. */
  accessibilityLabel: string
  children: ReactNode
  style?: StyleProp<ViewStyle>
}

/**
 * The shape of what is loading, pulsing as one. Every bone breathes together
 * because a page of shapes each on its own clock reads as flicker, not as
 * waiting.
 */
export function Skeleton({ accessibilityLabel, children, style }: SkeletonProps) {
  const reduceMotion = useReducedMotion()
  const opacity = useSharedValue(1)

  useEffect(() => {
    // Held still rather than faded to the far end, which would leave the
    // shapes looking disabled for anyone who has asked for less motion.
    if (reduceMotion) return
    opacity.value = withRepeat(
      withTiming(0.45, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    )
  }, [opacity, reduceMotion])

  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
      style={[style, pulse]}
    >
      {children}
    </Animated.View>
  )
}

export function Bone({
  width,
  height,
  radius = 6,
  style,
}: {
  width: DimensionValue
  height: number
  radius?: number
  style?: StyleProp<ViewStyle>
}) {
  const { theme } = useAppTheme()
  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor: theme.colors.surfaceElevated },
        style,
      ]}
    />
  )
}
