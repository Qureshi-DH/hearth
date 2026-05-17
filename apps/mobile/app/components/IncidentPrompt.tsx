import { useEffect, useState } from "react"
import { Modal, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { endpoints } from "@/services/api"
import { reportNow } from "@/services/location/tracker"
import { useIncidentStore } from "@/stores/incident"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { haptics } from "@/utils/haptics"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

/** Long enough to reach a phone after a shock, short enough to still matter. */
const COUNTDOWN_SECONDS = 30

/**
 * Sensors can only say something violent happened, never that it was a crash,
 * so the person gets the final word. Saying nothing is what raises the alarm,
 * because someone hurt badly enough not to answer is exactly the case this
 * exists for.
 */
export function IncidentPrompt() {
  const { themed, theme } = useAppTheme()
  const pending = useIncidentStore((state) => state.pending)
  const clear = useIncidentStore((state) => state.clear)
  const circleId = useSettingsStore((state) => state.activeCircleId)
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS)

  useEffect(() => {
    if (!pending) return
    setRemaining(COUNTDOWN_SECONDS)
    haptics.error()

    const tick = setInterval(() => {
      setRemaining((value) => {
        if (value > 1) return value - 1
        clearInterval(tick)
        void escalate()
        return 0
      })
    }, 1000)

    return () => clearInterval(tick)
    // Only a new incident restarts the countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.detectedAt])

  const escalate = async () => {
    clear()
    if (!circleId) return
    try {
      // A fresh fix first, so the alert carries where they actually are.
      await reportNow("sos")
      await endpoints.safety.raiseSos(circleId, translate("incident:autoNote"))
      toast.success(translate("incident:raised"))
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  if (!pending) return null

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={themed($backdrop)}>
        <View style={themed($card)}>
          <View style={themed($badge)}>
            <Ionicons name="alert" size={30} color={theme.colors.error} />
          </View>

          <Text preset="heading" tx="incident:title" style={{ textAlign: "center" }} />
          <Text
            tx="incident:body"
            size="sm"
            style={{ color: theme.colors.textDim, textAlign: "center", marginTop: 8 }}
          />

          <Text
            weight="bold"
            style={{ fontSize: 44, color: theme.colors.error, marginVertical: 14 }}
          >
            {remaining}
          </Text>

          <PrimaryButton
            tx="incident:imOk"
            onPress={() => {
              haptics.select()
              clear()
            }}
            style={{ alignSelf: "stretch" }}
          />
          <PrimaryButton
            tx="incident:sendNow"
            variant="danger"
            onPress={() => void escalate()}
            style={{ alignSelf: "stretch", marginTop: 10 }}
          />
        </View>
      </View>
    </Modal>
  )
}

const $backdrop: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.7)",
  alignItems: "center",
  justifyContent: "center",
  padding: spacing.lg,
})

const $card: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  width: "100%",
  alignItems: "center",
  backgroundColor: colors.background,
  borderRadius: 28,
  padding: spacing.lg,
})

const $badge: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  width: 60,
  height: 60,
  borderRadius: 30,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.errorBackground,
  marginBottom: spacing.md,
})
