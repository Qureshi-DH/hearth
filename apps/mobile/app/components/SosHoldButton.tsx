import { useEffect } from "react"
import { Pressable, StyleSheet, View } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated"
import Svg, { Circle } from "react-native-svg"

import { Text } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import { haptics } from "@/utils/haptics"

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

export interface SosHoldButtonProps {
  holdMs?: number
  size?: number
  active?: boolean
  onActivate: () => void
  label: string
  hint: string
}

/**
 * A plain tap is far too easy to hit by accident in a pocket. Three seconds of
 * visible progress is the standard pattern for something that wakes up your
 * whole family.
 */
export function SosHoldButton({
  holdMs = 3000,
  size = 180,
  active = false,
  onActivate,
  label,
  hint,
}: SosHoldButtonProps) {
  const { theme } = useAppTheme()
  const progress = useSharedValue(0)
  const pulse = useSharedValue(1)
  const stroke = 8
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius

  useEffect(() => {
    if (active) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.06, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = withTiming(1)
    }
  }, [active, pulse])

  const fire = () => {
    haptics.heavy()
    onActivate()
  }

  const start = () => {
    if (active) return
    haptics.tap()
    progress.value = 0
    progress.value = withTiming(1, { duration: holdMs, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(fire)()
    })
  }

  const cancel = () => {
    cancelAnimation(progress)
    if (progress.value < 1) progress.value = withTiming(0, { duration: 180 })
  }

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }))

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value * (1 - progress.value * 0.04) }],
  }))

  return (
    <View style={{ alignItems: "center", gap: theme.spacing.md }}>
      <Pressable
        onPressIn={start}
        onPressOut={cancel}
        disabled={active}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        // Press-and-hold is not reachable from TalkBack or VoiceOver, so expose
        // an explicit action and screen-reader users can still raise an alert.
        accessibilityActions={[{ name: "activate", label }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "activate" && !active) fire()
        }}
      >
        <Animated.View style={[{ width: size, height: size }, scaleStyle]}>
          <LinearGradient
            colors={
              active
                ? [theme.colors.error, theme.colors.gradientEnd]
                : [theme.colors.gradientStart, theme.colors.gradientEnd]
            }
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: theme.colors.gradientEnd,
              shadowOpacity: 0.45,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 10 },
              elevation: 12,
            }}
          >
            <Ionicons name={active ? "radio" : "alert"} size={size * 0.3} color="#FFFFFF" />
            <Text weight="bold" size="md" style={{ color: "#FFFFFF", marginTop: 4 }}>
              SOS
            </Text>
          </LinearGradient>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={stroke}
              fill="none"
            />
            <AnimatedCircle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke="#FFFFFF"
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${circumference} ${circumference}`}
              animatedProps={ringProps}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </Svg>
        </Animated.View>
      </Pressable>
      <Text size="xs" style={{ color: theme.colors.textDim, textAlign: "center" }}>
        {active ? hint : label}
      </Text>
    </View>
  )
}
