import { useEffect, useState } from "react"
import { Modal, Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native"
import Animated, { Easing, FadeIn, FadeOut, Keyframe } from "react-native-reanimated"
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

// Quick enough that a tap feels answered, slow enough not to pop. The card
// settles from slightly small, the way the system alert does.
const ENTER_MS = 160
const EXIT_MS = 120
const cardIn = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.94 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.quad) },
}).duration(ENTER_MS)

/** Mount once at the root. Draws whatever `alert()` last asked for. */
export function AlertHost() {
  const current = useAlertStore((state) => state.current)
  const dismiss = useAlertStore((state) => state.dismiss)
  const { themed, theme } = useAppTheme()

  // What is on screen lags the store by one exit animation, otherwise the
  // host would unmount before the card had a chance to fade.
  const [shown, setShown] = useState(current)
  useEffect(() => {
    if (current) {
      setShown(current)
      return
    }
    const timer = setTimeout(() => setShown(null), EXIT_MS)
    return () => clearTimeout(timer)
  }, [current])

  if (!shown) return null
  const request = shown
  const closing = current?.id !== request.id

  const choose = (button?: AlertButton) => {
    if (closing) return
    dismiss()
    button?.onPress?.()
  }
  const escape = () => choose(escapeButton(request))

  const buttons: AlertButton[] =
    request.buttons.length > 0 ? request.buttons : [{ text: translate("common:ok") }]
  // Cancel goes last, under the actions, the way a stacked system alert lays
  // them out. Actions keep the order the caller gave them.
  const actions = buttons.filter((button) => button.style !== "cancel")
  const cancel = buttons.find((button) => button.style === "cancel")

  // Unmounting the animated views is what plays their exit, so while closing
  // they are gone and only the host lingers for the length of the fade.
  const card = closing ? null : (
    <Animated.View
      style={themed($backdrop)}
      entering={FadeIn.duration(ENTER_MS)}
      exiting={FadeOut.duration(EXIT_MS)}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={escape} accessibilityRole="none" />
      <Animated.View
        entering={cardIn}
        exiting={FadeOut.duration(EXIT_MS)}
        style={themed($card)}
        accessibilityViewIsModal
      >
        <Text preset="subheading" text={request.title} />
        {request.message ? (
          <Text size="sm" style={{ color: theme.colors.textDim, marginTop: theme.spacing.xs }}>
            {request.message}
          </Text>
        ) : null}
        <View style={{ marginTop: theme.spacing.lg, gap: theme.spacing.sm }}>
          {actions.map((button, index) => (
            <PrimaryButton
              key={`${request.id}-${index}`}
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
      </Animated.View>
    </Animated.View>
  )

  // An RN Modal is presented from the root view controller, and iOS refuses
  // that while a native modal screen such as SOS is up, so the alert never
  // appeared there and turned up later, once that screen had closed. The
  // overlay is its own window above everything. Android's Modal is a dialog,
  // which is always on top and is what answers the back button. Neither
  // animates on its own, the views inside do.
  if (Platform.OS === "ios") {
    return <FullWindowOverlay>{card}</FullWindowOverlay>
  }
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={escape}>
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
