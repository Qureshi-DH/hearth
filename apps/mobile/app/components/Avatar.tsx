import { View, type StyleProp, type ViewStyle } from "react-native"
import { Image } from "expo-image"
import type { PublicUser } from "@hearth/shared"

import { Text } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import { onColor } from "@/utils/color"
import { initials } from "@/utils/format"

export type AvatarRing = "none" | "self" | "sos" | "stale" | "approximate"

export interface AvatarProps {
  user: Pick<PublicUser, "displayName" | "avatarColor" | "avatarUrl">
  size?: number
  ring?: AvatarRing
  style?: StyleProp<ViewStyle>
}

/**
 * The ring is the main status signal on the map, so each state carries its own
 * colour and its own line style rather than colour alone.
 */
export function Avatar({ user, size = 44, ring = "none", style }: AvatarProps) {
  const { theme } = useAppTheme()
  const ringWidth = ring === "none" ? 0 : Math.max(2, Math.round(size / 16))
  const ringColor =
    ring === "self"
      ? theme.colors.self
      : ring === "sos"
        ? theme.colors.error
        : ring === "stale"
          ? theme.colors.textFaint
          : ring === "approximate"
            ? theme.colors.warning
            : "transparent"

  const inner = size - ringWidth * 2 - (ring === "none" ? 0 : 4)
  const fontSize = Math.max(10, Math.round(inner * 0.4))

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: ringWidth,
          borderColor: ringColor,
          borderStyle: ring === "approximate" ? "dashed" : "solid",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface,
        },
        style,
      ]}
    >
      {user.avatarUrl ? (
        <Image
          source={{ uri: user.avatarUrl }}
          style={{ width: inner, height: inner, borderRadius: inner / 2 }}
          contentFit="cover"
          transition={150}
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={{
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            backgroundColor: user.avatarColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            weight="semiBold"
            style={{ color: onColor(user.avatarColor), fontSize, lineHeight: fontSize * 1.2 }}
          >
            {initials(user.displayName)}
          </Text>
        </View>
      )}
    </View>
  )
}
