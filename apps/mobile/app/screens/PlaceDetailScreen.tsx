import type { FC } from "react"
import { View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { Avatar } from "@/components/Avatar"
import { HearthMap, PlaceLayers } from "@/components/HearthMap"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { useMembers, usePlaceEvents, usePlaces } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { placeIconName } from "@/utils/activity"
import { withAlpha } from "@/utils/color"
import { formatRadius } from "@/utils/format"
import { zoomForRadius } from "@/utils/map"
import { formatWhen } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const PlaceDetailScreen: FC<AppStackScreenProps<"PlaceDetail">> = ({
  navigation,
  route,
}) => {
  const { circleId, placeId } = route.params
  const { themed, theme } = useAppTheme()
  const units = useSettingsStore((state) => state.units)
  const { data: places } = usePlaces(circleId)
  const { data: members } = useMembers(circleId)
  const { data: events } = usePlaceEvents(circleId, placeId)
  const place = places?.find((candidate) => candidate.id === placeId)

  useHeader(
    { title: place?.name ?? "", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [place?.name, navigation],
  )

  if (!place) return <Screen preset="fixed" />

  const color = place.color ?? theme.colors.tint
  const inside = (members ?? []).filter((member) => place.membersInside.includes(member.userId))
  const memberName = (userId: string) => {
    const member = members?.find((candidate) => candidate.userId === userId)
    return member?.nickname ?? member?.user.displayName ?? translate("common:unknown")
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={themed($mapCard)}>
        <HearthMap
          initialCenter={[place.lon, place.lat]}
          initialZoom={zoomForRadius(place.radiusMeters)}
          dragPan={false}
          touchZoom={false}
          touchRotate={false}
        >
          <PlaceLayers places={[place]} highlightId={place.id} />
        </HearthMap>
        <View pointerEvents="none" style={[themed($badge), { backgroundColor: color }]}>
          <Ionicons name={placeIconName(place.icon)} size={22} color="#FFFFFF" />
        </View>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          paddingTop: theme.spacing.md,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text preset="subheading">{place.name}</Text>
          <Text size="xs" style={{ color: theme.colors.textDim }}>
            {formatRadius(place.radiusMeters, units)} ·{" "}
            {inside.length === 0
              ? translate("places:nobody")
              : inside.length === 1
                ? translate("places:insideOne")
                : translate("places:inside", { count: inside.length })}
          </Text>
        </View>
        <PrimaryButton
          tx="places:edit"
          variant="soft"
          onPress={() => navigation.navigate("PlaceEditor", { circleId, placeId })}
        />
      </View>

      {inside.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            paddingTop: theme.spacing.sm,
            flexWrap: "wrap",
          }}
        >
          {inside.map((member) => (
            <View
              key={member.userId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingRight: 10,
                paddingLeft: 4,
                paddingVertical: 4,
                borderRadius: 999,
                backgroundColor: withAlpha(color, 0.14),
              }}
            >
              <Avatar user={member.user} size={24} />
              <Text size="xs" weight="medium">
                {member.nickname ?? member.user.displayName}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <SectionHeader tx="places:recent" />
      <View
        style={{
          marginHorizontal: theme.spacing.md,
          borderRadius: 20,
          backgroundColor: theme.colors.surface,
          overflow: "hidden",
        }}
      >
        {(events ?? []).map((event) => (
          <View
            key={event.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: 10,
            }}
          >
            <Ionicons
              name={event.type === "arrive" ? "enter-outline" : "exit-outline"}
              size={18}
              color={event.type === "arrive" ? theme.colors.success : theme.colors.info}
            />
            <Text size="sm" style={{ flex: 1 }}>
              {translate(event.type === "arrive" ? "places:arrived" : "places:left", {
                name: memberName(event.userId),
              })}
            </Text>
            <Text size="xxs" style={{ color: theme.colors.textFaint }}>
              {formatWhen(event.occurredAt)}
            </Text>
          </View>
        ))}
        {events && events.length === 0 ? (
          <Text
            size="xs"
            style={{ color: theme.colors.textFaint, padding: theme.spacing.md }}
            tx="activity:empty"
          />
        ) : null}
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
  height: 220,
  borderRadius: 24,
  overflow: "hidden",
  backgroundColor: colors.surface,
})
const $badge: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  left: "50%",
  top: "50%",
  marginLeft: -20,
  marginTop: -20,
  width: 40,
  height: 40,
  borderRadius: 20,
  alignItems: "center",
  justifyContent: "center",
})
