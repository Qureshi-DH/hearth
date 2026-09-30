import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react"
import { AppState, RefreshControl, ScrollView, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake"
import { Marker, type CameraRef } from "@maplibre/maplibre-react-native"
import { haversineMeters, type PresenceIssue, type WatchResponse } from "@hearth/shared"
import { useFocusEffect } from "@react-navigation/native"

import { HearthMap, PlaceLayers, TrailGapLayer, TrailLayer } from "@/components/HearthMap"
import { MemberMarker, MEMBER_MARKER_LABEL_HEIGHT } from "@/components/MemberMarker"
import { ringFor } from "@/components/MemberRow"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { useMember, usePlaces, usePresence } from "@/hooks/queries"
import { useLiveness } from "@/hooks/useLiveness"
import { useNearby } from "@/hooks/useNearby"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { activityIconName } from "@/utils/activity"
import { formatSpeed } from "@/utils/format"
import { formatClock, relativeTime } from "@/utils/time"
import { splitTrail } from "@/utils/trail"
import { useHeader } from "@/utils/useHeader"

/** The watch window is ten minutes; asking each minute holds it open. */
const WATCH_HOLD_MS = 60_000
const KEEP_AWAKE_TAG = "hearth-live"
/** Anything closer than this to the last drawn point is the same spot. */
const TRAIL_MIN_STEP_METERS = 5
/** Four hours of five-second fixes. A longer watch drops its oldest point. */
const TRAIL_MAX_POINTS = 3_000

interface TrailPoint {
  lat: number
  lon: number
  recordedAt?: string
}

type Reason = WatchResponse["pushed"] | "unreachable"

function reasonKey(reason: Reason) {
  switch (reason) {
    case "no_device":
      return "live:reason_no_device" as const
    case "unsupported":
      return "live:reason_unsupported" as const
    case "unreachable":
      return "live:reason_unreachable" as const
    default:
      return "live:reason_sent" as const
  }
}

/**
 * Following one person as they travel. Their phone is asked to report every
 * few seconds for as long as this is open, the map keeps them centred, and
 * the trail is the fixes that arrived while it was open, no more. What the
 * card claims is judged against that cadence: a fix from before the ask is
 * where they were, not where they are, and a phone that has not replied
 * in two minutes is said to be not answering, with the reason the server
 * gave, rather than left as a red dot on an old spot.
 */
export const LiveScreen: FC<AppStackScreenProps<"Live">> = ({ navigation, route }) => {
  const { circleId, userId } = route.params
  const { themed, theme } = useAppTheme()
  const units = useSettingsStore((state) => state.units)
  const member = useMember(circleId, userId)
  const { data: presence } = usePresence(circleId)
  const { data: places } = usePlaces(circleId)
  const cameraRef = useRef<CameraRef>(null)
  const entry = presence?.find((item) => item.userId === userId)
  const nearby = useNearby(
    entry && !entry.atPlace ? entry.lat : null,
    entry && !entry.atPlace ? entry.lon : null,
  )
  const name = member?.nickname ?? member?.user.displayName ?? ""

  useHeader({ titleTx: "live:title", leftIcon: "back", onLeftPress: () => navigation.goBack() }, [
    navigation,
  ])

  // Following someone along a road is watching, not reading, and the phone
  // dims after fifteen seconds of not being touched. Held only while this
  // page is the one on screen, and only by it: every other screen still
  // sleeps. The tag keeps it that way if another page ever holds it too.
  useEffect(() => {
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined)
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined)
    }
  }, [])

  // When the viewer last asked, and until when the server said it would
  // keep the phone live. The holds that keep a window open do not move
  // askedAt: a fix has to be newer than what the viewer asked for, not
  // newer than the last minute's housekeeping.
  const [askedAt, setAskedAt] = useState<number | null>(null)
  const [until, setUntil] = useState<number | null>(null)
  const untilRef = useRef<number | null>(null)
  const [reply, setReply] = useState<WatchResponse | null>(null)
  const [reason, setReason] = useState<Reason | null>(null)
  const [pulling, setPulling] = useState(false)

  const ask = useCallback(
    async (fresh: boolean) => {
      const at = Date.now()
      // A hold that lands after the window lapsed is a new ask in all but
      // name: nothing the phone sent in between was in reply to anything.
      // A hold with no window yet is not: the viewer has been waiting since
      // the ask that failed, and the clock keeps running from there.
      if (fresh || (untilRef.current != null && at > untilRef.current)) setAskedAt(at)
      try {
        const response = await endpoints.locations.watch(circleId, userId)
        const end = response.watching ? at + response.seconds * 1000 : null
        untilRef.current = end
        setUntil(end)
        setReply(response)
        setReason(response.pushed)
      } catch {
        setReason("unreachable")
      }
    },
    [circleId, userId],
  )

  useFocusEffect(
    useCallback(() => {
      let active = AppState.currentState === "active"
      void ask(true)
      const timer = setInterval(() => {
        if (active) void ask(false)
      }, WATCH_HOLD_MS)
      // Away, the socket is closed and the holds stop, so a return is a
      // fresh ask: whatever the window did meanwhile, the viewer is looking
      // again now.
      const subscription = AppState.addEventListener("change", (next) => {
        const wasActive = active
        active = next === "active"
        if (active && !wasActive) void ask(true)
      })
      return () => {
        clearInterval(timer)
        subscription.remove()
      }
    }, [ask]),
  )

  const pull = async () => {
    setPulling(true)
    await ask(true)
    setPulling(false)
  }

  const [trail, setTrail] = useState<TrailPoint[]>([])
  // The first fix sets the zoom; after that the map only follows, so a
  // viewer who zoomed out to see the road ahead is not snapped back in.
  const framed = useRef(false)
  useEffect(() => {
    if (entry?.lat == null || entry.lon == null) return
    const here = { lat: entry.lat, lon: entry.lon, recordedAt: entry.recordedAt ?? undefined }
    setTrail((current) => {
      const last = current[current.length - 1]
      if (last && haversineMeters(last, here) < TRAIL_MIN_STEP_METERS) return current
      return [...current, here].slice(-TRAIL_MAX_POINTS)
    })
    cameraRef.current?.flyTo({
      center: [here.lon, here.lat],
      ...(framed.current ? {} : { zoom: 16 }),
      duration: 600,
    })
    framed.current = true
  }, [entry?.lat, entry?.lon, entry?.recordedAt])
  // The socket is closed while the app is away, so a Live view brought back
  // has a hole in its trail, and a hole is dashed, not drawn as the road.
  const { drawn, gaps } = useMemo(() => splitTrail(trail), [trail])

  const liveness = useLiveness(entry, askedAt, until)
  const paused = entry?.sharingState === "paused"
  const live = !paused && liveness === "live"
  const measured = entry?.approximate ? null : formatSpeed(entry?.speedMps, units)
  const activityIcon = live ? activityIconName(entry?.activity, entry?.speedMps) : null
  const where = entry?.atPlace
    ? entry.atPlace.name
    : nearby
      ? translate("map:near", { where: nearby })
      : null
  // "Stopped" is a claim about the person, and only a fix that answered
  // this ask can make it; a paused share says nothing about them.
  const headline = paused
    ? translate("map:paused")
    : liveness === "live"
      ? entry?.activity === "still"
        ? translate("live:stopped", { name })
        : name
      : liveness === "asking"
        ? translate("live:asking", { name })
        : liveness === "unanswered"
          ? translate("live:notAnswering", { name })
          : translate("live:ended")
  const issues: PresenceIssue[] = entry?.issues?.length ? entry.issues : (reply?.issues ?? [])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <HearthMap
        cameraRef={cameraRef}
        style={{ flex: 1 }}
        initialCenter={entry?.lat != null && entry.lon != null ? [entry.lon, entry.lat] : undefined}
        initialZoom={16}
      >
        <PlaceLayers places={places ?? []} highlightId={entry?.atPlace?.id} />
        <TrailLayer id="live-trail" segments={drawn} width={5} />
        <TrailGapLayer id="live-trail-gaps" gaps={gaps} />
        {member && entry?.lat != null && entry.lon != null ? (
          <Marker
            lngLat={[entry.lon, entry.lat]}
            anchor="bottom"
            offset={[0, MEMBER_MARKER_LABEL_HEIGHT]}
          >
            <MemberMarker
              markerKey={member.userId}
              faces={[
                {
                  userId: member.userId,
                  user: member.user,
                  label: name,
                  presence: entry,
                  ring: ringFor(entry, false),
                },
              ]}
            />
          </Marker>
        ) : null}
      </HearthMap>

      <ScrollView
        style={{ flexGrow: 0 }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => void pull()}
            tintColor={theme.colors.tint}
          />
        }
      >
        <View style={themed($card)}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
            {paused ? (
              <Ionicons name="pause-circle-outline" size={16} color={theme.colors.textDim} />
            ) : liveness === "ended" ? null : (
              <View
                testID={`liveness-${liveness}`}
                style={[themed($dot), live ? themed($liveDot) : null]}
              />
            )}
            <Text preset="subheading" numberOfLines={2} style={{ flexShrink: 1 }}>
              {headline}
            </Text>
          </View>
          {live ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
              {activityIcon ? (
                <Ionicons name={activityIcon} size={16} color={theme.colors.textDim} />
              ) : null}
              <Text preset="heading" style={{ color: theme.colors.text }}>
                {measured ?? "—"}
              </Text>
            </View>
          ) : null}
          {live && where ? (
            <Text size="sm" style={{ color: theme.colors.textDim }} numberOfLines={1}>
              {where}
            </Text>
          ) : null}
          {!paused && liveness === "unanswered" ? (
            <View style={{ gap: 2 }}>
              {reason ? (
                <Text size="sm" style={{ color: theme.colors.textDim }}>
                  {translate(reasonKey(reason))}
                </Text>
              ) : null}
              {issues.map((issue) => (
                <Text key={issue} size="sm" style={{ color: theme.colors.warning }}>
                  {translate(`map:issue_${issue}` as const)}
                </Text>
              ))}
            </View>
          ) : null}
          {!live && measured && entry?.recordedAt ? (
            <Text size="sm" style={{ color: theme.colors.textDim }}>
              {translate("live:wasDoing", { speed: measured, time: formatClock(entry.recordedAt) })}
            </Text>
          ) : null}
          {entry?.recordedAt ? (
            <Text size="xxs" style={{ color: theme.colors.textFaint }}>
              {live
                ? `${translate("member:lastUpdate")}: ${relativeTime(entry.recordedAt)}`
                : translate("live:lastSeen", { time: relativeTime(entry.recordedAt) })}
              {entry.accuracyMeters != null ? ` · ±${Math.round(entry.accuracyMeters)} m` : ""}
            </Text>
          ) : null}
          {!paused && liveness === "ended" ? (
            <PrimaryButton
              tx="live:startAgain"
              variant="soft"
              onPress={() => void ask(true)}
              style={{ marginTop: theme.spacing.xs }}
              Left={<Ionicons name="radio-outline" size={18} color={theme.colors.tint} />}
            />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
const $card: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  margin: spacing.md,
  padding: spacing.md,
  gap: 4,
  borderRadius: 20,
  backgroundColor: colors.surface,
})
const $dot: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 10,
  height: 10,
  borderRadius: 5,
  backgroundColor: colors.textFaint,
})
const $liveDot: ThemedStyle<ViewStyle> = ({ colors }) => ({
  backgroundColor: colors.error,
})
