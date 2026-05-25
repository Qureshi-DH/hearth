import { useEffect, useState } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native"
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler"
import Animated, {
  runOnJS,
  SlideInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Text, type TextProps } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

export interface PromptDialogProps {
  visible: boolean
  titleTx?: TextProps["tx"]
  title?: string
  initialValue?: string
  maxLength?: number
  keyboardType?: TextInputProps["keyboardType"]
  helper?: string
  confirmTx?: TextProps["tx"]
  onCancel: () => void
  onSubmit: (value: string) => void
}

/**
 * Alert.prompt exists on iOS only, so every row built on it was inert on
 * Android with no dialog and no error. This is the cross platform stand in.
 *
 * Shaped as a bottom sheet rather than a centred card so that asking for one
 * value looks like every other thing this app slides up from the bottom. A row
 * that opens a dialog next to a row that opens a sheet reads as two different
 * apps.
 */
export function PromptDialog({
  visible,
  titleTx,
  title,
  initialValue,
  maxLength = 60,
  keyboardType,
  helper,
  confirmTx = "common:save",
  onCancel,
  onSubmit,
}: PromptDialogProps) {
  const { themed, theme } = useAppTheme()
  const [value, setValue] = useState(initialValue ?? "")

  // The same sheet is reused for different rows, so each opening starts from
  // that row's current value rather than whatever was typed last time.
  useEffect(() => {
    if (visible) setValue(initialValue ?? "")
  }, [visible, initialValue])

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
      if (event.translationY > 90 || event.velocityY > 700) runOnJS(onCancel)()
      else drag.value = withTiming(0, { duration: 160 })
    })

  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }))

  const submit = () => {
    onSubmit(value.trim())
    onCancel()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          // Android resizes the window for the keyboard on its own, and
          // stacking a behavior on top of that shifts the sheet twice.
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={themed($backdrop)} onPress={onCancel}>
            <GestureDetector gesture={swipeAway}>
              <Animated.View entering={SlideInDown.duration(220)} style={dragStyle}>
                {/* Keeps a tap on the sheet body from reaching the backdrop. */}
                <Pressable style={themed($sheet)} onPress={() => {}}>
                  <View style={themed($grabber)} />
                  <Text preset="subheading" tx={titleTx} text={title} />
                  <TextField
                    value={value}
                    onChangeText={setValue}
                    autoFocus
                    maxLength={maxLength}
                    keyboardType={keyboardType}
                    helper={helper}
                    returnKeyType="done"
                    onSubmitEditing={submit}
                    containerStyle={{ marginTop: theme.spacing.md }}
                    inputWrapperStyle={themed($input)}
                  />
                  <PrimaryButton
                    tx={confirmTx}
                    onPress={submit}
                    style={{ alignSelf: "stretch", marginTop: theme.spacing.md }}
                  />
                </Pressable>
              </Animated.View>
            </GestureDetector>
          </Pressable>
        </KeyboardAvoidingView>
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

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
