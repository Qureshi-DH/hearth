import { useEffect, useRef } from "react"
import { Modal, Platform, Pressable, View, type ViewStyle } from "react-native"
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler"
import Animated, {
  runOnJS,
  SlideInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated"

import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

export interface SheetOption {
  key: string
  label?: string
  tx?: TextProps["tx"]
  destructive?: boolean
  onPress: () => void
}

export interface OptionSheetProps {
  visible: boolean
  titleTx?: TextProps["tx"]
  title?: string
  options: SheetOption[]
  onClose: () => void
}

/**
 * Android's Alert keeps at most three buttons and silently drops the rest, so
 * a four or five way chooser loses its last options. A list has no such limit
 * and reads the same on both platforms.
 *
 * There is no Cancel row. The grabber and the backdrop both dismiss it, and a
 * row that only means "never mind" is noise next to the real choices.
 */
export function OptionSheet({ visible, titleTx, title, options, onClose }: OptionSheetProps) {
  const { themed, theme } = useAppTheme()

  /**
   * iOS refuses to present anything while a modal is still dismissing, so an
   * option that opens the photo picker did nothing at all. Hold the action and
   * run it once the sheet has actually gone.
   */
  const pending = useRef<(() => void) | null>(null)
  const runPending = () => {
    const action = pending.current
    pending.current = null
    action?.()
  }

  // The grabber promises the sheet can be dragged away, so it has to be true.
  const drag = useSharedValue(0)
  useEffect(() => {
    if (visible) drag.value = 0
  }, [visible, drag])

  const swipeAway = Gesture.Pan()
    .onUpdate((event) => {
      drag.value = Math.max(0, event.translationY)
    })
    .onEnd((event) => {
      if (event.translationY > 90 || event.velocityY > 700) runOnJS(onClose)()
      else drag.value = withTiming(0, { duration: 160 })
    })

  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }))

  const choose = (action: () => void) => {
    pending.current = action
    onClose()
    if (Platform.OS !== "ios") runPending()
  }

  return (
    <Modal
      visible={visible}
      transparent
      // Sliding the whole modal drags the backdrop up with it, which reads
      // nothing like the bottom sheet used everywhere else. Fade the backdrop
      // and let the panel do the sliding.
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={runPending}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable style={themed($backdrop)} onPress={onClose}>
          <GestureDetector gesture={swipeAway}>
            <Animated.View entering={SlideInDown.duration(220)} style={dragStyle}>
              {/* Keeps a tap on the sheet body from reaching the backdrop. */}
              <Pressable style={themed($sheet)} onPress={() => {}}>
                <View style={themed($grabber)} />
                {titleTx || title ? (
                  <Text preset="subheading" tx={titleTx} text={title} style={themed($title)} />
                ) : null}

                {options.map((option) => (
                  <Pressable
                    key={option.key}
                    style={themed($row)}
                    onPress={() => choose(option.onPress)}
                  >
                    <Text
                      tx={option.tx}
                      text={option.label}
                      style={{ color: option.destructive ? theme.colors.error : theme.colors.text }}
                    />
                  </Pressable>
                ))}
              </Pressable>
            </Animated.View>
          </GestureDetector>
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  )
}

const $backdrop: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.45)",
  justifyContent: "flex-end",
})

const $grabber: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  alignSelf: "center",
  width: 44,
  height: 4,
  borderRadius: 2,
  backgroundColor: colors.tintInactive,
  marginBottom: spacing.sm,
})

const $sheet: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  backgroundColor: colors.background,
  borderTopLeftRadius: 28,
  borderTopRightRadius: 28,
  paddingTop: spacing.md,
  paddingBottom: spacing.xl,
  paddingHorizontal: spacing.lg,
})

const $title: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginBottom: spacing.xs,
})

const $row: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  paddingVertical: spacing.md,
  borderTopWidth: 1,
  borderTopColor: colors.border,
})
