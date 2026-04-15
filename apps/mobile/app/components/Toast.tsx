import { useEffect } from "react"
import { Pressable, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { GlassPanel } from "@/components/GlassPanel"
import { Text } from "@/components/Text"
import { useToastStore } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import { haptics } from "@/utils/haptics"

/** Mount once at the root. Renders whatever `toast.show()` last posted. */
export function ToastHost() {
  const current = useToastStore((state) => state.current)
  const dismiss = useToastStore((state) => state.dismiss)
  const insets = useSafeAreaInsets()
  const { theme } = useAppTheme()

  useEffect(() => {
    if (!current) return
    if (current.tone === "success") haptics.success()
    else if (current.tone === "error") haptics.error()
  }, [current])

  if (!current) return null

  const color =
    current.tone === "success"
      ? theme.colors.success
      : current.tone === "error"
        ? theme.colors.error
        : theme.colors.text

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: insets.top + 8, left: 16, right: 16, zIndex: 999 }}
    >
      <Animated.View
        key={current.id}
        entering={FadeInUp.duration(220)}
        exiting={FadeOutUp.duration(180)}
      >
        <Pressable onPress={dismiss}>
          <GlassPanel radius={16} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Ionicons
                name={
                  current.tone === "success"
                    ? "checkmark-circle"
                    : current.tone === "error"
                      ? "alert-circle"
                      : "information-circle"
                }
                size={20}
                color={color}
              />
              <Text size="xs" weight="medium" style={{ flex: 1, color: theme.colors.text }}>
                {current.message}
              </Text>
            </View>
          </GlassPanel>
        </Pressable>
      </Animated.View>
    </View>
  )
}
