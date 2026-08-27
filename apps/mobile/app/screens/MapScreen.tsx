import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
} from "react"
import {
  AppState,
  BackHandler,
  Pressable,
  View,
  type AppStateStatus,
  type ViewStyle,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet"
import type { CircleMember, MemberPresence } from "@hearth/shared"
import { Marker, type CameraRef, type MapRef } from "@maplibre/maplibre-react-native"
import { useFocusEffect } from "@react-navigation/native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import Animated, {
  Extrapolation,
  FadeInUp,
  FadeOutUp,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { GlassPanel } from "@/components/GlassPanel"
import { HearthMap } from "@/components/HearthMap"
import { IconButton } from "@/components/IconButton"
import {
  faceAtOffset,
  MemberMarker,
  MEMBER_MARKER_LABEL_HEIGHT,
  type MarkerFace,
} from "@/components/MemberMarker"
import { ListGroup } from "@/components/ListRow"
import { MemberRow, ringFor } from "@/components/MemberRow"
import { Pill } from "@/components/Pill"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Text } from "@/components/Text"
import { useActiveSos, useMembers, usePresence } from "@/hooks/queries"
import { useActiveCircle } from "@/hooks/useActiveCircle"
import { translate } from "@/i18n/translate"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { currentPermission, flush } from "@/services/location/tracker"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { fitBoundsFor } from "@/utils/map"
import { groupOverlapping, type MarkerGroup } from "@/utils/markerLayout"

const FALLBACK_CENTER: [number, number] = [-0.1276, 51.5072]
// The circle switcher row hangs this far below the status bar, and the map
// controls stop at the same offset when the sheet pushes them up. One constant
// for both, so neither can drift under the bar on its own.
const TOP_CLUSTER_PADDING = 8
const CONTROLS_HEIGHT = 96
const CONTROLS_SHEET_GAP = 12
// The controls fade over the last stretch before they would land on the
// settings button, which is what sits at their ceiling. It mirrors IconButton's
// default size, so the controls are gone by the time they could cover it.
const CONTROLS_FADE_DISTANCE = 44
/** Any taller and the tops of the check in and SOS buttons peek out under it. */
const COLLAPSED_BAR_HEIGHT = 52

// The rows below are memoised, so a member who has stopped moving stops
// producing renders, and the relative time in their status line would sit at
// "just now" until they moved again. One shared interval keeps every mounted
// row's clock honest without waking the screen around them.
//
// It runs only while the sheet is in front of somebody. The tab navigator keeps
// this screen mounted after its first visit, so a ticker tied to the mount
// would go on re-rendering every row behind Places, Activity and You, and
// behind a backgrounded app. Nothing is lost by stopping: coming back is what
// catches the clocks up, and it does so at once rather than at the next minute.
const minuteListeners = new Set<() => void>()
let minuteTimer: ReturnType<typeof setInterval> | undefined
let minuteCount = 0
let minuteVisible = false
/** Set only by a stop, so the first start of all is not mistaken for a return. */
let minutePausedAt: number | undefined

function notifyMinute() {
  minuteCount += 1
  for (const notify of [...minuteListeners]) notify()
}

function syncMinuteTimer() {
  const shouldRun = minuteVisible && minuteListeners.size > 0
  if (shouldRun === (minuteTimer !== undefined)) return
  if (shouldRun) {
    minuteTimer = setInterval(notifyMinute, 60_000)
  } else {
    clearInterval(minuteTimer)
    minuteTimer = undefined
  }
}

function subscribeToMinute(listener: () => void): () => void {
  minuteListeners.add(listener)
  syncMinuteTimer()
  return () => {
    minuteListeners.delete(listener)
    syncMinuteTimer()
  }
}

/** Driven by the one screen the rows live on. */
function setMinuteTickerVisible(visible: boolean) {
  if (visible === minuteVisible) return
  minuteVisible = visible
  if (!visible) {
    minutePausedAt = Date.now()
  } else if (minutePausedAt !== undefined && Date.now() - minutePausedAt >= 60_000) {
    // Long enough away that the times on screen are wrong right now. Waiting
    // for the first tick would leave them wrong for up to another minute.
    notifyMinute()
  }
  syncMinuteTimer()
}

interface SheetRowProps {
  member: CircleMember
  presence: MemberPresence | undefined
  isSelf: boolean
  units: "metric" | "imperial"
  onPress: (userId: string) => void
  onLongPress: (userId: string) => void
}

// A `location` frame replaces one entry in the presence array and leaves every
// other member's object identity alone, so the props here compare equal for
// everybody who did not move. Without the memo all of the rows re-render on
// every frame: VirtualizedList hands `renderItem` down to a PureComponent cell
// and that closure is new on each render of the screen. The handlers take a
// user id for the same reason, so the list can pass one stable function down
// rather than a fresh arrow per row.
const SheetRow = memo(function SheetRow({
  member,
  presence,
  isSelf,
  units,
  onPress,
  onLongPress,
}: SheetRowProps) {
  useSyncExternalStore(subscribeToMinute, () => minuteCount)
  return (
    <MemberRow
      member={member}
      presence={presence}
      isSelf={isSelf}
      units={units}
      onPress={() => onPress(member.userId)}
      onLongPress={() => onLongPress(member.userId)}
    />
  )
})

/**
 * How long after a marker tap the map's own report of a tap is taken to be
 * the same tap. Nobody taps empty map to dismiss a card they chose a
 * second ago; iOS reports the marker's tap to the map that late.
 */
const MAP_TAP_AFTER_MARKER_MS = 1_200

export const MapScreen: FC<MainTabScreenProps<"Map">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const me = useAuthStore((state) => state.user)
  const units = useSettingsStore((state) => state.units)
  const permission = useTrackingStore((state) => state.permission)
  const servicesEnabled = useTrackingStore((state) => state.servicesEnabled)
  const trackingEnabled = useTrackingStore((state) => state.enabled)
  const { circle, circles, isLoading, setActiveCircle } = useActiveCircle()
  const circleId = circle?.id ?? null

  const { data: members } = useMembers(circleId)
  const { data: presence } = usePresence(circleId)
  const { data: activeSos } = useActiveSos(circleId)

  const cameraRef = useRef<CameraRef>(null)
  const mapRef = useRef<MapRef>(null)
  const sheetRef = useRef<BottomSheet>(null)
  const sheetIndex = useRef(0)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  // Read inside the marker callback, which must stay stable or every marker
  // re-renders on each selection.
  const selectedRef = useRef<string | null>(null)
  // A tap on a marker reaches the map as well, later, and the map's press
  // handler clears the selection. On Android it is a moment later. On iOS
  // the map recognises a single tap only once its double-tap recogniser has
  // given up, a third of a second after the face's own Pressable fired, and
  // later still while the JS thread is drawing the card and flying the
  // camera; a face tapped there used to light up and go dark again.
  const markerTapAt = useRef(0)
  const lastTap = useRef<{ userId: string; at: number } | null>(null)

  const clearSelection = useCallback(() => {
    selectedRef.current = null
    setSelectedUserId(null)
  }, [])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const fittedCircleRef = useRef<string | null>(null)

  // Whether two markers overlap depends on the zoom, so the map reports it
  // while a pinch is still going. Half a zoom level is close enough to decide
  // who touches whom, and rounding keeps a gesture from re-rendering the
  // screen on every frame.
  const [zoom, setZoom] = useState(13)
  const trackZoom = useCallback((event: { nativeEvent: { zoom: number } }) => {
    const next = Math.round(event.nativeEvent.zoom * 2) / 2
    setZoom((previous) => (previous === next ? previous : next))
  }, [])
  const [markerWidths, setMarkerWidths] = useState<ReadonlyMap<string, number>>(new Map())
  const measureMarker = useCallback((userId: string, width: number) => {
    setMarkerWidths((previous) =>
      previous.get(userId) === width ? previous : new Map(previous).set(userId, width),
    )
  }, [])

  // The phone's own latest fix beats the server's copy of it: the dot moves
  // the moment the fix lands rather than after the upload and the frame back.
  const myFix = useTrackingStore((state) => state.lastFix)
  const presenceByUser = useMemo(() => {
    const byUser = new Map((presence ?? []).map((entry) => [entry.userId, entry]))
    const mine = me ? byUser.get(me.id) : undefined
    if (
      mine &&
      myFix &&
      mine.sharingState !== "paused" &&
      (!mine.recordedAt || Date.parse(myFix.recordedAt) > Date.parse(mine.recordedAt))
    ) {
      byUser.set(me!.id, {
        ...mine,
        lat: myFix.lat,
        lon: myFix.lon,
        recordedAt: myFix.recordedAt,
        speedMps: myFix.speedMps ?? mine.speedMps,
        stale: false,
      })
    }
    return byUser
  }, [presence, me, myFix])
  const located = useMemo(
    () => (presence ?? []).filter((entry) => entry.lat != null && entry.lon != null),
    [presence],
  )
  const groups = useMemo(
    () =>
      groupOverlapping(
        (members ?? []).flatMap((member) => {
          const entry = presenceByUser.get(member.userId)
          return entry && entry.lat != null && entry.lon != null
            ? [{ id: member.userId, lat: entry.lat, lon: entry.lon }]
            : []
        }),
        zoom,
        markerWidths,
      ),
    [members, presenceByUser, zoom, markerWidths],
  )
  const myMembership = members?.find((member) => member.userId === me?.id)
  const mySharingPaused = myMembership?.sharingState === "paused"

  const selectedMember = selectedUserId
    ? members?.find((member) => member.userId === selectedUserId)
    : undefined

  useFocusEffect(
    useCallback(() => {
      void currentPermission().then((level) => useTrackingStore.getState().setPermission(level))
      void flush()
    }, []),
  )

  // The sheet pulled up over the map is a page of its own to whoever pulled
  // it, so the back button brings it down. Left to the navigator, the tab is
  // the root and the button leaves the app.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (sheetIndex.current <= 1) return false
        sheetRef.current?.snapToIndex(1)
        return true
      })
      return () => subscription.remove()
    }, []),
  )

  // Opening the map is the moment to ask the quiet phones for a fix. The
  // server decides who is quiet and how often any one phone may be asked;
  // this only says somebody is looking, once per look and again when the
  // app comes back to the front with the map still up.
  useFocusEffect(
    useCallback(() => {
      if (!circleId) return
      const ask = () => {
        endpoints.locations.refresh(circleId).catch(() => undefined)
      }
      ask()
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") ask()
      })
      return () => subscription.remove()
    }, [circleId]),
  )

  useFocusEffect(
    useCallback(() => {
      // Only "background" means nobody can see the sheet. iOS reports
      // "inactive" for a control centre pull or a call banner, which is not
      // worth tearing the interval down and rebuilding it for.
      const sync = (state: AppStateStatus) => setMinuteTickerVisible(state !== "background")
      sync(AppState.currentState)
      const subscription = AppState.addEventListener("change", sync)
      return () => {
        subscription.remove()
        setMinuteTickerVisible(false)
      }
    }, []),
  )

  // Fit everyone once per circle, on its first data. After that the camera
  // belongs to the user. Keyed on the circle rather than a plain flag, because
  // switching between two circles with the same number of located members
  // changes neither `mapReady` nor `located.length`.
  useEffect(() => {
    if (!mapReady || !circleId || located.length === 0) return
    if (fittedCircleRef.current === circleId) return
    fittedCircleRef.current = circleId
    fitAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, circleId, located.length])

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

  // Presence is read through a ref so this handler keeps a stable identity:
  // it is passed straight to the memoised markers, which would otherwise all
  // re-render whenever one member moves.
  const presenceRef = useRef(presenceByUser)
  presenceRef.current = presenceByUser

  const openMember = useCallback(
    (userId: string) => {
      if (!circleId) return
      navigation.navigate("MemberDetail", { circleId, userId })
    },
    [circleId, navigation],
  )

  // One tap on a face is "show me where they are", so the map stays and the
  // sheet comes up just far enough to name them. A second tap on the same
  // face is the answer to "and now tell me more". Collapsing the sheet all
  // the way used to hide the only route to that page.
  const focusMember = useCallback(
    (userId: string) => {
      // One tap can arrive twice, from the marker's own Pressable and from the
      // map's hit test, and the second must not read as the tap that opens
      // the page. A deliberate second tap comes after the card has drawn.
      const now = Date.now()
      if (lastTap.current?.userId === userId && now - lastTap.current.at < 400) return
      lastTap.current = { userId, at: now }
      if (selectedRef.current === userId) {
        openMember(userId)
        return
      }
      markerTapAt.current = now
      selectedRef.current = userId
      setSelectedUserId(userId)
      sheetRef.current?.snapToIndex(1)
      const entry = presenceRef.current.get(userId)
      if (entry?.lat != null && entry.lon != null) {
        cameraRef.current?.flyTo({
          center: [entry.lon, entry.lat],
          zoom: 15.5,
          duration: 700,
          padding: { bottom: 200 },
        })
      }
    },
    [openMember],
  )

  // Android's map does its own hit test on a tap and, when it finds a
  // marker, reports it here and swallows the touch. Which phones take that
  // path and which let the touch reach the Pressable inside varies, so both
  // lead to the same place. This path only knows the marker, so for a stack
  // of faces it works out which one from where the touch landed.
  const pressMarker = useCallback(
    async (group: MarkerGroup, point?: [number, number]) => {
      let userId = group.ids[0]!
      if (group.ids.length > 1 && point) {
        try {
          const anchorPoint = await mapRef.current?.project([group.lon, group.lat])
          if (anchorPoint)
            userId = group.ids[faceAtOffset(group.ids.length, point[0] - anchorPoint[0])]!
        } catch {
          // The first face is a fair answer when the map cannot say.
        }
      }
      focusMember(userId)
    },
    [focusMember],
  )

  // The tab navigator already insets this screen above the tab bar, so bottom:0
  // here is the top of the bar. Do not add its height again.
  const restingSheetHeight = 210
  // The lowest point is a real snap, not a separate bar pretending to be one.
  // A grabber that only answers taps reads as a broken sheet. The percentages
  // are of the area below the status bar, because `topInset` keeps the sheet
  // out of it: 100% meets the bar exactly instead of stopping short of it, and
  // 55% lands a little lower than it would against the whole screen. The top
  // snap covers the circle switcher row and the banners, which is fine because
  // the sheet renders after them and takes the touches.
  const snapPoints = useMemo(() => [COLLAPSED_BAR_HEIGHT, restingSheetHeight, "55%", "100%"], [])

  // The controls ride the sheet rather than jumping between two fixed offsets.
  // `animatedPosition` is the sheet's top edge as a shared value, so this runs
  // on the UI thread and keeps them glued to the sheet. It has to be a
  // translation and not `top`: a layout prop would dirty the shadow node and
  // run Yoga over this subtree on every frame of every drag and snap.
  const sheetTop = useSharedValue(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const ceiling = insets.top + TOP_CLUSTER_PADDING
  const controlsTop = useDerivedValue(() => {
    // Once the sheet is dismissed it parks off-screen, so clamp the controls to
    // just above the collapsed bar rather than letting them follow it down.
    const floor = containerHeight > 0 ? containerHeight - COLLAPSED_BAR_HEIGHT : sheetTop.value
    return Math.min(sheetTop.value, floor) - CONTROLS_HEIGHT - CONTROLS_SHEET_GAP
  })
  const controlsStyle = useAnimatedStyle(() => ({
    // Near the top the sheet would push them under the status bar. They stop
    // level with the circle switcher row and fade out on the way there. At the
    // top snap the sheet covers them anyway.
    transform: [{ translateY: Math.max(controlsTop.value, ceiling) }],
    opacity: interpolate(
      controlsTop.value,
      [ceiling, ceiling + CONTROLS_FADE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }))
  // A faded button is still a Pressable, and while parked the column sits on
  // top of the settings button. The flag only flips at one threshold, so it
  // hops to React state the way the sheet's own backdrop does rather than
  // being driven from the animated style.
  const [controlsHidden, setControlsHidden] = useState(true)
  useAnimatedReaction(
    () => controlsTop.value < ceiling + CONTROLS_FADE_DISTANCE,
    (hidden, previous) => {
      if (hidden !== previous) runOnJS(setControlsHidden)(hidden)
    },
  )

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
        ref={mapRef}
        cameraRef={cameraRef}
        attributionPosition={{ bottom: COLLAPSED_BAR_HEIGHT + 12, left: 8 }}
        initialCenter={initialCenter}
        initialZoom={firstLocated ? 13 : 4}
        onDidFinishLoadingMap={() => setMapReady(true)}
        onRegionIsChanging={trackZoom}
        onRegionDidChange={trackZoom}
        onPress={() => {
          setSwitcherOpen(false)
          if (Date.now() - markerTapAt.current < MAP_TAP_AFTER_MARKER_MS) return
          clearSelection()
        }}
      >
        {groups.map((group) => {
          const faces = group.ids.flatMap((userId): MarkerFace[] => {
            const member = members?.find((candidate) => candidate.userId === userId)
            const entry = presenceByUser.get(userId)
            if (!member || !entry) return []
            const isSelf = userId === me?.id
            return [
              {
                userId,
                user: member.user,
                label: isSelf ? translate("map:you") : (member.nickname ?? member.user.displayName),
                presence: entry,
                ring: ringFor(entry, isSelf),
                selected: selectedUserId === userId,
              },
            ]
          })
          return (
            <Marker
              key={group.key}
              lngLat={[group.lon, group.lat]}
              anchor="bottom"
              // Puts the pointer tip on the coordinate instead of the name pill.
              offset={[0, MEMBER_MARKER_LABEL_HEIGHT]}
              onPress={(event) => void pressMarker(group, event?.nativeEvent?.point)}
            >
              <MemberMarker
                markerKey={group.key}
                faces={faces}
                onPress={focusMember}
                onMeasure={measureMarker}
              />
            </Marker>
          )
        })}
      </HearthMap>

      <View
        pointerEvents="box-none"
        style={[themed($top), { paddingTop: insets.top + TOP_CLUSTER_PADDING }]}
      >
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
                    clearSelection()
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
          // Your own SOS is in that list too, and "Sarah needs help" on
          // Sarah's phone reads like someone else's alarm. It is the way
          // back to the SOS screen to call it off.
          <Pressable
            onPress={() =>
              activeSos[0]!.user.id === me?.id
                ? circle && navigation.navigate("Sos", { circleId: circle.id })
                : focusMember(activeSos[0]!.user.id)
            }
          >
            <View style={[themed($banner), { backgroundColor: theme.colors.error }]}>
              <Ionicons name="alert-circle" size={18} color="#FFFFFF" />
              <Text size="xs" weight="semiBold" style={{ color: "#FFFFFF", flex: 1 }}>
                {activeSos[0]!.user.id === me?.id
                  ? `${translate("sos:mine")} · ${translate("sos:mineBody")}`
                  : `${translate("sos:active", { name: activeSos[0]!.user.displayName })} · ${translate("sos:activeBody")}`}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {trackingEnabled && (permission !== "always" || !servicesEnabled) ? (
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
                  tx={
                    !servicesEnabled
                      ? "permissions:servicesOffTitle"
                      : permission === "denied"
                        ? "permissions:deniedTitle"
                        : "permissions:whyTitle"
                  }
                />
                <Text
                  size="xs"
                  weight="semiBold"
                  style={{ color: theme.colors.tint }}
                  tx={!servicesEnabled ? "permissions:openSettings" : "permissions:always"}
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

      <Animated.View
        pointerEvents={controlsHidden ? "none" : "box-none"}
        accessibilityElementsHidden={controlsHidden}
        importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
        style={[themed($controls), controlsStyle]}
      >
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
          onPress={() => me && focusMember(me.id)}
        />
      </Animated.View>

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        onChange={(index) => {
          sheetIndex.current = index
        }}
        topInset={insets.top}
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

        {selectedMember ? (
          <ListGroup
            style={{
              marginBottom: theme.spacing.sm,
              borderColor: theme.colors.tint,
              borderWidth: 1,
            }}
          >
            <MemberRow
              member={selectedMember}
              presence={presenceByUser.get(selectedMember.userId)}
              isSelf={selectedMember.userId === me?.id}
              units={units}
              onPress={() => openMember(selectedMember.userId)}
            />
          </ListGroup>
        ) : null}

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
            <SheetRow
              member={item}
              presence={presenceByUser.get(item.userId)}
              isSelf={item.userId === me?.id}
              units={units}
              onPress={openMember}
              onLongPress={focusMember}
            />
          )}
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
  // The animated style translates from here, so the origin has to be pinned
  // rather than left to fall out of the flow position.
  top: 0,
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
