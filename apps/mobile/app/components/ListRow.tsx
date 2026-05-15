import type { ReactNode } from "react"
import { Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import type { IoniconName, Tone } from "@/utils/activity"
import { withAlpha } from "@/utils/color"

import { toneColor } from "./Pill"

export interface ListRowProps {
  tx?: TextProps["tx"]
  text?: string
  txOptions?: TextProps["txOptions"]
  subtitle?: string
  subtitleTx?: TextProps["tx"]
  icon?: IoniconName
  iconTone?: Tone
  onPress?: () => void
  /** Renders a switch instead of a chevron. */
  value?: boolean
  onValueChange?: (value: boolean) => void
  right?: ReactNode
  destructive?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}

export function ListRow({
  tx,
  text,
  txOptions,
  subtitle,
  subtitleTx,
  icon,
  iconTone = "neutral",
  onPress,
  value,
  onValueChange,
  right,
  destructive,
  disabled,
  style,
}: ListRowProps) {
  const { theme } = useAppTheme()
  const color = destructive ? theme.colors.error : toneColor(iconTone, theme.colors)
  const isSwitch = typeof value === "boolean"

  return (
    <Pressable
      onPress={isSwitch ? () => onValueChange?.(!value) : onPress}
      disabled={disabled || (!onPress && !isSwitch)}
      accessibilityRole={isSwitch ? "switch" : "button"}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
          paddingVertical: theme.spacing.sm,
          minHeight: 56,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(color, theme.isDark ? 0.18 : 0.12),
          }}
        >
          <Ionicons name={icon} size={18} color={color} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          tx={tx}
          text={text}
          txOptions={txOptions}
          size="sm"
          weight="medium"
          style={{ color: destructive ? theme.colors.error : theme.colors.text }}
        />
        {subtitle || subtitleTx ? (
          <Text tx={subtitleTx} text={subtitle} size="xs" style={{ color: theme.colors.textDim }} />
        ) : null}
      </View>
      {right}
      {isSwitch ? (
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ true: theme.colors.tint, false: theme.colors.tintInactive }}
          thumbColor="#FFFFFF"
        />
      ) : onPress && !right ? (
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textFaint} />
      ) : null}
    </Pressable>
  )
}

export function ListGroup({
  children,
  style,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const { theme } = useAppTheme()
  return (
    <View
      style={[
        {
          marginHorizontal: theme.spacing.md,
          borderRadius: 20,
          backgroundColor: theme.colors.surface,
          // In dark mode the card sits nine values above the page, which is
          // close enough to invisible that rows read as floating against the
          // screen edge. The hairline is what makes the inset legible.
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}
