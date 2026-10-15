import { Fragment, useState, type FC } from "react"
import { StyleSheet, View, type TextStyle, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { GlassPanel } from "@/components/GlassPanel"
import { HearthMap } from "@/components/HearthMap"
import { ListGroup, ListRow } from "@/components/ListRow"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { mapStylesFor, useChosenMapStyle } from "@/hooks/useMapStyle"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore, type MapScheme } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { haptics } from "@/utils/haptics"
import { FALLBACK_CENTER } from "@/utils/map"
import { useHeader } from "@/utils/useHeader"

const SCHEMES: MapScheme[] = ["light", "dark"]

export const MapStyleScreen: FC<AppStackScreenProps<"MapStyle">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const info = useAuthStore((state) => state.serverInfo)
  const setMapStyle = useSettingsStore((state) => state.setMapStyle)
  const lastFix = useTrackingStore((state) => state.lastFix)
  const chosen = { light: useChosenMapStyle("light"), dark: useChosenMapStyle("dark") }
  // The preview follows the last tap rather than the app's theme, so a dark
  // style can be seen before the phone next turns dark.
  const [previewing, setPreviewing] = useState<MapScheme>(theme.isDark ? "dark" : "light")

  useHeader(
    { titleTx: "mapStyle:title", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const preview = chosen[previewing]

  const pick = (scheme: MapScheme, id: string) => {
    haptics.select()
    setMapStyle(scheme, id)
    setPreviewing(scheme)
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <View
        style={themed($preview)}
        // Scrolling the page over the preview has to move the page, not try
        // to pan a map that is only there to be looked at.
        pointerEvents="none"
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          preview.name ? translate("mapStyle:previewOf", { name: preview.name }) : undefined
        }
      >
        <HearthMap
          styleUrl={preview.url}
          initialCenter={lastFix ? [lastFix.lon, lastFix.lat] : FALLBACK_CENTER}
          initialZoom={14}
          dragPan={false}
          touchZoom={false}
          touchRotate={false}
          doubleTapZoom={false}
          doubleTapHoldZoom={false}
        />
        {preview.name ? (
          <GlassPanel radius={999} style={themed($chip)}>
            <Ionicons
              name={previewing === "dark" ? "moon-outline" : "sunny-outline"}
              size={14}
              color={theme.colors.text}
            />
            <Text size="xs" weight="medium" text={preview.name} />
          </GlassPanel>
        ) : null}
      </View>

      {SCHEMES.map((scheme) => {
        const styles = mapStylesFor(info, scheme)
        if (styles.length === 0) return null
        return (
          <Fragment key={scheme}>
            <SectionHeader tx={scheme === "dark" ? "mapStyle:dark" : "mapStyle:light"} />
            <ListGroup>
              {styles.map((style) => (
                <ListRow
                  key={style.id}
                  text={style.name}
                  selected={style.id === chosen[scheme].id}
                  onPress={() => pick(scheme, style.id)}
                />
              ))}
            </ListGroup>
          </Fragment>
        )
      })}

      <Text size="xs" tx="mapStyle:footnote" style={themed($footnote)} />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingTop: spacing.sm,
  paddingBottom: spacing.xxl,
})
const $preview: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  height: 200,
  marginHorizontal: spacing.md,
  borderRadius: 20,
  overflow: "hidden",
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.border,
})
const $chip: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  position: "absolute",
  top: spacing.sm,
  left: spacing.sm,
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.xxs,
  paddingHorizontal: spacing.sm,
  paddingVertical: spacing.xxs,
})
const $footnote: ThemedStyle<TextStyle> = ({ colors, spacing }) => ({
  color: colors.textDim,
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.md,
})
