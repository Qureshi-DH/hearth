import { useEffect, useMemo, useRef, useState, type FC } from "react"
import { Alert, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { DEFAULTS, PLACE_ICONS, type PlaceIcon } from "@hearth/shared"
import { GeoJSONSource, Layer, type CameraRef, type MapRef } from "@maplibre/maplibre-react-native"

import { HearthMap } from "@/components/HearthMap"
import { IconButton } from "@/components/IconButton"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useDeletePlace, usePlaces, useSavePlace } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { reportNow } from "@/services/location/tracker"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { placeIconName } from "@/utils/activity"
import { formatRadius } from "@/utils/format"
import { circlePolygon, zoomForRadius } from "@/utils/map"
import { useHeader } from "@/utils/useHeader"

const RADIUS_STEPS = [50, 100, 150, 250, 400, 600, 1000, 1500, 2500, 5000]

/**
 * The map is the control. The place sits under a fixed crosshair and the user
 * pans the map beneath it, which is more precise on a phone than dragging a pin.
 */
export const PlaceEditorScreen: FC<AppStackScreenProps<"PlaceEditor">> = ({
  navigation,
  route,
}) => {
  const { circleId, placeId } = route.params
  const { themed, theme } = useAppTheme()
  const units = useSettingsStore((state) => state.units)
  const lastFix = useTrackingStore((state) => state.lastFix)
  const { data: places } = usePlaces(circleId)
  const existing = places?.find((place) => place.id === placeId)
  const save = useSavePlace(circleId)
  const remove = useDeletePlace(circleId)

  const mapRef = useRef<MapRef>(null)
  const cameraRef = useRef<CameraRef>(null)
  const [name, setName] = useState(existing?.name ?? "")
  const [icon, setIcon] = useState<PlaceIcon>(existing?.icon ?? "home")
  const [radius, setRadius] = useState(existing?.radiusMeters ?? DEFAULTS.defaultPlaceRadiusMeters)
  const [center, setCenter] = useState<{ lat: number; lon: number }>(() => {
    if (existing) return { lat: existing.lat, lon: existing.lon }
    if (route.params.lat != null && route.params.lon != null)
      return { lat: route.params.lat, lon: route.params.lon }
    if (lastFix) return { lat: lastFix.lat, lon: lastFix.lon }
    return { lat: 51.5072, lon: -0.1276 }
  })

  useHeader(
    {
      titleTx: existing ? "places:edit" : "places:add",
      leftIcon: "x",
      onLeftPress: () => navigation.goBack(),
    },
    [existing?.id, navigation],
  )

  useEffect(() => {
    if (existing) {
      setName(existing.name)
      setIcon(existing.icon ?? "home")
      setRadius(existing.radiusMeters)
      setCenter({ lat: existing.lat, lon: existing.lon })
    }
  }, [existing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => circlePolygon(center, radius), [center, radius])

  const stepRadius = (direction: -1 | 1) => {
    const index = RADIUS_STEPS.findIndex((step) => step >= radius)
    const nextIndex = Math.min(
      RADIUS_STEPS.length - 1,
      Math.max(0, (index === -1 ? RADIUS_STEPS.length - 1 : index) + direction),
    )
    const next = RADIUS_STEPS[nextIndex]!
    setRadius(next)
    cameraRef.current?.zoomTo(zoomForRadius(next), { duration: 250 })
  }

  const useMyLocation = async () => {
    const fix = await reportNow("manual")
    if (!fix) return
    setCenter({ lat: fix.lat, lon: fix.lon })
    cameraRef.current?.flyTo({
      center: [fix.lon, fix.lat],
      zoom: zoomForRadius(radius),
      duration: 500,
    })
  }

  const submit = async () => {
    try {
      await save.mutateAsync({
        placeId,
        name: name.trim(),
        icon,
        lat: center.lat,
        lon: center.lon,
        radiusMeters: radius,
      })
      toast.success(translate("common:done"))
      navigation.goBack()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const destroy = () => {
    if (!existing) return
    Alert.alert(
      translate("common:delete"),
      translate("places:deleteConfirm", { name: existing.name }),
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("common:delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await remove.mutateAsync(existing.id)
              navigation.navigate("Main", { screen: "Places" })
            } catch (error) {
              toast.error((error as Error).message)
            }
          },
        },
      ],
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View style={themed($mapWrap)}>
        <HearthMap
          ref={mapRef}
          cameraRef={cameraRef}
          initialCenter={[center.lon, center.lat]}
          initialZoom={zoomForRadius(radius)}
          onRegionDidChange={(event) => {
            const [lon, lat] = event.nativeEvent.center
            setCenter({ lat, lon })
          }}
        >
          <GeoJSONSource id="editor-place" data={preview}>
            <Layer
              id="editor-fill"
              type="fill"
              paint={{ "fill-color": theme.colors.tint, "fill-opacity": 0.18 }}
            />
            <Layer
              id="editor-line"
              type="line"
              paint={{ "line-color": theme.colors.tint, "line-width": 2 }}
            />
          </GeoJSONSource>
        </HearthMap>
        <View pointerEvents="none" style={themed($crosshair)}>
          <Ionicons name={placeIconName(icon)} size={26} color="#FFFFFF" />
        </View>
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", right: 12, bottom: 12, gap: 8 }}
        >
          <IconButton
            icon="locate"
            tone="glass"
            accessibilityLabel={translate("places:useMyLocation")}
            onPress={useMyLocation}
          />
        </View>
        <View pointerEvents="none" style={themed($hint)}>
          <Text size="xxs" tx="places:dragHint" style={{ color: theme.colors.textDim }} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.md,
          gap: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <TextField
          value={name}
          onChangeText={setName}
          labelTx="places:name"
          placeholderTx="places:namePlaceholder"
          maxLength={80}
          inputWrapperStyle={themed($input)}
        />

        <View>
          <Text preset="formLabel" tx="places:icon" />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
          >
            {PLACE_ICONS.map((candidate) => {
              const active = candidate === icon
              return (
                <Pressable
                  key={candidate}
                  onPress={() => setIcon(candidate)}
                  style={[themed($iconChip), active && { backgroundColor: theme.colors.tint }]}
                >
                  <Ionicons
                    name={placeIconName(candidate)}
                    size={20}
                    color={active ? theme.colors.onTint : theme.colors.text}
                  />
                </Pressable>
              )
            })}
          </ScrollView>
        </View>

        <View>
          <Text preset="formLabel" tx="places:radius" />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.sm,
              marginTop: 6,
            }}
          >
            <IconButton
              icon="remove"
              accessibilityLabel="-"
              onPress={() => stepRadius(-1)}
              size={40}
            />
            <View style={{ flex: 1, alignItems: "center" }}>
              <Text weight="semiBold" size="lg">
                {formatRadius(radius, units)}
              </Text>
            </View>
            <IconButton icon="add" accessibilityLabel="+" onPress={() => stepRadius(1)} size={40} />
          </View>
          <Text
            size="xxs"
            tx="places:radiusHint"
            style={{ color: theme.colors.textFaint, marginTop: 4 }}
          />
        </View>

        <PrimaryButton
          tx="common:save"
          onPress={submit}
          loading={save.isPending}
          disabled={!name.trim()}
        />
        {existing ? <PrimaryButton tx="common:delete" variant="ghost" onPress={destroy} /> : null}
      </ScrollView>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
const $mapWrap: ThemedStyle<ViewStyle> = () => ({ height: 300 })
const $crosshair: ThemedStyle<ViewStyle> = ({ colors }) => ({
  position: "absolute",
  left: "50%",
  top: "50%",
  marginLeft: -22,
  marginTop: -44,
  width: 44,
  height: 44,
  borderRadius: 22,
  backgroundColor: colors.tint,
  alignItems: "center",
  justifyContent: "center",
  shadowColor: "#000",
  shadowOpacity: 0.3,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
})
const $hint: ThemedStyle<ViewStyle> = ({ colors }) => ({
  position: "absolute",
  left: 12,
  bottom: 12,
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 10,
  backgroundColor: colors.glass,
})
const $iconChip: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 44,
  height: 44,
  borderRadius: 14,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.surface,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
