import { memo, useEffect } from "react"
import { Pressable, View } from "react-native"
import type { MemberPresence, PublicUser } from "@hearth/shared"
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated"

import { Avatar, type AvatarRing } from "@/components/Avatar"
import { Text } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import { withAlpha } from "@/utils/color"

/**
 * The name pill sits below the pointer tip, so a marker anchored by its bottom
 * edge is pushed this far up and the pill, not the pointer, lands on the
 * coordinate. Callers pass it back as the marker's pixel offset.
 */
export const MEMBER_MARKER_LABEL_HEIGHT = 24

export interface MemberMarkerProps {
  user: Pick<PublicUser, "displayName" | "avatarColor" | "avatarUrl">
  label: string
  presence: MemberPresence
  ring: AvatarRing
  selected?: boolean
  onPress?: (userId: string) => void
}

/**
 * A circle can have a dozen of these moving at once, so the only animation is
 * the SOS pulse and it runs on the UI thread. Memoised because one member
 * moving pushes a new presence array, and every other marker's props are
 * unchanged by it.
 */
export const MemberMarker = memo(function MemberMarker({
  user,
  label,
  presence,
  ring,
  selected,
  onPress,
}: MemberMarkerProps) {
  const { theme } = useAppTheme()
  const pulse = useSharedValue(0)
  const isSos = Boolean(presence.sosAlertId)

  useEffect(() => {
    if (isSos) {
      pulse.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = 0
    }
  }, [isSos, pulse])

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 1.6 }],
  }))

  const size = selected ? 56 : 46
  const faded = presence.stale && !isSos

  return (
    <Pressable
      onPress={() => onPress?.(presence.userId)}
      hitSlop={8}
      testID={`member-marker-${presence.userId}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ alignItems: "center", opacity: faded ? 0.65 : 1 }}
    >
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        {isSos ? (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: theme.colors.error,
              },
              pulseStyle,
            ]}
          />
        ) : null}
        <View
          style={{
            borderRadius: size / 2,
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
          }}
        >
          <Avatar user={user} size={size} ring={ring === "none" ? "self" : ring} />
        </View>
      </View>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 6,
          borderRightWidth: 6,
          borderTopWidth: 8,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderTopColor: theme.colors.surface,
          marginTop: -2,
        }}
      />
      <View
        style={{
          marginTop: 2,
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 8,
          backgroundColor: withAlpha(theme.isDark ? "#000000" : "#FFFFFF", 0.75),
        }}
      >
        <Text
          size="xxs"
          weight="semiBold"
          numberOfLines={1}
          style={{ color: theme.colors.text, maxWidth: 110 }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  )
})
