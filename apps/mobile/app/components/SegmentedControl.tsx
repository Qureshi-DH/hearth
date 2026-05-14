import { useEffect, useState } from "react"
import {
  Pressable,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native"
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated"

import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import { haptics } from "@/utils/haptics"

export interface SegmentOption<T extends string> {
  value: T
  label?: string
  tx?: TextProps["tx"]
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  style?: StyleProp<ViewStyle>
}

const PADDING = 4
const GAP = 4
const RADIUS = 11

/**
 * A row of ListRows is not a substitute. A list row left-aligns its label and
 * reserves space for a chevron, which reads as a broken button once three sit
 * side by side.
 *
 * The selection is one moving pill rather than a background toggled on each
 * option, so the eye follows it from the old choice to the new one instead of
 * having to find where it went.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: SegmentedControlProps<T>) {
  const { theme } = useAppTheme()
  const [trackWidth, setTrackWidth] = useState(0)

  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  const segment =
    trackWidth > 0 ? (trackWidth - PADDING * 2 - GAP * (options.length - 1)) / options.length : 0

  const offset = useSharedValue(0)
  const ready = useSharedValue(0)

  useEffect(() => {
    if (segment <= 0) return
    const target = PADDING + index * (segment + GAP)
    // The first paint knows the position already, so only later changes slide.
    if (ready.value === 0) {
      offset.value = target
      ready.value = 1
      return
    }
    offset.value = withTiming(target, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    })
  }, [index, segment, offset, ready])

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }))

  const onLayout = (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width)

  return (
    <View
      onLayout={onLayout}
      style={[
        {
          flexDirection: "row",
          padding: PADDING,
          gap: GAP,
          borderRadius: 14,
          backgroundColor: theme.colors.surfaceElevated,
        },
        style,
      ]}
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: PADDING,
              bottom: PADDING,
              left: 0,
              width: segment,
              borderRadius: RADIUS,
              backgroundColor: theme.colors.tint,
            },
            pill,
          ]}
        />
      ) : null}

      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              haptics.select()
              onChange(option.value)
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 38,
              borderRadius: RADIUS,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed && !active ? 0.6 : 1,
            })}
          >
            <Text
              tx={option.tx}
              text={option.label}
              size="xs"
              weight={active ? "semiBold" : "medium"}
              style={{ color: active ? theme.colors.onTint : theme.colors.textDim }}
            />
          </Pressable>
        )
      })}
    </View>
  )
}
