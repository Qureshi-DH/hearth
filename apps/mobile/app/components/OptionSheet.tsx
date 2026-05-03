import { Modal, Pressable, type ViewStyle } from "react-native"

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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={themed($backdrop)} onPress={onClose}>
        <Pressable style={themed($sheet)} onPress={() => {}}>
          {titleTx || title ? (
            <Text preset="subheading" tx={titleTx} text={title} style={themed($title)} />
          ) : null}

          {options.map((option) => (
            <Pressable
              key={option.key}
              style={themed($row)}
              onPress={() => {
                onClose()
                option.onPress()
              }}
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
