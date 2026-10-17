import { useEffect, useState } from "react"
import { AppState, Modal, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Text } from "@/components/Text"
import {
  INCIDENT_COUNTDOWN_MS,
  checkIncident,
  dismissIncident,
  escalateIncident,
  incidentPhase,
} from "@/services/incidentAlarm"
import { useIncidentStore } from "@/stores/incident"
import { haptics } from "@/utils/haptics"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

/**
 * Sensors can only say something violent happened, never that it was a crash,
 * so the person gets the final word. Saying nothing is what raises the alarm,
 * because someone hurt badly enough not to answer is exactly the case this
 * exists for.
 *
 * Only the face of it. What the incident needs, and when, is decided in
 * services/incidentAlarm.ts, because this is only mounted while the app is in
 * front and the decision has to be taken on a locked phone too.
 */
export function IncidentPrompt() {
  const { themed, theme } = useAppTheme()
  const pending = useIncidentStore((state) => state.pending)
  const [now, setNow] = useState(() => Date.now())
  const [sending, setSending] = useState(false)

  const detectedAt = pending?.detectedAt ?? 0
  const phase = incidentPhase(pending, now)
  const remaining = pending
    ? Math.max(0, Math.ceil((detectedAt + INCIDENT_COUNTDOWN_MS - now) / 1000))
    : 0

  useEffect(() => {
    if (!detectedAt) return
    haptics.error()
  }, [detectedAt])

  // A wall clock rather than a counter, and the module decides from it. The
  // tick only redraws the number and gives the decision one more moment to be
  // taken while somebody is looking.
  const settled = phase === "stale"
  useEffect(() => {
    if (!detectedAt) return
    const pass = () => {
      setNow(Date.now())
      void checkIncident()
    }
    pass()
    // Past the stale cutoff nothing on this card changes until somebody
    // presses something, and the phone it is open on may sit unattended for
    // hours.
    const tick = settled ? null : setInterval(pass, 500)
    // Going to the background is when the lock screen has to take over.
    const subscription = AppState.addEventListener("change", pass)
    return () => {
      if (tick) clearInterval(tick)
      subscription.remove()
    }
  }, [detectedAt, settled])

  const send = async () => {
    setSending(true)
    try {
      await escalateIncident()
    } finally {
      setSending(false)
    }
  }

  if (!pending) return null

  // "No connection" only once a try has found none.
  const message =
    phase === "stale"
      ? "incident:stale"
      : phase !== "sending"
        ? "incident:body"
        : pending.failure
          ? "incident:waiting"
          : "incident:sending"

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={themed($backdrop)}>
        <View style={themed($card)}>
          <View style={themed($badge)}>
            <Ionicons name="alert" size={30} color={theme.colors.error} />
          </View>

          <Text preset="heading" tx="incident:title" style={{ textAlign: "center" }} />
          <Text
            tx={message}
            size="sm"
            style={{ color: theme.colors.textDim, textAlign: "center", marginTop: 8 }}
          />

          {phase !== "asking" ? (
            <View style={{ height: theme.spacing.md }} />
          ) : (
            <Text
              weight="bold"
              style={{ fontSize: 44, color: theme.colors.error, marginVertical: 14 }}
            >
              {remaining}
            </Text>
          )}

          <PrimaryButton
            tx="incident:imOk"
            onPress={() => {
              haptics.select()
              void dismissIncident()
            }}
            style={{ alignSelf: "stretch" }}
          />
          <PrimaryButton
            tx="incident:sendNow"
            variant="danger"
            loading={sending}
            onPress={() => void send()}
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
