import { useEffect, useMemo, useRef, useState, type FC } from "react"
import { Linking, Platform, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { Marker, type CameraRef } from "@maplibre/maplibre-react-native"
import { QUICK_MESSAGES, type QuickMessageKey } from "@hearth/shared"

import { Avatar } from "@/components/Avatar"
import { BatteryPill } from "@/components/BatteryPill"
import { HearthMap, PlaceLayers, TrailLayer } from "@/components/HearthMap"
import { ListGroup, ListRow } from "@/components/ListRow"
import { MemberMarker, MEMBER_MARKER_LABEL_HEIGHT } from "@/components/MemberMarker"
import { ringFor, statusLine } from "@/components/MemberRow"
import { OptionSheet } from "@/components/OptionSheet"
import { Pill } from "@/components/Pill"
import { PromptDialog } from "@/components/PromptDialog"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import {
  useCircle,
  useHistory,
  useMember,
  useNudge,
  usePlaces,
  usePresence,
  useRemoveMember,
  useTrips,
  useUpdateMember,
} from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { TripCard } from "@/screens/TripsScreen"
import { alert } from "@/stores/alert"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { activityIconName } from "@/utils/activity"
import { formatSpeed } from "@/utils/format"
import { fitBoundsFor } from "@/utils/map"
import { relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const MemberDetailScreen: FC<AppStackScreenProps<"MemberDetail">> = ({
  navigation,
  route,
}) => {
  const { circleId, userId } = route.params
  const { themed, theme } = useAppTheme()
  const me = useAuthStore((state) => state.user)
  const units = useSettingsStore((state) => state.units)
  const circle = useCircle(circleId)
  const member = useMember(circleId, userId)
  const { data: presence } = usePresence(circleId)
  const { data: places } = usePlaces(circleId)
  const { data: trips } = useTrips(circleId, userId)
  const nudge = useNudge(circleId)
  const updateMember = useUpdateMember(circleId)
  const removeMember = useRemoveMember(circleId)
  const cameraRef = useRef<CameraRef>(null)

  const isSelf = userId === me?.id
  const entry = presence?.find((item) => item.userId === userId)
  const canSeeHistory =
    entry?.sharingState === "precise" &&
    !entry.approximate &&
    (isSelf || circle?.settings.allowHistory)

  const todayRange = useMemo(() => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { from: start.toISOString(), to: now.toISOString() }
  }, [])
  const { data: trail } = useHistory(circleId, userId, canSeeHistory ? todayRange : null)

  const name = member?.nickname ?? member?.user.displayName ?? ""
  useHeader({ title: name, leftIcon: "back", onLeftPress: () => navigation.goBack() }, [
    name,
    navigation,
  ])

  useEffect(() => {
    const points = [
      ...(trail ?? []).map((point) => ({ lat: point.lat, lon: point.lon })),
      ...(entry?.lat != null && entry.lon != null ? [{ lat: entry.lat, lon: entry.lon }] : []),
    ]
    const bounds = fitBoundsFor(points, 120)
    if (bounds) {
      cameraRef.current?.fitBounds([bounds.sw[0], bounds.sw[1], bounds.ne[0], bounds.ne[1]], {
        padding: { top: 30, bottom: 30, left: 30, right: 30 },
        duration: 500,
      })
    }
  }, [trail?.length, entry?.lat, entry?.lon]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDirections = () => {
    if (entry?.lat == null || entry.lon == null) return
    const url = Platform.select({
      ios: `maps://?daddr=${entry.lat},${entry.lon}`,
      default: `geo:${entry.lat},${entry.lon}?q=${entry.lat},${entry.lon}(${encodeURIComponent(name)})`,
    })
    void Linking.openURL(url)
  }

  const askNudge = async () => {
    try {
      await nudge.mutateAsync({ userId })
      toast.success(translate("map:nudged", { name }))
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const [choosingMessage, setChoosingMessage] = useState(false)
  const sendQuick = async (quickKey: QuickMessageKey) => {
    try {
      await nudge.mutateAsync({ userId, quickKey })
      toast.success(translate("map:nudged", { name }))
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const [nicknaming, setNicknaming] = useState(false)
  const setNickname = () => setNicknaming(true)

  const changeRole = (role: "member" | "admin" | "owner") => {
    const confirm = () =>
      updateMember.mutate(
        { userId, role },
        { onError: (error) => toast.error((error as Error).message) },
      )
    if (role === "owner") {
      alert(translate("member:transferOwnership"), translate("member:transferConfirm", { name }), [
        { text: translate("common:cancel"), style: "cancel" },
        { text: translate("member:transferOwnership"), style: "destructive", onPress: confirm },
      ])
    } else confirm()
  }

  const remove = () => {
    alert(
      translate(isSelf ? "member:leave" : "member:remove"),
      translate(isSelf ? "member:leaveConfirm" : "member:removeConfirm", {
        name: isSelf ? (circle?.name ?? "") : name,
      }),
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate(isSelf ? "member:leave" : "common:remove"),
          style: "destructive",
          onPress: async () => {
            try {
              await removeMember.mutateAsync(userId)
              navigation.navigate("Main", { screen: "Map" })
            } catch (error) {
              toast.error((error as Error).message)
            }
          },
        },
      ],
    )
  }

  if (!member) return <Screen preset="fixed" />

  const canManage = circle?.role === "owner" || circle?.role === "admin"
  const speed = entry?.approximate ? null : formatSpeed(entry?.speedMps, units)
  const activityIcon = entry?.approximate ? null : activityIconName(entry?.activity)

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={themed($hero)}>
        <Avatar user={member.user} size={68} ring={ringFor(entry, isSelf)} />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text preset="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
              {name}
            </Text>
            <Pill
              text={translate(
                member.role === "owner"
                  ? "member:roleOwner"
                  : member.role === "admin"
                    ? "member:roleAdmin"
                    : "member:roleMember",
              )}
              tone={member.role === "owner" ? "warning" : "neutral"}
            />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {activityIcon ? (
              <Ionicons name={activityIcon} size={14} color={theme.colors.textDim} />
            ) : null}
            <Text
              size="xs"
              style={{ color: theme.colors.textDim, flexShrink: 1 }}
              numberOfLines={2}
            >
              {statusLine(entry)}
              {speed ? ` · ${speed}` : ""}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <BatteryPill level={entry?.batteryLevel} charging={entry?.isCharging} />
            {entry?.approximate ? (
              <Pill text={translate("map:approximate")} tone="warning" icon="radio-button-on" />
            ) : null}
            {entry?.sosAlertId ? <Pill text="SOS" tone="error" icon="alert" /> : null}
          </View>
        </View>
      </View>

      <View style={themed($mapCard)}>
        <HearthMap
          cameraRef={cameraRef}
          initialCenter={
            entry?.lat != null && entry.lon != null ? [entry.lon, entry.lat] : undefined
          }
          initialZoom={14}
          dragPan={false}
          touchZoom={false}
          touchRotate={false}
        >
          <PlaceLayers places={places ?? []} highlightId={entry?.atPlace?.id} />
          {trail && trail.length > 1 ? <TrailLayer id="member-trail" points={trail} /> : null}
          {entry?.lat != null && entry.lon != null ? (
            <Marker
              lngLat={[entry.lon, entry.lat]}
              anchor="bottom"
              // Puts the pointer tip on the coordinate instead of the name pill.
              offset={[0, MEMBER_MARKER_LABEL_HEIGHT]}
            >
              <MemberMarker
                user={member.user}
                label={name}
                presence={entry}
                ring={ringFor(entry, isSelf)}
              />
            </Marker>
          ) : null}
        </HearthMap>
        {entry?.recordedAt ? (
          <View style={themed($mapCaption)}>
            <Text size="xxs" style={{ color: theme.colors.textDim }}>
              {translate("member:lastUpdate")}: {relativeTime(entry.recordedAt)}
              {entry.accuracyMeters != null ? ` · ±${Math.round(entry.accuracyMeters)} m` : ""}
            </Text>
          </View>
        ) : null}
      </View>

      {!isSelf ? (
        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            marginTop: theme.spacing.md,
          }}
        >
          <PrimaryButton
            tx="map:nudge"
            variant="soft"
            onPress={askNudge}
            loading={nudge.isPending}
            disabled={entry?.sharingState === "paused"}
            style={{ flex: 1 }}
            Left={<Ionicons name="hand-left-outline" size={18} color={theme.colors.tint} />}
          />
          <PrimaryButton
            tx="member:directions"
            variant="soft"
            onPress={openDirections}
            disabled={entry?.lat == null}
            style={{ flex: 1 }}
            Left={<Ionicons name="navigate-outline" size={18} color={theme.colors.tint} />}
          />
        </View>
      ) : null}

      {canSeeHistory ? (
        <>
          <SectionHeader
            tx="member:trips"
            action={
              trips && trips.length > 0
                ? {
                    tx: "trips:title",
                    onPress: () => navigation.navigate("Trips", { circleId, userId }),
                  }
                : undefined
            }
          />
          <View style={{ paddingHorizontal: theme.spacing.md, gap: theme.spacing.xs }}>
            {(trips ?? []).slice(0, 3).map((trip) => (
              <TripCard
                key={trip.id}
                trip={trip}
                units={units}
                onPress={() => navigation.navigate("TripDetail", { tripId: trip.id })}
              />
            ))}
            {trips && trips.length === 0 ? (
              <Text size="xs" tx="member:noTrips" style={{ color: theme.colors.textFaint }} />
            ) : null}
          </View>
        </>
      ) : null}

      <SectionHeader tx="circle:title" />
      <ListGroup>
        {!isSelf ? (
          <ListRow
            tx="messages:messageMember"
            icon="chatbubble-ellipses-outline"
            iconTone="tint"
            onPress={() => setChoosingMessage(true)}
          />
        ) : null}
        {canManage || isSelf ? (
          <ListRow
            tx="member:nickname"
            subtitle={member.nickname ?? undefined}
            icon="pricetag-outline"
            onPress={setNickname}
          />
        ) : null}
        {circle?.role === "owner" && !isSelf ? (
          <>
            <ListRow
              tx={member.role === "admin" ? "member:makeMember" : "member:makeAdmin"}
              icon="ribbon-outline"
              iconTone="tint"
              onPress={() => changeRole(member.role === "admin" ? "member" : "admin")}
            />
            <ListRow
              tx="member:transferOwnership"
              icon="star-outline"
              iconTone="warning"
              onPress={() => changeRole("owner")}
            />
          </>
        ) : null}
        {isSelf ? (
          <ListRow
            tx="sharing:title"
            icon="eye-outline"
            iconTone="info"
            onPress={() => navigation.navigate("Sharing", { circleId })}
          />
        ) : null}
        {member.role !== "owner" && (canManage || isSelf) ? (
          <ListRow
            tx={isSelf ? "member:leave" : "member:remove"}
            icon="person-remove-outline"
            destructive
            onPress={remove}
          />
        ) : null}
      </ListGroup>
      <OptionSheet
        visible={choosingMessage}
        titleTx="messages:title"
        onClose={() => setChoosingMessage(false)}
        options={QUICK_MESSAGES.map((quick) => ({
          key: quick.key,
          // The words themselves, because they are what the other person will
          // read on their screen and what the activity feed will record.
          label: quick.body,
          onPress: () => void sendQuick(quick.key),
        }))}
      />
      <PromptDialog
        visible={nicknaming}
        titleTx="member:nickname"
        initialValue={member?.nickname ?? ""}
        onCancel={() => setNicknaming(false)}
        onSubmit={(value) =>
          updateMember.mutate(
            { userId, nickname: value || null },
            { onError: (error) => toast.error((error as Error).message) },
          )
        }
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
const $hero: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.md,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.md,
})
const $mapCard: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  marginHorizontal: spacing.md,
  height: 260,
  borderRadius: 24,
  overflow: "hidden",
  backgroundColor: colors.surface,
})
const $mapCaption: ThemedStyle<ViewStyle> = ({ colors }) => ({
  position: "absolute",
  left: 12,
  bottom: 10,
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 10,
  backgroundColor: colors.glass,
})
