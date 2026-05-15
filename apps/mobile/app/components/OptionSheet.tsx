import { useRef } from "react"
import { Modal, Platform, Pressable, type ViewStyle } from "react-native"
import Animated, { SlideInDown } from "react-native-reanimated"

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
 * a four or five way chooser loses its last options, Cancel included. A list
 * has no such limit and reads the same on both platforms.
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
      <Pressable style={themed($backdrop)} onPress={onClose}>
        <Animated.View entering={SlideInDown.duration(220)}>
          {/* Keeps a tap on the sheet body from reaching the backdrop. */}
          <Pressable style={themed($sheet)} onPress={() => {}}>
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

            <Pressable style={themed($row)} onPress={onClose}>
              <Text tx="common:cancel" style={{ color: theme.colors.textDim }} />
            </Pressable>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  )
}

const $backdrop: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.45)",
  justifyContent: "flex-end",
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
