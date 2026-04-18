import { useEffect, useState, type FC } from "react"
import { ActivityIndicator, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { haversineMeters } from "@hearth/shared"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useCheckIn, usePlaces } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { reportNow } from "@/services/location/tracker"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { useHeader } from "@/utils/useHeader"

export const CheckInScreen: FC<AppStackScreenProps<"CheckIn">> = ({ navigation, route }) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const { data: places } = usePlaces(circleId)
  const checkIn = useCheckIn(circleId)
  const [note, setNote] = useState("")
  const [fix, setFix] = useState<{ lat: number; lon: number; accuracy: number | null } | null>(null)
  const [locating, setLocating] = useState(true)

  useHeader({ titleTx: "checkIn:title", leftIcon: "x", onLeftPress: () => navigation.goBack() }, [
    navigation,
  ])

  useEffect(() => {
    ;(async () => {
      const result = await reportNow("manual")
      if (result)
        setFix({ lat: result.lat, lon: result.lon, accuracy: result.accuracyMeters ?? null })
      setLocating(false)
    })()
  }, [])

  const nearby = fix
    ? places?.find(
        (place) =>
          haversineMeters({ lat: fix.lat, lon: fix.lon }, { lat: place.lat, lon: place.lon }) <=
          place.radiusMeters,
      )
    : undefined

  const submit = async () => {
    if (!fix) return
    try {
      const result = await checkIn.mutateAsync({
        lat: fix.lat,
        lon: fix.lon,
        note: note.trim() || null,
      })
      toast.success(
        `${translate("checkIn:sent")}${result.placeName ? ` ${translate("checkIn:at", { place: result.placeName })}` : ""}`,
      )
      navigation.goBack()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <Text tx="checkIn:subtitle" size="sm" style={{ color: theme.colors.textDim }} />

      <View style={themed($locationCard)}>
        {locating ? (
          <ActivityIndicator color={theme.colors.tint} />
        ) : fix ? (
          <>
            <Ionicons name={nearby ? "location" : "navigate"} size={22} color={theme.colors.tint} />
            <View style={{ flex: 1 }}>
              <Text weight="semiBold" size="sm">
                {nearby ? nearby.name : `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`}
              </Text>
              {fix.accuracy != null ? (
                <Text size="xxs" style={{ color: theme.colors.textDim }}>
                  ±{Math.round(fix.accuracy)} m
                </Text>
              ) : null}
            </View>
          </>
        ) : (
          <Text size="xs" style={{ color: theme.colors.error }}>
            {translate("permissions:deniedBody")}
          </Text>
        )}
      </View>

      <TextField
        value={note}
        onChangeText={setNote}
        labelTx="checkIn:note"
        placeholderTx="checkIn:notePlaceholder"
        maxLength={140}
        inputWrapperStyle={themed($input)}
        containerStyle={{ marginTop: theme.spacing.md }}
      />

      <PrimaryButton
        tx="checkIn:send"
        onPress={submit}
        loading={checkIn.isPending}
        disabled={!fix}
        style={{ marginTop: theme.spacing.lg }}
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  padding: spacing.lg,
})
const $locationCard: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  marginTop: spacing.md,
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.sm,
  padding: spacing.md,
  borderRadius: 18,
  backgroundColor: colors.surface,
  minHeight: 64,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
