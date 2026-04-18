import type { FC } from "react"
import { FlatList, Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { Place } from "@hearth/shared"

import { Avatar } from "@/components/Avatar"
import { EmptyState } from "@/components/EmptyState"
import { IconButton } from "@/components/IconButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { useMembers, usePlaces } from "@/hooks/queries"
import { useActiveCircle } from "@/hooks/useActiveCircle"
import { translate } from "@/i18n/translate"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { placeIconName } from "@/utils/activity"
import { withAlpha } from "@/utils/color"
import { formatRadius } from "@/utils/format"

export const PlacesScreen: FC<MainTabScreenProps<"Places">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const { circle } = useActiveCircle()
  const units = useSettingsStore((state) => state.units)
  const { data: places, isLoading, refetch, isRefetching } = usePlaces(circle?.id ?? null)
  const { data: members } = useMembers(circle?.id ?? null)

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} contentContainerStyle={themed($container)}>
      <View style={themed($header)}>
        <View style={{ flex: 1 }}>
          <Text preset="heading" tx="places:title" />
          {circle ? (
            <Text size="xs" style={{ color: theme.colors.textDim }}>
              {circle.emoji ? `${circle.emoji} ` : ""}
              {circle.name}
            </Text>
          ) : null}
        </View>
        {circle ? (
          <IconButton
            icon="add"
            tone="tint"
            accessibilityLabel={translate("places:add")}
            onPress={() => navigation.navigate("PlaceEditor", { circleId: circle.id })}
          />
        ) : null}
      </View>

      <FlatList
        data={places ?? []}
        keyExtractor={(place) => place.id}
        refreshing={isRefetching}
        onRefresh={refetch}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.md,
          gap: theme.spacing.xs,
          paddingBottom: theme.spacing.xxl,
        }}
        renderItem={({ item }) => (
          <PlaceCard
            place={item}
            units={units}
            memberAvatars={(members ?? [])
              .filter((member) => item.membersInside.includes(member.userId))
              .map((member) => member.user)}
            onPress={() =>
              circle &&
              navigation.navigate("PlaceDetail", { circleId: circle.id, placeId: item.id })
            }
          />
        )}
        ListEmptyComponent={
          isLoading || !circle ? null : (
            <EmptyState
              headingTx="places:empty"
              contentTx="places:emptyBody"
              buttonTx="places:add"
              buttonOnPress={() => navigation.navigate("PlaceEditor", { circleId: circle.id })}
              imageSource={undefined}
              style={{ paddingTop: theme.spacing.xxl }}
            />
          )
        }
      />
    </Screen>
  )
}

function PlaceCard({
  place,
  units,
  memberAvatars,
  onPress,
}: {
  place: Place
  units: "metric" | "imperial"
  memberAvatars: Array<{ displayName: string; avatarColor: string; avatarUrl: string | null }>
  onPress: () => void
}) {
  const { theme } = useAppTheme()
  const color = place.color ?? theme.colors.tint
  const count = place.membersInside.length

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View
        style={{
          width: 46,
          height: 46,
          borderRadius: 15,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(color, 0.16),
        }}
      >
        <Ionicons name={placeIconName(place.icon)} size={22} color={color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight="semiBold" size="sm" numberOfLines={1}>
          {place.name}
        </Text>
        <Text size="xs" style={{ color: theme.colors.textDim }}>
          {count === 0
            ? translate("places:nobody")
            : count === 1
              ? translate("places:insideOne")
              : translate("places:inside", { count })}{" "}
          · {formatRadius(place.radiusMeters, units)}
        </Text>
      </View>
      <View style={{ flexDirection: "row" }}>
        {memberAvatars.slice(0, 3).map((user, index) => (
          <View key={`${user.displayName}-${index}`} style={{ marginLeft: index === 0 ? 0 : -10 }}>
            <Avatar user={user} size={28} />
          </View>
        ))}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.colors.textFaint} />
    </Pressable>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
const $header: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingHorizontal: spacing.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  gap: spacing.sm,
})
