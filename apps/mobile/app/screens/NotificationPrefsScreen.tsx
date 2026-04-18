import type { FC } from "react"
import { Alert, View, type ViewStyle } from "react-native"
import { MUTABLE_EVENT_TYPES, type EventType } from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { useMembers, useSetNotifications } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { eventVisual } from "@/utils/activity"
import { formatWhen } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

const LABELS: Partial<
  Record<
    EventType,
    | "notifications:placeArrive"
    | "notifications:placeLeave"
    | "notifications:checkIn"
    | "notifications:lowBattery"
    | "notifications:deviceOffline"
    | "notifications:sharingPaused"
    | "notifications:tripCompleted"
  >
> = {
  place_arrive: "notifications:placeArrive",
  place_leave: "notifications:placeLeave",
  check_in: "notifications:checkIn",
  low_battery: "notifications:lowBattery",
  device_offline: "notifications:deviceOffline",
  sharing_paused: "notifications:sharingPaused",
  trip_completed: "notifications:tripCompleted",
}

export const NotificationPrefsScreen: FC<AppStackScreenProps<"NotificationPrefs">> = ({
  navigation,
  route,
}) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const me = useAuthStore((state) => state.user)
  const { data: members } = useMembers(circleId)
  const mine = members?.find((member) => member.userId === me?.id)
  const setNotifications = useSetNotifications(circleId)

  useHeader(
    { titleTx: "notifications:title", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const muted = new Set(mine?.notifications.muted ?? [])
  const mutedUntil = mine?.notifications.mutedUntil ?? null
  const isMutedAll = Boolean(mutedUntil && Date.parse(mutedUntil) > Date.now())

  const toggle = (type: EventType, on: boolean) => {
    const next = new Set(muted)
    if (on) next.delete(type)
    else next.add(type)
    setNotifications.mutate(
      { muted: [...next] },
      { onError: (error) => toast.error((error as Error).message) },
    )
  }

  const muteAll = (value: boolean) => {
    if (!value) {
      setNotifications.mutate({ mutedUntil: null })
      return
    }
    const hour = new Date(Date.now() + 60 * 60 * 1000)
    const day = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    Alert.alert(translate("notifications:muteFor"), undefined, [
      {
        text: translate("sharing:oneHour"),
        onPress: () => setNotifications.mutate({ mutedUntil: hour.toISOString() }),
      },
      { text: "24h", onPress: () => setNotifications.mutate({ mutedUntil: day.toISOString() }) },
      { text: "7d", onPress: () => setNotifications.mutate({ mutedUntil: week.toISOString() }) },
      { text: translate("common:cancel"), style: "cancel" },
    ])
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md }}>
        <Text tx="notifications:subtitle" size="sm" style={{ color: theme.colors.textDim }} />
      </View>

      <SectionHeader tx="notifications:muteAll" />
      <ListGroup>
        <ListRow
          tx="notifications:muteAll"
          subtitle={
            isMutedAll && mutedUntil
              ? translate("sharing:pausedUntil", { time: formatWhen(mutedUntil) })
              : undefined
          }
          icon="notifications-off-outline"
          iconTone="warning"
          value={isMutedAll}
          onValueChange={muteAll}
        />
      </ListGroup>

      <SectionHeader tx="notifications:title" />
      <ListGroup>
        {MUTABLE_EVENT_TYPES.map((type) => {
          const visual = eventVisual(type)
          return (
            <ListRow
              key={type}
              tx={LABELS[type]}
              icon={visual.icon}
              iconTone={visual.tone}
              value={!muted.has(type)}
              onValueChange={(on) => toggle(type, on)}
              disabled={isMutedAll}
            />
          )
        })}
      </ListGroup>
      <Text
        size="xxs"
        tx="notifications:sosNote"
        style={{
          color: theme.colors.textFaint,
          paddingHorizontal: theme.spacing.md,
          paddingTop: theme.spacing.sm,
        }}
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
