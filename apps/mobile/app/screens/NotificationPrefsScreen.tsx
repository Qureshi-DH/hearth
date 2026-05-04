import { useState, type FC } from "react"
import { View, type ViewStyle } from "react-native"
import * as Clipboard from "expo-clipboard"
import { MUTABLE_EVENT_TYPES, type EventType } from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { OptionSheet } from "@/components/OptionSheet"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { useMembers, useSetNotifications } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { openAppSettings } from "@/services/permissions"
import { useAuthStore } from "@/stores/auth"
import { usePushStore } from "@/stores/push"
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

  const [muteOpen, setMuteOpen] = useState(false)

  const muteAll = (value: boolean) => {
    if (!value) {
      setNotifications.mutate({ mutedUntil: null })
      return
    }
    setMuteOpen(true)
  }

  const muteFor = (ms: number) =>
    setNotifications.mutate({ mutedUntil: new Date(Date.now() + ms).toISOString() })

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md }}>
        <Text tx="notifications:subtitle" size="sm" style={{ color: theme.colors.textDim }} />
      </View>

      <PushTransport />

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
      <OptionSheet
        visible={muteOpen}
        titleTx="notifications:muteFor"
        onClose={() => setMuteOpen(false)}
        options={[
          { key: "hour", tx: "sharing:oneHour", onPress: () => muteFor(60 * 60 * 1000) },
          { key: "day", label: "24h", onPress: () => muteFor(24 * 60 * 60 * 1000) },
          { key: "week", label: "7d", onPress: () => muteFor(7 * 24 * 60 * 60 * 1000) },
        ]}
      />
    </Screen>
  )
}

/**
 * Without this the app is silent about why alerts never arrive: the server may
 * have no transport at all, ntfy needs the user to subscribe to a topic only
 * the server knows, and a denied permission looks identical to all of them.
 */
function PushTransport() {
  const { theme } = useAppTheme()
  const setup = usePushStore((state) => state.setup)
  const provider = useAuthStore((state) => state.serverInfo?.pushProvider)
  const [testing, setTesting] = useState(false)

  const sendTest = async () => {
    setTesting(true)
    try {
      await endpoints.push.test()
      toast.success(translate("notifications:testSent"))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const copyTopic = async (topic: string) => {
    await Clipboard.setStringAsync(topic)
    toast.success(translate("common:copied"))
  }

  const deliverable = setup?.kind === "registered" || setup?.kind === "ntfy"

  return (
    <View>
      <SectionHeader tx="notifications:setupTitle" />
      <View style={{ paddingHorizontal: theme.spacing.md, gap: theme.spacing.xs }}>
        {setup?.kind === "ntfy" ? (
          <>
            <Text weight="semiBold" size="sm" tx="notifications:ntfyTitle" />
            <Text size="xs" tx="notifications:ntfyBody" style={{ color: theme.colors.textDim }} />
            <Text
              weight="semiBold"
              size="sm"
              text={setup.topic}
              onPress={() => copyTopic(setup.topic)}
              style={{ color: theme.colors.tint }}
            />
            <Text size="xxs" text={setup.baseUrl} style={{ color: theme.colors.textDim }} />
          </>
        ) : setup?.kind === "denied" ? (
          <>
            <Text size="xs" tx="notifications:denied" style={{ color: theme.colors.textDim }} />
            <PrimaryButton
              variant="ghost"
              tx="permissions:openSettings"
              onPress={openAppSettings}
            />
          </>
        ) : setup?.kind === "unsupported" ? (
          <Text size="xs" text={setup.reason} style={{ color: theme.colors.textDim }} />
        ) : setup?.kind === "none" || provider === "none" ? (
          <Text size="xs" tx="notifications:none" style={{ color: theme.colors.textDim }} />
        ) : (
          <Text
            size="xs"
            tx="notifications:setupBody"
            txOptions={{ provider: provider ?? "" }}
            style={{ color: theme.colors.textDim }}
          />
        )}

        {deliverable ? (
          <PrimaryButton
            variant="soft"
            tx="notifications:test"
            loading={testing}
            onPress={sendTest}
            style={{ marginTop: theme.spacing.xs }}
          />
        ) : null}
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
