import { Pressable, View, type StyleProp, type ViewStyle } from "react-native"

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

/**
 * A row of ListRows is not a substitute. A list row left-aligns its label and
 * reserves space for a chevron, which reads as a broken button once three sit
 * side by side.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: SegmentedControlProps<T>) {
  const { theme } = useAppTheme()

  return (
    <View
      style={[
        {
          flexDirection: "row",
          padding: 4,
          gap: 4,
          borderRadius: 14,
          backgroundColor: theme.colors.surfaceElevated,
        },
        style,
      ]}
    >
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
              borderRadius: 11,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: active ? theme.colors.tint : "transparent",
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
