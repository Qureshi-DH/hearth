import { Modal, Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native"
import { FullWindowOverlay } from "react-native-screens"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { useAlertStore, type AlertButton, type AlertRequest } from "@/stores/alert"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

/**
 * Backing out with the back button or a tap outside means the same as the
 * cancel button, so a caller that put its cleanup on cancel still gets it.
 */
function escapeButton(request: AlertRequest): AlertButton | undefined {
  if (request.buttons.length <= 1) return request.buttons[0]
  return request.buttons.find((button) => button.style === "cancel")
}

/** Mount once at the root. Draws whatever `alert()` last asked for. */
export function AlertHost() {
  const current = useAlertStore((state) => state.current)
  const dismiss = useAlertStore((state) => state.dismiss)
  const { themed, theme } = useAppTheme()

  if (!current) return null

  const choose = (button?: AlertButton) => {
    dismiss()
    button?.onPress?.()
  }
  const escape = () => choose(escapeButton(current))

  const buttons: AlertButton[] =
    current.buttons.length > 0 ? current.buttons : [{ text: translate("common:ok") }]
  // Cancel goes last, under the actions, the way a stacked system alert lays
  // them out. Actions keep the order the caller gave them.
  const actions = buttons.filter((button) => button.style !== "cancel")
  const cancel = buttons.find((button) => button.style === "cancel")

  const card = (
    <Pressable style={themed($backdrop)} onPress={escape} accessibilityRole="none">
      <Pressable style={themed($card)} onPress={() => {}} accessibilityViewIsModal>
        <Text preset="subheading" text={current.title} />
        {current.message ? (
          <Text size="sm" style={{ color: theme.colors.textDim, marginTop: theme.spacing.xs }}>
            {current.message}
          </Text>
        ) : null}
        <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
          {actions.map((button, index) => (
            <PrimaryButton
              key={`${current.id}-${index}`}
              text={button.text}
              variant={
                button.style === "destructive" ? "danger" : index === 0 ? "gradient" : "soft"
              }
              onPress={() => choose(button)}
              style={{ alignSelf: "stretch" }}
            />
          ))}
          {cancel ? (
            <PrimaryButton
              text={cancel.text}
              variant="ghost"
              onPress={() => choose(cancel)}
              style={{ alignSelf: "stretch" }}
            />
          ) : null}
        </View>
      </Pressable>
    </Pressable>
  )

  // An RN Modal is presented from the root view controller, and iOS refuses
  // that while a native modal screen such as SOS is up, so the alert never
  // appeared there and turned up later, once that screen had closed. The
  // overlay is its own window above everything. Android's Modal is a dialog,
  // which is always on top and is what answers the back button.
  if (Platform.OS === "ios") {
    return <FullWindowOverlay>{card}</FullWindowOverlay>
  }
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={escape}>
      {card}
    </Modal>
  )
}

const $backdrop: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  ...StyleSheet.absoluteFillObject,
  backgroundColor: colors.overlay,
  alignItems: "center",
  justifyContent: "center",
  padding: spacing.lg,
})

const $card: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  width: "100%",
  maxWidth: 420,
  backgroundColor: colors.background,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: 28,
  padding: spacing.lg,
})
