import { useCallback, useEffect, useRef, useState } from "react"
import { AppState, Modal, View, type ViewStyle } from "react-native"
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
const COUNTDOWN_MS = 30_000
/**
 * Beyond this the phone can no longer vouch for where the person is: they may
 * have walked away, been driven off, or the process may only now be coming back
 * from a restart. Raising an SOS on a location from a different quarter of an
 * hour would send help to the wrong place, so past here it stops being
 * automatic and goes back to being their decision.
 */
const STALE_MS = 5 * 60_000
/**
 * And past this it is not a question worth asking. The incident survives a
 * restart on purpose, but a phone that comes back long afterwards should not
 * open on "are you okay?" about something the person plainly walked away from.
 */
const FORGET_MS = 60 * 60_000

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
  const [now, setNow] = useState(() => Date.now())
  const [sending, setSending] = useState(false)
  const autoTried = useRef(false)

  const detectedAt = pending?.detectedAt ?? 0
  const remaining = pending ? Math.max(0, Math.ceil((detectedAt + COUNTDOWN_MS - now) / 1000)) : 0
  const stale = pending ? now - detectedAt > STALE_MS : false

  const escalate = useCallback(async () => {
    if (!circleId) {
      clear()
      return
    }
    setSending(true)
    try {
      // A fresh fix first, so the alert carries where they actually are, and
      // only then clear: an incident dropped before anything was sent is an
      // alarm that silently never happened.
      await reportNow("sos")
      await endpoints.safety.raiseSos(circleId, translate("incident:autoNote"))
      toast.success(translate("incident:raised"))
      clear()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSending(false)
    }
  }, [circleId, clear])

  useEffect(() => {
    if (!pending) return
    if (Date.now() - pending.detectedAt > FORGET_MS) {
      clear()
      return
    }
    autoTried.current = false
    haptics.error()
  }, [detectedAt, pending, clear])

  // A wall clock rather than a counter. Timers do not run while the app is
  // backgrounded, and a countdown frozen at 14 is exactly the failure this
  // feature cannot have: it is most likely to be backgrounded after a crash.
  useEffect(() => {
    if (!pending) return
    setNow(Date.now())
    const tick = setInterval(() => {
      const next = Date.now()
      setNow(next)
      // Past the stale cutoff nothing on this card can change again, and the
      // phone it is open on may sit unattended for hours.
      if (next - detectedAt > STALE_MS) clearInterval(tick)
    }, 500)
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now())
    })
    return () => {
      clearInterval(tick)
      subscription.remove()
    }
  }, [detectedAt, pending])

  useEffect(() => {
    if (!pending || sending || autoTried.current) return
    if (remaining > 0 || stale) return
    autoTried.current = true
    void escalate()
  }, [pending, remaining, stale, sending, escalate])

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
            tx={stale ? "incident:stale" : "incident:body"}
            size="sm"
            style={{ color: theme.colors.textDim, textAlign: "center", marginTop: 8 }}
          />

          {stale ? (
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
            disabled={sending}
            onPress={() => {
              haptics.select()
              clear()
            }}
            style={{ alignSelf: "stretch" }}
          />
          <PrimaryButton
            tx="incident:sendNow"
            variant="danger"
            loading={sending}
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
