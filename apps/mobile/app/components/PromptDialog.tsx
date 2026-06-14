import { useCallback, useEffect, useRef, useState } from "react"
import { View, type TextInputProps, type ViewStyle } from "react-native"
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useSafeAreaInsets } from "react-native-safe-area-context"

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
 * Built on the same bottom sheet as the routes that are presented as sheets,
 * so the two look identical. An earlier version put a plain modal inside a
 * KeyboardAvoidingView, which lifted the panel off the bottom of the screen
 * and left a strip of backdrop showing underneath it once the keyboard opened.
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
  const insets = useSafeAreaInsets()
  const sheet = useRef<BottomSheetModal>(null)
  const [value, setValue] = useState(initialValue ?? "")

  // The same sheet is reused for different rows, so each opening starts from
  // that row's current value rather than whatever was typed last time.
  useEffect(() => {
    if (visible) {
      setValue(initialValue ?? "")
      sheet.current?.present()
    } else {
      sheet.current?.dismiss()
    }
  }, [visible, initialValue])

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  )

  const submit = () => {
    onSubmit(value.trim())
    onCancel()
  }

  return (
    <BottomSheetModal
      ref={sheet}
      enableDynamicSizing
      enablePanDownToClose
      // The sheet rides the keyboard instead of being pushed off the bottom,
      // which is what keeps its background flush with the screen edge.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={onCancel}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive }}
      backgroundStyle={{ backgroundColor: theme.colors.background }}
    >
      <BottomSheetView style={themed($sheet)}>
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
        <View style={{ height: insets.bottom + theme.spacing.md }} />
      </BottomSheetView>
    </BottomSheetModal>
  )
}

const $sheet: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.xs,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
