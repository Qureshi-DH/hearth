import { useEffect, useMemo, useRef, type FC } from "react"
import { View, type ViewStyle } from "react-native"
import { Marker, type CameraRef } from "@maplibre/maplibre-react-native"

import { HearthMap, TrailGapLayer, TrailLayer } from "@/components/HearthMap"
import { Screen } from "@/components/Screen"
import { StatTile } from "@/components/StatTile"
import { Text } from "@/components/Text"
import { useTrip } from "@/hooks/queries"
import { useNearby } from "@/hooks/useNearby"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { tripEnds } from "@/screens/TripsScreen"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatDistance, formatSpeed, TRIP_SPEED_MIN_MPS } from "@/utils/format"
import { fitBoundsFor } from "@/utils/map"
import { formatDuration, formatWhen } from "@/utils/time"
import { splitTrail } from "@/utils/trail"
import { useHeader } from "@/utils/useHeader"

export const TripDetailScreen: FC<AppStackScreenProps<"TripDetail">> = ({ navigation, route }) => {
  const { tripId } = route.params
  const { themed, theme } = useAppTheme()
  const units = useSettingsStore((state) => state.units)
  const { data: trip } = useTrip(tripId)
  const cameraRef = useRef<CameraRef>(null)
  const startNearby = useNearby(
    trip && !trip.startPlaceName ? trip.startLat : null,
    trip && !trip.startPlaceName ? trip.startLon : null,
  )
  const endNearby = useNearby(
    trip && !trip.endPlaceName ? trip.endLat : null,
    trip && !trip.endPlaceName ? trip.endLon : null,
  )

  useHeader({ titleTx: "trips:title", leftIcon: "back", onLeftPress: () => navigation.goBack() }, [
    navigation,
  ])

  // Only the stretches the phone reported are drawn as the road. A silence
  // between two fixes is dashed, so a straight line across town reads as
  // "no data here" rather than as the route.
  const { drawn, gaps } = useMemo(() => splitTrail(trip?.path ?? []), [trip?.path])

  useEffect(() => {
    if (!trip) return
    const bounds = fitBoundsFor(
      trip.path.map((point) => ({ lat: point.lat, lon: point.lon })),
      200,
    )
    if (bounds) {
      cameraRef.current?.fitBounds([bounds.sw[0], bounds.sw[1], bounds.ne[0], bounds.ne[1]], {
        padding: { top: 40, bottom: 40, left: 40, right: 40 },
        duration: 600,
      })
    }
  }, [trip?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!trip) return <Screen preset="fixed" />

  const endpointDot = (color: string) => (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: color,
        borderWidth: 3,
        borderColor: "#FFFFFF",
      }}
    />
  )

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={themed($mapCard)}>
        <HearthMap
          cameraRef={cameraRef}
          initialCenter={[trip.startLon, trip.startLat]}
          initialZoom={13}
        >
          <TrailLayer id="trip" segments={drawn} width={5} />
          <TrailGapLayer id="trip-gaps" gaps={gaps} />
          <Marker lngLat={[trip.startLon, trip.startLat]} anchor="center">
            {endpointDot(theme.colors.success)}
          </Marker>
          <Marker lngLat={[trip.endLon, trip.endLat]} anchor="center">
            {endpointDot(theme.colors.error)}
          </Marker>
        </HearthMap>
      </View>

      <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.md, gap: 4 }}>
        <Text preset="subheading">{tripEnds(trip, startNearby, endNearby)}</Text>
        <Text size="xs" style={{ color: theme.colors.textDim }}>
          {formatWhen(trip.startedAt)} to {formatWhen(trip.endedAt)}
        </Text>
        {gaps.length > 0 ? (
          <Text size="xxs" tx="live:gap" style={{ color: theme.colors.textFaint }} />
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: theme.spacing.xs, padding: theme.spacing.md }}>
        <StatTile
          icon="map-outline"
          label={translate("trips:distance")}
          value={formatDistance(trip.distanceMeters, units)}
        />
        <StatTile
          icon="time-outline"
          label={translate("trips:duration")}
          value={formatDuration(trip.durationSeconds)}
        />
      </View>
      <View
        style={{ flexDirection: "row", gap: theme.spacing.xs, paddingHorizontal: theme.spacing.md }}
      >
        <StatTile
          icon="speedometer-outline"
          label={translate("trips:topSpeed")}
          value={formatSpeed(trip.maxSpeedMps, units, TRIP_SPEED_MIN_MPS) ?? "-"}
        />
        <StatTile
          icon="pulse-outline"
          label={translate("trips:avgSpeed")}
          value={formatSpeed(trip.avgSpeedMps, units, TRIP_SPEED_MIN_MPS) ?? "-"}
        />
      </View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
const $mapCard: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  marginHorizontal: spacing.md,
  marginTop: spacing.sm,
  height: 300,
  borderRadius: 24,
  overflow: "hidden",
  backgroundColor: colors.surface,
})
