import { useEffect, useState } from "react"
import { Modal, Pressable, View, type ViewStyle } from "react-native"

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
  confirmTx?: TextProps["tx"]
  onCancel: () => void
  onSubmit: (value: string) => void
}

/**
 * Alert.prompt exists on iOS only, so every row built on it was inert on
 * Android with no dialog and no error. This is the cross platform stand in.
 */
export function PromptDialog({
  visible,
  titleTx,
  title,
  initialValue,
  maxLength = 60,
  confirmTx = "common:save",
  onCancel,
  onSubmit,
}: PromptDialogProps) {
  const { themed, theme } = useAppTheme()
  const [value, setValue] = useState(initialValue ?? "")

  // The same dialog is reused for different rows, so each opening starts from
  // that row's current value rather than whatever was typed last time.
  useEffect(() => {
    if (visible) setValue(initialValue ?? "")
  }, [visible, initialValue])

  const submit = () => {
    onSubmit(value.trim())
    onCancel()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={themed($backdrop)} onPress={onCancel}>
        <Pressable style={themed($card)} onPress={() => {}}>
          <Text preset="subheading" tx={titleTx} text={title} />
          <TextField
            value={value}
            onChangeText={setValue}
            autoFocus
            maxLength={maxLength}
            returnKeyType="done"
            onSubmitEditing={submit}
            containerStyle={{ marginTop: theme.spacing.md }}
            inputWrapperStyle={themed($input)}
          />
          <View style={themed($actions)}>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Text tx="common:cancel" style={{ color: theme.colors.textDim }} />
            </Pressable>
            <PrimaryButton tx={confirmTx} onPress={submit} style={{ minWidth: 120 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const $backdrop: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.45)",
  justifyContent: "center",
  padding: spacing.lg,
})

const $card: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  backgroundColor: colors.background,
  borderRadius: 24,
  padding: spacing.lg,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})

const $actions: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: spacing.lg,
  marginTop: spacing.lg,
})
