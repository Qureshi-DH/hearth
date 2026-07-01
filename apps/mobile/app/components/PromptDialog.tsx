import { useCallback, useEffect, useRef, useState } from "react"
import { BackHandler, View, type TextInputProps, type ViewStyle } from "react-native"
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SheetTextField } from "@/components/SheetScreen"
import { Text, type TextProps } from "@/components/Text"
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
  // dismiss() on a modal that was never presented leaves the library's status
  // machine stuck in DISMISSING, after which its portal drops every present().
  // Callers mount this with visible false, and the library's own onDismiss
  // arrives after it has reset itself, so dismiss() only runs once a present()
  // has gone through. present() does its work a frame later, so flipping
  // visible true and back inside one frame would still trip it.
  const presented = useRef(false)
  const [value, setValue] = useState(initialValue ?? "")

  // The same sheet is reused for different rows, so each opening starts from
  // that row's current value rather than whatever was typed last time. Only
  // the visible edge resets it: a refetch that changes initialValue while the
  // sheet is open must not present() again or clobber what was typed.
  useEffect(() => {
    if (visible) {
      setValue(initialValue ?? "")
      presented.current = true
      sheet.current?.present()
    } else if (presented.current) {
      sheet.current?.dismiss()
    }
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismiss = () => {
    presented.current = false
    onCancel()
  }

  // The sheet library leaves the Android back button alone, and the native
  // stack underneath answers it by popping the screen, which left the sheet
  // floating over whatever came next. While open, back closes the sheet.
  useEffect(() => {
    if (!visible) return
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel()
      return true
    })
    return () => subscription.remove()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

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
      topInset={insets.top}
      // The sheet offsets itself for the keyboard, which keeps its background
      // flush with the screen edge. It has to, because edge-to-edge stops the
      // OS from resizing the window, so asking for adjustResize here would only
      // make the library stand down and wait for a resize that never comes.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive }}
      backgroundStyle={{ backgroundColor: theme.colors.background }}
    >
      <BottomSheetView style={themed($sheet)}>
        <Text preset="subheading" tx={titleTx} text={title} />
        <SheetTextField
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
