import { useEffect, useRef, useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import { KeyboardAwareScrollView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { DEFAULTS } from "@hearth/shared"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SosHoldButton } from "@/components/SosHoldButton"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useMyOpenSos, useRaiseSos, useResolveSos } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { reportNow } from "@/services/location/tracker"
import { alert } from "@/stores/alert"
import { toast } from "@/stores/toast"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"

const SOS_PING_MS = DEFAULTS.sosPingIntervalSeconds * 1000

/**
 * Long enough for a warm GPS to answer, so the alert carries where the person
 * is now. Short enough that a phone indoors does not hold the alert back. The
 * fix still uploads when it comes, and the phone is on Live by then.
 */
const FRESH_FIX_WAIT_MS = 5_000

function liveNow(): boolean {
  const { watchedUntil } = useTrackingStore.getState()
  return watchedUntil != null && Date.parse(watchedUntil) > Date.now()
}

/**
 * With sharing off a fix never leaves the phone. It waits in the queue and
 * goes up whenever sharing comes back on, long after anybody needed it, so
 * none is taken.
 */
function sharingOn(): boolean {
  return useTrackingStore.getState().enabled
}

/**
 * While an alert is open the server holds this phone on Live, a fix a second
 * wherever the app is. This screen only reports for a phone that is not on
 * it, one whose tracker cannot run in the background or that talks to a
 * server too old to hold it.
 */
export const SosScreen: FC<AppStackScreenProps<"Sos">> = ({ navigation, route }) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const mine = useMyOpenSos(circleId)
  const raise = useRaiseSos(circleId)
  const resolve = useResolveSos()
  const sharing = useTrackingStore((state) => state.enabled)
  const [note, setNote] = useState("")
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (mine) {
      // The first one also carries the alert's live window back in its
      // upload reply, to a phone that had no channel open to hear it on.
      const ping = () => {
        if (sharingOn() && !liveNow()) void reportNow("sos")
      }
      ping()
      timer.current = setInterval(ping, SOS_PING_MS)
    }
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [mine?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const activate = async () => {
    try {
      // A failed or slow fix must never be what stops the alert going out.
      if (sharingOn()) {
        await Promise.race([
          reportNow("sos").catch(() => null),
          new Promise((resolve) => setTimeout(resolve, FRESH_FIX_WAIT_MS)),
        ])
      }
      await raise.mutateAsync(note.trim() || null)
      toast.success(translate("sos:sent"))
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const finish = () => {
    if (!mine) return
    alert(translate("sos:resolve"), translate("sos:resolveConfirm"), [
      { text: translate("common:cancel"), style: "cancel" },
      {
        text: translate("sos:resolve"),
        onPress: async () => {
          try {
            await resolve.mutateAsync(mine.id)
            toast.success(translate("sos:resolved"))
            navigation.goBack()
          } catch (error) {
            // Leaving on a failure would be worse than staying: the circle is
            // still being alerted, and the only way back here is another SOS.
            toast.error((error as Error).message)
          }
        },
      },
    ])
  }

  return (
    <LinearGradient
      colors={
        mine
          ? ["#3A0F14", theme.colors.background]
          : [theme.colors.background, theme.colors.background]
      }
      style={[themed($container), { paddingTop: insets.top + theme.spacing.sm }]}
    >
      {/* The note field sits at the bottom, where the keyboard lands. This
          scrolls it into view above the keyboard instead of under it. */}
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.md,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={theme.spacing.lg}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <Text preset="subheading" tx="sos:title" />
          <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={themed($close)}>
            <Ionicons name="close" size={20} color={theme.colors.text} />
          </Pressable>
        </View>

        <View
          style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: theme.spacing.lg }}
        >
          <SosHoldButton
            active={Boolean(mine)}
            onActivate={activate}
            label={translate("sos:holdToSend")}
            hint={
              mine
                ? translate(sharing ? "sos:sentBody" : "sos:sentBodySharingOff")
                : translate("sos:cancelCountdown")
            }
          />
          {mine ? (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text weight="semiBold" tx="sos:sent" />
              <Text size="xs" style={{ color: theme.colors.textDim }}>
                {relativeTime(mine.startedAt)}
                {mine.note ? ` · “${mine.note}”` : ""}
              </Text>
            </View>
          ) : null}
        </View>

        {mine ? (
          <PrimaryButton
            tx="sos:resolve"
            variant="soft"
            onPress={finish}
            loading={resolve.isPending}
          />
        ) : (
          <TextField
            value={note}
            onChangeText={setNote}
            labelTx="sos:note"
            placeholderTx="sos:notePlaceholder"
            maxLength={200}
            inputWrapperStyle={themed($input)}
          />
        )}
      </KeyboardAwareScrollView>
    </LinearGradient>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})
const $close: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 36,
  height: 36,
  borderRadius: 18,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.surface,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
