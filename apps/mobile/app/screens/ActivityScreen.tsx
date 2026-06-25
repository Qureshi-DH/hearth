import { memo, useCallback, useMemo, type FC } from "react"
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
  const circleId = circle?.id ?? null
  const events = useEvents(circleId)
  const markRead = useMarkFeedRead(circleId ?? "")

  useFocusEffect(
    useCallback(() => {
      if (circle && circle.unreadEventCount > 0) markRead.mutate()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [circle?.id, circle?.unreadEventCount]),
  )

  /**
   * Every websocket frame, page fetch and refresh hands this a new `data`
   * object, so it runs often and on the JS thread. Bucket on the local midnight
   * an event falls in rather than on its rendered label: the label costs an Intl
   * format, and this way it is paid once per day on screen instead of once per
   * loaded event. One `now` for the whole pass keeps "Today" from straddling
   * midnight halfway down the list.
   */
  const sections = useMemo(() => {
    const now = new Date()
    const byDay = new Map<number, FeedEvent[]>()
    for (const page of events.data?.pages ?? []) {
      for (const item of page.items) {
        const at = new Date(item.occurredAt)
        const key = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
        const bucket = byDay.get(key)
        if (bucket) bucket.push(item)
        else byDay.set(key, [item])
      }
    }
    return [...byDay.values()].map((data) => ({ title: dayLabel(data[0]!.occurredAt, now), data }))
  }, [events.data])

  const openEvent = useCallback(
    (event: FeedEvent) => {
      if (!circleId) return
      const userId = (event.payload.userId as string | undefined) ?? event.actor?.id
      if (
        (event.type === "place_arrive" ||
          event.type === "place_leave" ||
          event.type === "check_in" ||
          event.type === "sos_started") &&
        userId
      ) {
        navigation.navigate("MemberDetail", { circleId, userId })
      } else if (event.type.startsWith("place_") && event.payload.placeId) {
        navigation.navigate("PlaceDetail", {
          circleId,
          placeId: event.payload.placeId as string,
        })
      }
    },
    [circleId, navigation],
  )

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
        renderItem={({ item }) => <EventRow event={item} onPress={openEvent} />}
        ListEmptyComponent={
          events.isLoading ? null : (
            <EmptyState
              headingTx="activity:empty"
              contentTx="activity:emptyBody"
              style={{ paddingTop: theme.spacing.xxl }}
            />
          )
        }
      />
    </Screen>
  )
}

/**
 * A new event prepends into page 0 and leaves every other event's identity
 * alone, and the unread count that rides along with it re-renders this screen
 * even while the user is on another tab. Without the memo each frame reconciles
 * every mounted row, Intl clock and all: VirtualizedSectionList builds its own
 * `renderItem` wrapper on each render and hands it to a PureComponent cell, so
 * the memo has to sit on the row. `onPress` takes the event for the same reason,
 * so the list can pass one stable function down rather than a fresh arrow per row.
 */
const EventRow = memo(function EventRow({
  event,
  onPress,
}: {
  event: FeedEvent
  onPress: (event: FeedEvent) => void
}) {
  const { theme } = useAppTheme()
  const visual = eventVisual(event.type)
  const color = toneColor(visual.tone, theme.colors)
  const handlePress = useCallback(() => onPress(event), [onPress, event])

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: 6 }}>
      <Pressable
        onPress={handlePress}
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
})

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
