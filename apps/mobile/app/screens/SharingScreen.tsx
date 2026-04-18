import type { FC } from "react"
import { Alert, Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { SharingState } from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { useCircles, useMembers, useSetSharing } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { startTracking, stopTracking } from "@/services/location/tracker"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatWhen } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

const STATES: Array<{
  value: SharingState
  icon: "locate" | "radio-button-on" | "eye-off"
  titleTx: "sharing:precise" | "sharing:approximate" | "sharing:paused"
  bodyTx: "sharing:preciseBody" | "sharing:approximateBody" | "sharing:pausedBody"
}> = [
  { value: "precise", icon: "locate", titleTx: "sharing:precise", bodyTx: "sharing:preciseBody" },
  {
    value: "approximate",
    icon: "radio-button-on",
    titleTx: "sharing:approximate",
    bodyTx: "sharing:approximateBody",
  },
  { value: "paused", icon: "eye-off", titleTx: "sharing:paused", bodyTx: "sharing:pausedBody" },
]

export const SharingScreen: FC<AppStackScreenProps<"Sharing">> = ({ navigation, route }) => {
  const { themed } = useAppTheme()
  const me = useAuthStore((state) => state.user)
  const enabled = useTrackingStore((state) => state.enabled)
  const setEnabled = useTrackingStore((state) => state.setEnabled)
  const { data: circles } = useCircles()
  const focusId = route.params?.circleId ?? null
  const visibleCircles = (circles ?? []).filter((circle) => !focusId || circle.id === focusId)

  useHeader(
    { titleTx: "sharing:title", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const toggleMaster = async (value: boolean) => {
    setEnabled(value)
    if (value) await startTracking()
    else await stopTracking()
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="sharing:masterSwitch" />
      <ListGroup>
        <ListRow
          tx="sharing:masterSwitch"
          subtitleTx="sharing:masterBody"
          icon="navigate-circle-outline"
          iconTone="tint"
          value={enabled}
          onValueChange={toggleMaster}
        />
      </ListGroup>

      {visibleCircles.map((circle) => (
        <CircleSharing
          key={circle.id}
          circleId={circle.id}
          title={`${circle.emoji ?? ""} ${circle.name}`.trim()}
          allowPause={circle.settings.allowSharingPause}
          userId={me?.id ?? ""}
        />
      ))}
    </Screen>
  )
}

function CircleSharing({
  circleId,
  title,
  allowPause,
  userId,
}: {
  circleId: string
  title: string
  allowPause: boolean
  userId: string
}) {
  const { themed, theme } = useAppTheme()
  const { data: members } = useMembers(circleId)
  const setSharing = useSetSharing(circleId)
  const mine = members?.find((member) => member.userId === userId)
  const current = mine?.sharingState ?? "precise"

  const choose = (value: SharingState) => {
    if (value === "paused") {
      if (!allowPause) {
        toast.error(translate("sharing:notAllowed"))
        return
      }
      const hour = new Date(Date.now() + 60 * 60 * 1000)
      const tonight = new Date()
      tonight.setHours(23, 59, 0, 0)
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(8, 0, 0, 0)
      Alert.alert(translate("sharing:pauseFor"), undefined, [
        { text: translate("sharing:oneHour"), onPress: () => apply("paused", hour.toISOString()) },
        {
          text: translate("sharing:untilTonight"),
          onPress: () => apply("paused", tonight.toISOString()),
        },
        {
          text: translate("sharing:untilTomorrow"),
          onPress: () => apply("paused", tomorrow.toISOString()),
        },
        { text: translate("sharing:indefinitely"), onPress: () => apply("paused", null) },
        { text: translate("common:cancel"), style: "cancel" },
      ])
      return
    }
    apply(value, null)
  }

  const apply = (value: SharingState, pausedUntil: string | null) =>
    setSharing.mutate(
      { sharingState: value, pausedUntil },
      { onError: (error) => toast.error((error as Error).message) },
    )

  return (
    <>
      <SectionHeader text={title} />
      <View style={themed($group)}>
        {STATES.map((state) => {
          const active = current === state.value
          return (
            <Pressable
              key={state.value}
              onPress={() => choose(state.value)}
              style={[
                themed($option),
                active && {
                  borderColor: theme.colors.tint,
                  backgroundColor: theme.colors.tintSoft,
                },
              ]}
            >
              <Ionicons
                name={state.icon}
                size={20}
                color={active ? theme.colors.tint : theme.colors.textDim}
              />
              <View style={{ flex: 1 }}>
                <Text
                  weight="semiBold"
                  size="sm"
                  tx={state.titleTx}
                  style={{ color: active ? theme.colors.tint : theme.colors.text }}
                />
                <Text size="xs" tx={state.bodyTx} style={{ color: theme.colors.textDim }} />
                {active && state.value === "paused" && mine?.pausedUntil ? (
                  <Text size="xxs" style={{ color: theme.colors.warning, marginTop: 2 }}>
                    {translate("sharing:pausedUntil", { time: formatWhen(mine.pausedUntil) })}
                  </Text>
                ) : null}
              </View>
              {active ? (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.tint} />
              ) : null}
            </Pressable>
          )
        })}
      </View>
    </>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
const $group: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginHorizontal: spacing.md,
  gap: spacing.xs,
})
const $option: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.sm,
  padding: spacing.md,
  borderRadius: 18,
  borderWidth: 1.5,
  borderColor: "transparent",
  backgroundColor: colors.surface,
})
