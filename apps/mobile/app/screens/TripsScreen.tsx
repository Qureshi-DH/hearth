import type { FC } from "react"
import { FlatList, Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { Trip } from "@hearth/shared"

import { EmptyState } from "@/components/EmptyState"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { useTrips } from "@/hooks/queries"
import { useNearby } from "@/hooks/useNearby"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatDistance, formatSpeed, TRIP_SPEED_MIN_MPS } from "@/utils/format"
import { formatDuration, formatWhen } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const TripsScreen: FC<AppStackScreenProps<"Trips">> = ({ navigation, route }) => {
  const { circleId, userId } = route.params
  const { themed, theme } = useAppTheme()
  const units = useSettingsStore((state) => state.units)
  const { data: trips, isLoading } = useTrips(circleId, userId)

  useHeader({ titleTx: "trips:title", leftIcon: "back", onLeftPress: () => navigation.goBack() }, [
    navigation,
  ])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <FlatList
        data={trips ?? []}
        keyExtractor={(trip) => trip.id}
        contentContainerStyle={{
          padding: theme.spacing.md,
          gap: theme.spacing.xs,
          paddingBottom: theme.spacing.xxl,
        }}
        renderItem={({ item }) => (
          <TripCard
            trip={item}
            units={units}
            onPress={() => navigation.navigate("TripDetail", { tripId: item.id })}
          />
        )}
        ListEmptyComponent={
          isLoading ? null : (
            <EmptyState
              headingTx="member:noTrips"
              content=""
              style={{ paddingTop: theme.spacing.xxl }}
            />
          )
        }
      />
    </Screen>
  )
}

/**
 * "Home → Near Queen Street". A place the family named, else the street
 * the phone's geocoder knows, else the honest blank.
 */
export function tripEnds(
  trip: Pick<Trip, "startPlaceName" | "endPlaceName">,
  startNearby: string | null,
  endNearby: string | null,
): string {
  const end = (place: string | null, nearby: string | null) =>
    place ?? (nearby ? translate("map:near", { where: nearby }) : translate("trips:unknownPlace"))
  return `${end(trip.startPlaceName, startNearby)} → ${end(trip.endPlaceName, endNearby)}`
}

/** The streets at a trip's two ends, asked for only where no place names them. */
export function useTripEnds(trip: Trip) {
  const startNearby = useNearby(
    trip.startPlaceName ? null : trip.startLat,
    trip.startPlaceName ? null : trip.startLon,
  )
  const endNearby = useNearby(
    trip.endPlaceName ? null : trip.endLat,
    trip.endPlaceName ? null : trip.endLon,
  )
  return { startNearby, endNearby }
}

export function TripCard({
  trip,
  units,
  onPress,
}: {
  trip: Trip
  units: "metric" | "imperial"
  onPress: () => void
}) {
  const { theme } = useAppTheme()
  const { startNearby, endNearby } = useTripEnds(trip)
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        padding: theme.spacing.md,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
        gap: 8,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name="car-outline" size={18} color={theme.colors.tint} />
        <Text weight="semiBold" size="sm" style={{ flex: 1 }} numberOfLines={1}>
          {tripEnds(trip, startNearby, endNearby)}
        </Text>
        <Text size="xxs" style={{ color: theme.colors.textFaint }}>
          {formatWhen(trip.startedAt)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: theme.spacing.md }}>
        <Stat
          label={translate("trips:distance")}
          value={formatDistance(trip.distanceMeters, units)}
        />
        <Stat label={translate("trips:duration")} value={formatDuration(trip.durationSeconds)} />
        <Stat
          label={translate("trips:topSpeed")}
          value={formatSpeed(trip.maxSpeedMps, units, TRIP_SPEED_MIN_MPS) ?? "-"}
        />
      </View>
    </Pressable>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const { theme } = useAppTheme()
  return (
    <View>
      <Text weight="semiBold" size="sm">
        {value}
      </Text>
      <Text size="xxs" style={{ color: theme.colors.textDim }}>
        {label}
      </Text>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
