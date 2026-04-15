import type { ReactNode } from "react"
import { ActivityIndicator, Pressable, type StyleProp, type ViewStyle } from "react-native"
import { LinearGradient } from "expo-linear-gradient"

import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import { haptics } from "@/utils/haptics"

export interface PrimaryButtonProps {
  tx?: TextProps["tx"]
  text?: string
  txOptions?: TextProps["txOptions"]
  onPress?: () => void
  loading?: boolean
  disabled?: boolean
  /** `gradient` is the hero action, `soft` a tinted secondary, `ghost` text-only. */
  variant?: "gradient" | "soft" | "ghost" | "danger"
  style?: StyleProp<ViewStyle>
  Left?: ReactNode
}

/** One gradient button per screen. Everything else uses `soft` or `ghost`. */
export function PrimaryButton({
  tx,
  text,
  txOptions,
  onPress,
  loading,
  disabled,
  variant = "gradient",
  style,
  Left,
}: PrimaryButtonProps) {
  const { theme } = useAppTheme()
  const isDisabled = disabled || loading

  const textColor =
    variant === "gradient" || variant === "danger"
      ? "#FFFFFF"
      : variant === "soft"
        ? theme.colors.tint
        : theme.colors.textDim

  const body = (
    <>
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <>
          {Left}
          <Text
            tx={tx}
            text={text}
            txOptions={txOptions}
            weight="semiBold"
            size="sm"
            style={{ color: textColor }}
          />
        </>
      )}
    </>
  )

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={() => {
        haptics.tap()
        onPress?.()
      }}
      style={({ pressed }) => [
        {
          borderRadius: 18,
          overflow: "hidden",
          opacity: isDisabled ? 0.55 : pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
        variant === "soft" && { backgroundColor: theme.colors.tintSoft },
        variant === "danger" && { backgroundColor: theme.colors.error },
        style,
      ]}
    >
      {variant === "gradient" ? (
        <LinearGradient
          colors={[theme.colors.gradientStart, theme.colors.gradientEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={$inner}
        >
          {body}
        </LinearGradient>
      ) : (
        <Pressable pointerEvents="none" style={$inner}>
          {body}
        </Pressable>
      )}
    </Pressable>
  )
}

const $inner: ViewStyle = {
  minHeight: 54,
  paddingHorizontal: 20,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
}
