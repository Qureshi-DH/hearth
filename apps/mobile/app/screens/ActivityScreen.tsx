import { useCallback, useMemo, type FC } from "react"
import { Pressable, RefreshControl, SectionList, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { FeedEvent } from "@hearth/shared"
import { useFocusEffect } from "@react-navigation/native"

import { Avatar } from "@/components/Avatar"
import { EmptyState } from "@/components/EmptyState"
import { toneColor } from "@/components/Pill"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { useEvents, useMarkFeedRead } from "@/hooks/queries"
import { useActiveCircle } from "@/hooks/useActiveCircle"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { eventVisual } from "@/utils/activity"
import { withAlpha } from "@/utils/color"
import { dayLabel, formatClock } from "@/utils/time"

export const ActivityScreen: FC<MainTabScreenProps<"Activity">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const { circle } = useActiveCircle()
  const events = useEvents(circle?.id ?? null)
  const markRead = useMarkFeedRead(circle?.id ?? "")

  useFocusEffect(
    useCallback(() => {
      if (circle && circle.unreadEventCount > 0) markRead.mutate()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [circle?.id, circle?.unreadEventCount]),
  )

  const sections = useMemo(() => {
    const items = events.data?.pages.flatMap((page) => page.items) ?? []
    const byDay = new Map<string, FeedEvent[]>()
    for (const item of items) {
      const key = dayLabel(item.occurredAt)
      byDay.set(key, [...(byDay.get(key) ?? []), item])
    }
    return [...byDay.entries()].map(([title, data]) => ({ title, data }))
  }, [events.data])

  const openEvent = (event: FeedEvent) => {
    if (!circle) return
    const userId = (event.payload.userId as string | undefined) ?? event.actor?.id
    if (
      (event.type === "place_arrive" ||
        event.type === "place_leave" ||
        event.type === "check_in" ||
        event.type === "sos_started") &&
      userId
    ) {
      navigation.navigate("MemberDetail", { circleId: circle.id, userId })
    } else if (event.type.startsWith("place_") && event.payload.placeId) {
      navigation.navigate("PlaceDetail", {
        circleId: circle.id,
        placeId: event.payload.placeId as string,
      })
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} contentContainerStyle={themed($container)}>
      <View style={themed($header)}>
        <Text preset="heading" tx="activity:title" />
        {circle ? (
          <Text size="xs" style={{ color: theme.colors.textDim }}>
            {circle.emoji ? `${circle.emoji} ` : ""}
            {circle.name}
          </Text>
        ) : null}
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
        refreshControl={
          <RefreshControl
            refreshing={events.isRefetching}
            onRefresh={() => events.refetch()}
            tintColor={theme.colors.tint}
          />
        }
        onEndReached={() =>
          events.hasNextPage && !events.isFetchingNextPage && events.fetchNextPage()
        }
        onEndReachedThreshold={0.4}
        renderSectionHeader={({ section }) => (
          <Text size="xxs" weight="semiBold" style={themed($dayLabel)}>
            {section.title.toUpperCase()}
          </Text>
        )}
        renderItem={({ item }) => <EventRow event={item} onPress={() => openEvent(item)} />}
        ListEmptyComponent={
          events.isLoading ? null : (
            <EmptyState
              headingTx="activity:empty"
              contentTx="activity:emptyBody"
              button={undefined}
              style={{ paddingTop: theme.spacing.xxl }}
              imageSource={undefined}
            />
          )
        }
      />
    </Screen>
  )
}

function EventRow({ event, onPress }: { event: FeedEvent; onPress: () => void }) {
  const { theme } = useAppTheme()
  const visual = eventVisual(event.type)
  const color = toneColor(visual.tone, theme.colors)

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: 6 }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={event.summary}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
          padding: theme.spacing.sm,
          borderRadius: 18,
          backgroundColor: theme.colors.surface,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View style={{ position: "relative" }}>
          {event.actor ? (
            <Avatar user={event.actor} size={42} />
          ) : (
            <View style={{ width: 42, height: 42 }} />
          )}
          <View
            style={{
              position: "absolute",
              right: -4,
              bottom: -4,
              width: 22,
              height: 22,
              borderRadius: 11,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.surface,
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: withAlpha(color, 0.18),
              }}
            >
              <Ionicons name={visual.icon} size={11} color={color} />
            </View>
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <Text size="sm" weight="medium" numberOfLines={2}>
            {event.summary}
          </Text>
          {typeof event.payload.note === "string" && event.payload.note ? (
            <Text size="xs" style={{ color: theme.colors.textDim }} numberOfLines={2}>
              “{event.payload.note}”
            </Text>
          ) : null}
        </View>
        <Text size="xxs" style={{ color: theme.colors.textFaint }}>
          {formatClock(event.occurredAt)}
        </Text>
      </Pressable>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
const $header: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  paddingHorizontal: spacing.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.xs,
})
const $dayLabel: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  paddingHorizontal: spacing.md,
  paddingTop: spacing.md,
  paddingBottom: 4,
  color: colors.textFaint,
  letterSpacing: 1.2,
})
