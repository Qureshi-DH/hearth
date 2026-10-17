import { useState, type FC } from "react"
import { View, type ViewStyle } from "react-native"
import * as Clipboard from "expo-clipboard"
import {
  MUTABLE_EVENT_TYPES,
  type EventType,
  type MutableEventType,
  type PlaceAlerts,
  type QuietHours,
} from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { OptionSheet } from "@/components/OptionSheet"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import {
  useMembers,
  usePlaces,
  useSetNotifications,
  useUpdateNotificationSettings,
} from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { openAppSettings } from "@/services/permissions"
import { phoneClock } from "@/services/phoneClock"
import { useAuthStore } from "@/stores/auth"
import { usePushStore } from "@/stores/push"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { eventVisual, placeIconName } from "@/utils/activity"
import { minutesToWait, takePushTest } from "@/utils/budget"
import { formatWhen } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

/**
 * Total on purpose. This was Partial, so speed alerts had no label and rendered
 * as a switch with an icon and no words. A missing label is now a build error.
 */
const LABELS: Record<
  MutableEventType,
  | "notifications:placeArrive"
  | "notifications:placeLeave"
  | "notifications:checkIn"
  | "notifications:lowBattery"
  | "notifications:deviceOffline"
  | "notifications:sharingPaused"
  | "notifications:tripCompleted"
  | "notifications:speedAlert"
  | "notifications:nudge"
> = {
  place_arrive: "notifications:placeArrive",
  place_leave: "notifications:placeLeave",
  check_in: "notifications:checkIn",
  low_battery: "notifications:lowBattery",
  device_offline: "notifications:deviceOffline",
  sharing_paused: "notifications:sharingPaused",
  trip_completed: "notifications:tripCompleted",
  speed_alert: "notifications:speedAlert",
  nudge_requested: "notifications:nudge",
}

const PLACE_CHOICES: Array<{
  key: PlaceAlerts
  tx:
    | "notifications:placeBoth"
    | "notifications:placeArriveOnly"
    | "notifications:placeLeaveOnly"
    | "notifications:placeNone"
}> = [
  { key: "both", tx: "notifications:placeBoth" },
  { key: "arrive", tx: "notifications:placeArriveOnly" },
  { key: "leave", tx: "notifications:placeLeaveOnly" },
  { key: "none", tx: "notifications:placeNone" },
]

/** A short list of sensible times beats a clock face nobody wants to fiddle with. */
const QUIET_FROM = ["20:00", "21:00", "22:00", "23:00", "00:00"]
const QUIET_UNTIL = ["05:00", "06:00", "07:00", "08:00", "09:00"]
const DEFAULT_QUIET: QuietHours = { from: "22:00", until: "07:00", then: "hold" }

type Sheet =
  | { kind: "place"; placeId: string; name: string }
  | { kind: "from" }
  | { kind: "until" }
  | { kind: "then" }

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
  // An older server would ignore or refuse these, so they show only where
  // the server says it has them.
  const controls = useAuthStore(
    (state) => state.serverInfo?.features?.notificationControls === true,
  )
  const { data: places } = usePlaces(controls ? circleId : null)
  const updateSettings = useUpdateNotificationSettings()
  const settings = me?.notificationSettings
  const mutedPeople = new Set(settings?.mutedPeople ?? [])
  const quiet = settings?.quietHours ?? null
  const placeChoices = mine?.notifications.places ?? {}
  const others = (members ?? []).filter((member) => member.userId !== me?.id)
  const [sheet, setSheet] = useState<Sheet | null>(null)

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

  const onError = { onError: (error: unknown) => toast.error((error as Error).message) }

  const choosePlace = (placeId: string, choice: PlaceAlerts) =>
    setNotifications.mutate({ places: { [placeId]: choice } }, onError)

  const hearPerson = (userId: string, on: boolean) => {
    const next = new Set(mutedPeople)
    if (on) next.delete(userId)
    else next.add(userId)
    updateSettings.mutate({ mutedPeople: [...next] }, onError)
  }

  // The phone's clock goes with every change, since that is what the hours
  // are read on.
  const setQuiet = (next: QuietHours | null) =>
    updateSettings.mutate({ quietHours: next, ...phoneClock() }, onError)

  const sheetOptions = (() => {
    if (!sheet) return []
    if (sheet.kind === "place") {
      return PLACE_CHOICES.map((choice) => ({
        key: choice.key,
        tx: choice.tx,
        onPress: () => choosePlace(sheet.placeId, choice.key),
      }))
    }
    if (!quiet) return []
    if (sheet.kind === "then") {
      return [
        {
          key: "hold",
          tx: "notifications:quietHold" as const,
          onPress: () => setQuiet({ ...quiet, then: "hold" }),
        },
        {
          key: "drop",
          tx: "notifications:quietDrop" as const,
          onPress: () => setQuiet({ ...quiet, then: "drop" }),
        },
      ]
    }
    const times = sheet.kind === "from" ? QUIET_FROM : QUIET_UNTIL
    return times.map((time) => ({
      key: time,
      label: time,
      onPress: () => setQuiet({ ...quiet, [sheet.kind]: time }),
    }))
  })()

  const muteAll = (value: boolean) => {
    if (!value) {
      setNotifications.mutate(
        { mutedUntil: null },
        { onError: (error) => toast.error((error as Error).message) },
      )
      return
    }
    setMuteOpen(true)
  }

  const muteFor = (ms: number) =>
    setNotifications.mutate(
      { mutedUntil: new Date(Date.now() + ms).toISOString() },
      { onError: (error) => toast.error((error as Error).message) },
    )

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
      {controls && places && places.length > 0 ? (
        <>
          <SectionHeader tx="notifications:places" />
          <ListGroup>
            {places.map((place) => (
              <ListRow
                key={place.id}
                text={place.name}
                icon={placeIconName(place.icon)}
                subtitleTx={
                  PLACE_CHOICES.find((choice) => choice.key === (placeChoices[place.id] ?? "both"))
                    ?.tx
                }
                onPress={() => setSheet({ kind: "place", placeId: place.id, name: place.name })}
                disabled={isMutedAll}
              />
            ))}
          </ListGroup>
        </>
      ) : null}

      {controls && others.length > 0 ? (
        <>
          <SectionHeader tx="notifications:people" />
          <ListGroup>
            {others.map((member) => (
              <ListRow
                key={member.userId}
                text={member.nickname ?? member.user.displayName}
                subtitleTx="notifications:comingsAndGoings"
                icon="person-outline"
                value={!mutedPeople.has(member.userId)}
                onValueChange={(on) => hearPerson(member.userId, on)}
              />
            ))}
          </ListGroup>
        </>
      ) : null}

      {controls ? (
        <>
          <SectionHeader tx="notifications:atNight" />
          <ListGroup>
            <ListRow
              tx="notifications:quietHours"
              subtitle={
                quiet
                  ? translate("notifications:quietSpan", { from: quiet.from, until: quiet.until })
                  : undefined
              }
              icon="moon-outline"
              value={Boolean(quiet)}
              onValueChange={(on) => setQuiet(on ? DEFAULT_QUIET : null)}
            />
            {quiet ? (
              <>
                <ListRow
                  tx="notifications:quietFrom"
                  subtitle={quiet.from}
                  onPress={() => setSheet({ kind: "from" })}
                />
                <ListRow
                  tx="notifications:quietUntil"
                  subtitle={quiet.until}
                  onPress={() => setSheet({ kind: "until" })}
                />
                <ListRow
                  tx="notifications:quietThen"
                  subtitleTx={
                    quiet.then === "hold" ? "notifications:quietHold" : "notifications:quietDrop"
                  }
                  onPress={() => setSheet({ kind: "then" })}
                />
              </>
            ) : null}
          </ListGroup>
          <Text
            size="xxs"
            tx="notifications:quietNote"
            style={{
              color: theme.colors.textFaint,
              paddingHorizontal: theme.spacing.md,
              paddingTop: theme.spacing.sm,
            }}
          />
        </>
      ) : null}

      <OptionSheet
        visible={sheet !== null}
        title={sheet?.kind === "place" ? sheet.name : undefined}
        titleTx={
          sheet?.kind === "from"
            ? "notifications:quietFrom"
            : sheet?.kind === "until"
              ? "notifications:quietUntil"
              : sheet?.kind === "then"
                ? "notifications:quietThen"
                : undefined
        }
        onClose={() => setSheet(null)}
        options={sheetOptions}
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
    const waitMs = takePushTest()
    if (waitMs > 0) {
      toast.info(translate("notifications:testWait", { minutes: minutesToWait(waitMs) }))
      return
    }
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
