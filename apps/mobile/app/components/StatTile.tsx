import { View, type StyleProp, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { Text } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import type { IoniconName } from "@/utils/activity"

export interface StatTileProps {
  label: string
  value: string
  icon?: IoniconName
  style?: StyleProp<ViewStyle>
}

export function StatTile({ label, value, icon, style }: StatTileProps) {
  const { theme } = useAppTheme()
  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: theme.colors.surface,
          borderRadius: 18,
          padding: theme.spacing.sm,
          gap: 4,
          minWidth: 100,
        },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={16} color={theme.colors.tint} /> : null}
      <Text weight="semiBold" size="md" numberOfLines={1}>
        {value}
      </Text>
      <Text size="xxs" style={{ color: theme.colors.textDim }}>
        {label}
      </Text>
    </View>
  )
}
