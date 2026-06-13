import { useEffect } from "react"
import { Pressable, View } from "react-native"
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Avatar } from "@/components/Avatar"
import { GlassPanel } from "@/components/GlassPanel"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { useNudgeStore } from "@/stores/nudge"
import { useAppTheme } from "@/theme/context"
import { haptics } from "@/utils/haptics"

/**
 * Mount once at the root. A nudge is delivered, read and gone, so this is the
 * only place it is ever shown: it lands on whatever screen the person happens
 * to be looking at, and there is nowhere to go back to it.
 */
export function NudgeBanner() {
  const current = useNudgeStore((state) => state.current)
  const dismiss = useNudgeStore((state) => state.dismiss)
  const insets = useSafeAreaInsets()
  const { theme } = useAppTheme()

  // A phone in a pocket or a hand is the point of this, so it has to be felt
  // as well as seen.
  useEffect(() => {
    if (current) haptics.tap()
  }, [current])

  if (!current) return null

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + 8,
        left: 16,
        right: 16,
        // Over the toast, which shares this slot. Somebody reaching out beats a
        // receipt for something you did yourself.
        zIndex: 1000,
      }}
    >
      <Animated.View
        key={current.id}
        entering={FadeInUp.duration(280).reduceMotion(ReduceMotion.System)}
        exiting={FadeOutUp.duration(200).reduceMotion(ReduceMotion.System)}
      >
        <Pressable onPress={dismiss}>
          <GlassPanel radius={18} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Avatar user={current.from} size={38} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  size="xxs"
                  weight="medium"
                  numberOfLines={1}
                  style={{ color: theme.colors.textDim }}
                >
                  {current.from.displayName}
                </Text>
                <Text
                  size="sm"
                  weight="semiBold"
                  numberOfLines={2}
                  style={{ color: theme.colors.text }}
                >
                  {current.body ?? translate("map:nudgedYou")}
                </Text>
              </View>
            </View>
          </GlassPanel>
        </Pressable>
      </Animated.View>
    </View>
  )
}
