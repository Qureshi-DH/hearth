import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet"
import type { MemberPresence } from "@hearth/shared"
import { Marker, type CameraRef } from "@maplibre/maplibre-react-native"
import { useFocusEffect } from "@react-navigation/native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import Animated, {
  FadeInUp,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Avatar } from "@/components/Avatar"
import { GlassPanel } from "@/components/GlassPanel"
import { HearthMap, PlaceLayers, TrailLayer } from "@/components/HearthMap"
import { IconButton } from "@/components/IconButton"
import { MemberMarker } from "@/components/MemberMarker"
import { MemberRow, ringFor } from "@/components/MemberRow"
import { Pill } from "@/components/Pill"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Text } from "@/components/Text"
import { useActiveSos, useHistory, useMembers, usePlaces, usePresence } from "@/hooks/queries"
import { useActiveCircle } from "@/hooks/useActiveCircle"
import { translate } from "@/i18n/translate"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { currentPermission, flush } from "@/services/location/tracker"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { fitBoundsFor } from "@/utils/map"

const FALLBACK_CENTER: [number, number] = [-0.1276, 51.5072]
/** Two 44 pt buttons plus the gap between them. */
const CONTROLS_HEIGHT = 96
/**
 * Just the grabber and the members line. Any taller and the tops of the
 * check in and SOS buttons peek out under it.
 */
const COLLAPSED_BAR_HEIGHT = 52

export const MapScreen: FC<MainTabScreenProps<"Map">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const me = useAuthStore((state) => state.user)
  const units = useSettingsStore((state) => state.units)
  const showTrails = useSettingsStore((state) => state.showTrails)
  const permission = useTrackingStore((state) => state.permission)
  const trackingEnabled = useTrackingStore((state) => state.enabled)
  const { circle, circles, isLoading, setActiveCircle } = useActiveCircle()
  const circleId = circle?.id ?? null

  const { data: members } = useMembers(circleId)
  const { data: presence } = usePresence(circleId)
  const { data: places } = usePlaces(circleId)
  const { data: activeSos } = useActiveSos(circleId)

  const cameraRef = useRef<CameraRef>(null)
  const sheetRef = useRef<BottomSheet>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const didFitRef = useRef(false)

  const presenceByUser = useMemo(
    () => new Map((presence ?? []).map((entry) => [entry.userId, entry])),
    [presence],
  )
  const located = useMemo(
    () => (presence ?? []).filter((entry) => entry.lat != null && entry.lon != null),
    [presence],
  )
  const myMembership = members?.find((member) => member.userId === me?.id)
  const mySharingPaused = myMembership?.sharingState === "paused"

  // Keyed on the calendar day, not the instant. Otherwise the query refetches
  // on every marker tap instead of on its own interval.
  const todayRange = useMemo(() => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1)
    return { from: start.toISOString(), to: end.toISOString() }
  }, [])

  const selectedPresence = selectedUserId ? presenceByUser.get(selectedUserId) : undefined
  const { data: trail } = useHistory(
    circleId,
    selectedUserId,
    showTrails &&
      selectedPresence &&
      !selectedPresence.approximate &&
      selectedPresence.sharingState === "precise"
      ? todayRange
      : null,
  )

  useFocusEffect(
    useCallback(() => {
      void currentPermission().then((level) => useTrackingStore.getState().setPermission(level))
      void flush()
    }, []),
  )

  // Fit everyone once, on first data. After that the camera belongs to the user.
  useEffect(() => {
    if (!mapReady || didFitRef.current || located.length === 0) return
    didFitRef.current = true
    fitAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, located.length])

  useEffect(() => {
    didFitRef.current = false
  }, [circleId])

  const fitAll = () => {
    const bounds = fitBoundsFor(
      located.map((entry) => ({ lat: entry.lat!, lon: entry.lon! })),
      200,
    )
    if (!bounds) return
    cameraRef.current?.fitBounds([bounds.sw[0], bounds.sw[1], bounds.ne[0], bounds.ne[1]], {
      padding: { top: insets.top + 120, bottom: 320, left: 40, right: 40 },
      duration: 600,
    })
  }

  const focusMember = (entry: MemberPresence | undefined, userId: string) => {
    setSelectedUserId(userId)
    sheetRef.current?.snapToIndex(0)
    if (entry?.lat != null && entry.lon != null) {
      cameraRef.current?.flyTo({
        center: [entry.lon, entry.lat],
        zoom: 15.5,
        duration: 700,
        padding: { bottom: 200 },
      })
    }
  }

  // The tab navigator already insets this screen above the tab bar, so bottom:0
  // here is the top of the bar. Do not add its height again.
  // Resting height is the handle plus the action row plus one member row.
  const restingSheetHeight = 210
  // The lowest point is a real snap, not a separate bar pretending to be one.
  // A grabber that only answers taps reads as a broken sheet.
  const snapPoints = useMemo(() => [COLLAPSED_BAR_HEIGHT, restingSheetHeight, "55%", "92%"], [])

  // The controls ride the sheet rather than jumping between two fixed offsets.
  // `animatedPosition` is the sheet's top edge as a shared value, so driving
  // `top` from it keeps them glued to the sheet on the UI thread.
  const sheetTop = useSharedValue(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const controlsStyle = useAnimatedStyle(() => {
    // Once the sheet is dismissed it parks off-screen, so clamp the controls to
    // just above the collapsed bar rather than letting them follow it down.
    const floor = containerHeight > 0 ? containerHeight - COLLAPSED_BAR_HEIGHT : sheetTop.value
    return { top: Math.min(sheetTop.value, floor) - CONTROLS_HEIGHT - 12 }
  })

  if (!isLoading && circles.length === 0) {
    return (
      <View style={[themed($empty), { paddingTop: insets.top + theme.spacing.xl }]}>
        <Ionicons name="people-circle-outline" size={72} color={theme.colors.textFaint} />
        <Text preset="heading" tx="circles:empty" style={{ textAlign: "center" }} />
        <Text
          tx="circles:emptyBody"
          size="sm"
          style={{ color: theme.colors.textDim, textAlign: "center" }}
        />
        <PrimaryButton
          tx="circles:create"
          onPress={() => navigation.navigate("CreateCircle")}
          style={{ alignSelf: "stretch", marginTop: theme.spacing.lg }}
        />
        <PrimaryButton
          tx="circles:join"
          variant="soft"
          onPress={() => navigation.navigate("JoinCircle")}
          style={{ alignSelf: "stretch" }}
        />
      </View>
    )
  }

  const firstLocated = located[0]
  const initialCenter: [number, number] = firstLocated
    ? [firstLocated.lon!, firstLocated.lat!]
    : FALLBACK_CENTER

  return (
    <GestureHandlerRootView
      style={{ flex: 1 }}
      onLayout={(event) => setContainerHeight(event.nativeEvent.layout.height)}
    >
      <HearthMap
        cameraRef={cameraRef}
        attributionPosition={{ bottom: COLLAPSED_BAR_HEIGHT + 12, left: 8 }}
        initialCenter={initialCenter}
        initialZoom={firstLocated ? 13 : 4}
        onDidFinishLoadingMap={() => setMapReady(true)}
        onPress={() => {
          setSelectedUserId(null)
          setSwitcherOpen(false)
        }}
      >
        <PlaceLayers places={places ?? []} />
        {trail && trail.length > 1 ? <TrailLayer id="trail" points={trail} /> : null}
        {(members ?? []).map((member) => {
          const entry = presenceByUser.get(member.userId)
          if (!entry || entry.lat == null || entry.lon == null) return null
          const isSelf = member.userId === me?.id
          return (
            <Marker key={member.userId} lngLat={[entry.lon, entry.lat]} anchor="bottom">
              <MemberMarker
                user={member.user}
                label={isSelf ? translate("map:you") : (member.nickname ?? member.user.displayName)}
                presence={entry}
                ring={ringFor(entry, isSelf)}
                selected={selectedUserId === member.userId}
                onPress={() => focusMember(entry, member.userId)}
              />
            </Marker>
          )
        })}
      </HearthMap>

      <View pointerEvents="box-none" style={[themed($top), { paddingTop: insets.top + 8 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
          <Pressable
            onPress={() => setSwitcherOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel={translate("circles:switch")}
            style={{ flex: 1 }}
          >
            <GlassPanel radius={20} style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text size="md">{circle?.emoji ?? "🏠"}</Text>
                <Text weight="semiBold" size="sm" numberOfLines={1} style={{ flex: 1 }}>
                  {circle?.name ?? ""}
                </Text>
                <Text size="xxs" style={{ color: theme.colors.textDim }}>
                  {translate("circles:members", {
                    count: members?.length ?? circle?.memberCount ?? 0,
                  })}
                </Text>
                <Ionicons
                  name={switcherOpen ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={theme.colors.textDim}
                />
              </View>
            </GlassPanel>
          </Pressable>
          <IconButton
            icon="chatbubble-ellipses-outline"
            tone="glass"
            accessibilityLabel={translate("messages:title")}
            onPress={() => circle && navigation.navigate("Messages", { circleId: circle.id })}
          />
          <IconButton
            icon="settings-outline"
            tone="glass"
            accessibilityLabel={translate("circle:title")}
            onPress={() => circle && navigation.navigate("Circle", { circleId: circle.id })}
          />
        </View>

        {switcherOpen ? (
          <Animated.View entering={FadeInUp.duration(180)} exiting={FadeOutUp.duration(140)}>
            <GlassPanel radius={20} style={{ marginTop: theme.spacing.xs, paddingVertical: 6 }}>
              {circles.map((candidate) => (
                <Pressable
                  key={candidate.id}
                  onPress={() => {
                    setActiveCircle(candidate.id)
                    setSwitcherOpen(false)
                    setSelectedUserId(null)
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  <Text size="md">{candidate.emoji ?? "🏠"}</Text>
                  <Text
                    weight={candidate.id === circle?.id ? "semiBold" : "normal"}
                    size="sm"
                    style={{ flex: 1 }}
                  >
                    {candidate.name}
                  </Text>
                  {candidate.unreadEventCount > 0 ? (
                    <Pill text={String(candidate.unreadEventCount)} tone="tint" />
                  ) : null}
                  {candidate.id === circle?.id ? (
                    <Ionicons name="checkmark" size={16} color={theme.colors.tint} />
                  ) : null}
                </Pressable>
              ))}
              <View style={{ flexDirection: "row", gap: 8, padding: 10 }}>
                <PrimaryButton
                  tx="circles:create"
                  variant="soft"
                  onPress={() => navigation.navigate("CreateCircle")}
                  style={{ flex: 1 }}
                />
                <PrimaryButton
                  tx="circles:join"
                  variant="soft"
                  onPress={() => navigation.navigate("JoinCircle")}
                  style={{ flex: 1 }}
                />
              </View>
            </GlassPanel>
          </Animated.View>
        ) : null}

        {activeSos && activeSos.length > 0 ? (
          <Pressable
            onPress={() =>
              focusMember(presenceByUser.get(activeSos[0]!.user.id), activeSos[0]!.user.id)
            }
          >
            <View style={[themed($banner), { backgroundColor: theme.colors.error }]}>
              <Ionicons name="alert-circle" size={18} color="#FFFFFF" />
              <Text size="xs" weight="semiBold" style={{ color: "#FFFFFF", flex: 1 }}>
                {translate("sos:active", { name: activeSos[0]!.user.displayName })} ·{" "}
                {translate("sos:activeBody")}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {trackingEnabled && permission !== "always" ? (
          <Pressable onPress={() => navigation.navigate("Permissions")}>
            <GlassPanel
              radius={16}
              style={{ marginTop: theme.spacing.xs, paddingHorizontal: 12, paddingVertical: 10 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="warning-outline" size={16} color={theme.colors.warning} />
                <Text
                  size="xs"
                  style={{ flex: 1 }}
                  tx={permission === "denied" ? "permissions:deniedTitle" : "permissions:whyTitle"}
                />
                <Text
                  size="xs"
                  weight="semiBold"
                  style={{ color: theme.colors.tint }}
                  tx="permissions:always"
                />
              </View>
            </GlassPanel>
          </Pressable>
        ) : null}

        {mySharingPaused ? (
          <Pressable
            onPress={() => circle && navigation.navigate("Sharing", { circleId: circle.id })}
          >
            <GlassPanel
              radius={16}
              style={{ marginTop: theme.spacing.xs, paddingHorizontal: 12, paddingVertical: 10 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="eye-off-outline" size={16} color={theme.colors.textDim} />
                <Text size="xs" style={{ flex: 1 }} tx="map:sharingOff" />
                <Text
                  size="xs"
                  weight="semiBold"
                  style={{ color: theme.colors.tint }}
                  tx="map:turnOn"
                />
              </View>
            </GlassPanel>
          </Pressable>
        ) : null}
      </View>

      <Animated.View pointerEvents="box-none" style={[themed($controls), controlsStyle]}>
        <IconButton
          icon="scan-outline"
          tone="glass"
          accessibilityLabel={translate("map:recenter")}
          onPress={fitAll}
        />
        <IconButton
          icon="locate"
          tone="glass"
          accessibilityLabel={translate("map:you")}
          onPress={() => me && focusMember(presenceByUser.get(me.id), me.id)}
        />
      </Animated.View>

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        animatedPosition={sheetTop}
        backgroundStyle={{ backgroundColor: theme.colors.surface, borderRadius: 28 }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive, width: 44 }}
      >
        <View style={themed($sheetHeading)}>
          <Ionicons name="people" size={16} color={theme.colors.tint} />
          <Text size="xs" weight="semiBold" tx="map:members" />
          <Text size="xs" style={{ color: theme.colors.textDim }}>
            {members?.length ?? 0}
          </Text>
        </View>

        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            paddingBottom: theme.spacing.sm,
          }}
        >
          <PrimaryButton
            tx="map:checkIn"
            variant="soft"
            onPress={() => circle && navigation.navigate("CheckIn", { circleId: circle.id })}
            style={{ flex: 1 }}
            Left={<Ionicons name="checkmark-circle-outline" size={18} color={theme.colors.tint} />}
          />
          <PrimaryButton
            tx="map:sos"
            variant="danger"
            onPress={() => circle && navigation.navigate("Sos", { circleId: circle.id })}
            style={{ flex: 1 }}
            Left={<Ionicons name="alert-circle-outline" size={18} color="#FFFFFF" />}
          />
        </View>
        <BottomSheetFlatList
          data={members ?? []}
          keyExtractor={(member) => member.userId}
          contentContainerStyle={{ paddingBottom: theme.spacing.lg }}
          renderItem={({ item }) => (
            <MemberRow
              member={item}
              presence={presenceByUser.get(item.userId)}
              isSelf={item.userId === me?.id}
              units={units}
              onPress={() => focusMember(presenceByUser.get(item.userId), item.userId)}
              onLongPress={() =>
                circle &&
                navigation.navigate("MemberDetail", { circleId: circle.id, userId: item.userId })
              }
            />
          )}
          ListFooterComponent={
            selectedUserId && circle ? (
              <View style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm }}>
                <PrimaryButton
                  text={translate("member:title")}
                  variant="ghost"
                  onPress={() =>
                    navigation.navigate("MemberDetail", {
                      circleId: circle.id,
                      userId: selectedUserId,
                    })
                  }
                  Left={
                    <Avatar
                      user={
                        members?.find((member) => member.userId === selectedUserId)?.user ?? {
                          displayName: "?",
                          avatarColor: "#888",
                          avatarUrl: null,
                        }
                      }
                      size={22}
                    />
                  }
                />
              </View>
            ) : null
          }
        />
      </BottomSheet>
    </GestureHandlerRootView>
  )
}

const $sheetHeading: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  paddingBottom: spacing.sm,
})

const $top: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  position: "absolute",
  top: 0,
  left: spacing.sm,
  right: spacing.sm,
})
const $controls: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  position: "absolute",
  right: spacing.sm,
  gap: spacing.xs,
})
const $banner: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginTop: spacing.xs,
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  paddingHorizontal: 12,
  paddingVertical: 10,
  borderRadius: 16,
})

const $empty: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flex: 1,
  backgroundColor: colors.background,
  alignItems: "center",
  justifyContent: "center",
  paddingHorizontal: spacing.xl,
  gap: spacing.sm,
})
