import { useEffect, useRef, useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { DEFAULTS } from "@hearth/shared"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SosHoldButton } from "@/components/SosHoldButton"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useActiveSos, useRaiseSos, useResolveSos } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { reportNow } from "@/services/location/tracker"
import { alert } from "@/stores/alert"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"

const SOS_PING_MS = DEFAULTS.sosPingIntervalSeconds * 1000

/**
 * While an alert is active this screen takes high-accuracy fixes on top of the
 * normal background cadence, so the circle sees movement in near real time.
 */
export const SosScreen: FC<AppStackScreenProps<"Sos">> = ({ navigation, route }) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const me = useAuthStore((state) => state.user)
  const { data: active } = useActiveSos(circleId)
  const raise = useRaiseSos(circleId)
  const resolve = useResolveSos(circleId)
  const [note, setNote] = useState("")
  const mine = active?.find((alert) => alert.user.id === me?.id) ?? null
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (mine) {
      void reportNow("sos")
      timer.current = setInterval(() => void reportNow("sos"), SOS_PING_MS)
    }
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [mine?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const activate = async () => {
    try {
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
      style={[
        themed($container),
        {
          paddingTop: insets.top + theme.spacing.sm,
          paddingBottom: insets.bottom + theme.spacing.md,
        },
      ]}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
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
          hint={mine ? translate("sos:sentBody") : translate("sos:cancelCountdown")}
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
    </LinearGradient>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  paddingHorizontal: spacing.lg,
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
