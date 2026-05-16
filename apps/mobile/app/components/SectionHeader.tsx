import { Pressable, View, type StyleProp, type ViewStyle } from "react-native"

import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"

export interface SectionHeaderProps {
  tx?: TextProps["tx"]
  text?: string
  txOptions?: TextProps["txOptions"]
  action?: { tx?: TextProps["tx"]; text?: string; onPress: () => void }
  style?: StyleProp<ViewStyle>
}

export function SectionHeader({ tx, text, txOptions, action, style }: SectionHeaderProps) {
  const { theme } = useAppTheme()
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          paddingHorizontal: theme.spacing.md,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.xs,
        },
        style,
      ]}
    >
      <Text
        tx={tx}
        text={text}
        txOptions={txOptions}
        size="xxs"
        weight="semiBold"
        style={{ color: theme.colors.textFaint, letterSpacing: 1.2, textTransform: "uppercase" }}
      />
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text
            tx={action.tx}
            text={action.text}
            size="xs"
            weight="medium"
            style={{ color: theme.colors.tint }}
          />
        </Pressable>
      ) : null}
    </View>
  )
}
