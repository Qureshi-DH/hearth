import { useCallback, useEffect, useRef, useState, type FC } from "react"
import { AppState, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { Marker, type CameraRef } from "@maplibre/maplibre-react-native"
import { haversineMeters } from "@hearth/shared"
import { useFocusEffect } from "@react-navigation/native"

import { HearthMap, PlaceLayers, TrailLayer } from "@/components/HearthMap"
import { MemberMarker, MEMBER_MARKER_LABEL_HEIGHT } from "@/components/MemberMarker"
import { ringFor } from "@/components/MemberRow"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { useMember, usePlaces, usePresence } from "@/hooks/queries"
import { useNearby } from "@/hooks/useNearby"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { activityIconName, onTheMove } from "@/utils/activity"
import { formatSpeed } from "@/utils/format"
import { relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

/** The watch window is ten minutes; asking each minute holds it open. */
const WATCH_HOLD_MS = 60_000
/** Anything closer than this to the last drawn point is the same spot. */
const TRAIL_MIN_STEP_METERS = 5

interface LatLng {
  lat: number
  lon: number
}

/**
 * Following one person as they travel. Their phone is asked to report every
 * few seconds for as long as this is open, the map keeps them centred, and
 * the trail is the fixes that arrived while it was open, no more.
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

  useFocusEffect(
    useCallback(() => {
      const ask = () => {
        if (AppState.currentState !== "active") return
        endpoints.locations.watch(circleId, userId).catch(() => undefined)
      }
      ask()
      const timer = setInterval(ask, WATCH_HOLD_MS)
      return () => clearInterval(timer)
    }, [circleId, userId]),
  )

  const [trail, setTrail] = useState<LatLng[]>([])
  useEffect(() => {
    if (entry?.lat == null || entry.lon == null) return
    const here = { lat: entry.lat, lon: entry.lon }
    setTrail((current) => {
      const last = current[current.length - 1]
      if (last && haversineMeters(last, here) < TRAIL_MIN_STEP_METERS) return current
      return [...current, here]
    })
    cameraRef.current?.flyTo({ center: [here.lon, here.lat], zoom: 16, duration: 600 })
  }, [entry?.lat, entry?.lon])

  const moving = onTheMove(entry)
  const speed = entry?.approximate ? null : formatSpeed(entry?.speedMps, units)
  const activityIcon = moving ? activityIconName(entry?.activity) : null
  const where = entry?.atPlace
    ? entry.atPlace.name
    : nearby
      ? translate("map:near", { where: nearby })
      : null

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <HearthMap
        cameraRef={cameraRef}
        style={{ flex: 1 }}
        initialCenter={entry?.lat != null && entry.lon != null ? [entry.lon, entry.lat] : undefined}
        initialZoom={16}
      >
        <PlaceLayers places={places ?? []} highlightId={entry?.atPlace?.id} />
        {trail.length > 1 ? <TrailLayer id="live-trail" points={trail} width={5} /> : null}
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

      <View style={themed($card)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
          {moving ? (
            <View style={themed($liveDot)} />
          ) : (
            <Ionicons name="pause-circle-outline" size={16} color={theme.colors.textDim} />
          )}
          <Text preset="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
            {moving ? name : translate("live:stopped", { name })}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
          {activityIcon ? (
            <Ionicons name={activityIcon} size={16} color={theme.colors.textDim} />
          ) : null}
          <Text preset="heading" style={{ color: theme.colors.text }}>
            {speed ?? "—"}
          </Text>
        </View>
        {where ? (
          <Text size="sm" style={{ color: theme.colors.textDim }} numberOfLines={1}>
            {where}
          </Text>
        ) : null}
        {entry?.recordedAt ? (
          <Text size="xxs" style={{ color: theme.colors.textFaint }}>
            {translate("member:lastUpdate")}: {relativeTime(entry.recordedAt)}
            {entry.accuracyMeters != null ? ` · ±${Math.round(entry.accuracyMeters)} m` : ""}
          </Text>
        ) : null}
      </View>
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
const $liveDot: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 10,
  height: 10,
  borderRadius: 5,
  backgroundColor: colors.error,
})
