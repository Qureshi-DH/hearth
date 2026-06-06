import { useEffect, useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"

import { ListGroup, ListRow } from "@/components/ListRow"
import { PrimaryButton } from "@/components/PrimaryButton"
import { PromptDialog } from "@/components/PromptDialog"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useCircle, useUpdateCircle } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { useHeader } from "@/utils/useHeader"

const RETENTION_OPTIONS = [0, 1, 7, 30, 90]
const INTERVAL_OPTIONS: Array<{
  seconds: number
  tx: "circle:intervalFast" | "circle:intervalNormal" | "circle:intervalSaver"
}> = [
  { seconds: 30, tx: "circle:intervalFast" },
  { seconds: 60, tx: "circle:intervalNormal" },
  { seconds: 300, tx: "circle:intervalSaver" },
]
const BATTERY_OPTIONS = [0.1, 0.15, 0.2, 0.3]
/** 0 disables speed alerts. Without that option a normal commute alerts every day. */
const SPEED_OPTIONS = [0, 80, 100, 120]

type CustomKey = "retention" | "interval" | "battery" | "speed"

/**
 * The presets cover the common answers, but a family that wants 45 days or
 * 90 km/h should not have to pick the nearest one. Bounds match what the
 * server accepts, so a rejected value is caught before the round trip.
 */
const CUSTOM: Record<
  CustomKey,
  {
    titleTx:
      "circle:customDays" | "circle:customInterval" | "circle:customBattery" | "circle:customSpeed"
    min: number
    max: number
  }
> = {
  retention: { titleTx: "circle:customDays", min: 0, max: 3650 },
  interval: { titleTx: "circle:customInterval", min: 10, max: 3600 },
  battery: { titleTx: "circle:customBattery", min: 1, max: 90 },
  speed: { titleTx: "circle:customSpeed", min: 0, max: 300 },
}

export const CircleSettingsScreen: FC<AppStackScreenProps<"CircleSettings">> = ({
  navigation,
  route,
}) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const circle = useCircle(circleId)
  const update = useUpdateCircle(circleId)
  const [name, setName] = useState(circle?.name ?? "")
  const [customFor, setCustomFor] = useState<CustomKey | null>(null)

  useHeader(
    { titleTx: "circle:settings", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  useEffect(() => {
    if (circle) setName(circle.name)
  }, [circle?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!circle) return <Screen preset="fixed" />

  const patchSettings = (patch: Partial<typeof circle.settings>) =>
    update.mutate(
      { settings: patch },
      { onError: (error) => toast.error((error as Error).message) },
    )

  const saveName = () => {
    if (name.trim() && name.trim() !== circle.name) {
      update.mutate(
        { name: name.trim() },
        {
          onSuccess: () => toast.success(translate("common:done")),
          onError: (error) => {
            toast.error((error as Error).message)
            // The reset effect is keyed on the server's name, which did not
            // change, so without this the field keeps showing a name nobody
            // else can see.
            setName(circle.name)
          },
        },
      )
    }
  }

  const chips = <T,>(
    options: T[],
    selected: T,
    label: (value: T) => string,
    onSelect: (value: T) => void,
    customKey?: CustomKey,
  ) => {
    // A value typed by hand is not in the preset list, so it needs a chip of
    // its own or the group would look like nothing is selected.
    const isPreset = options.some((option) => option === selected)
    return (
      <View style={themed($chips)}>
        {options.map((option) => {
          const active = option === selected
          return (
            <Pressable
              key={String(option)}
              onPress={() => onSelect(option)}
              style={[themed($chip), active && { backgroundColor: theme.colors.tint }]}
            >
              <Text
                size="xs"
                weight="medium"
                style={{ color: active ? theme.colors.onTint : theme.colors.text }}
              >
                {label(option)}
              </Text>
            </Pressable>
          )
        })}
        {!isPreset ? (
          <View style={[themed($chip), { backgroundColor: theme.colors.tint }]}>
            <Text size="xs" weight="medium" style={{ color: theme.colors.onTint }}>
              {label(selected)}
            </Text>
          </View>
        ) : null}
        {customKey ? (
          <Pressable onPress={() => setCustomFor(customKey)} style={themed($chip)}>
            <Text
              size="xs"
              weight="medium"
              tx="circle:custom"
              style={{ color: theme.colors.tint }}
            />
          </Pressable>
        ) : null}
      </View>
    )
  }

  /**
   * A custom value has no preset to name it, and falling back to the nearest
   * preset's label made the chip claim to be something it was not.
   */
  const intervalLabel = (seconds: number) => {
    const preset = INTERVAL_OPTIONS.find((option) => option.seconds === seconds)
    if (preset) return translate(preset.tx)
    return seconds % 60 === 0
      ? translate("circle:intervalMinutes", { count: seconds / 60 })
      : translate("circle:intervalSeconds", { count: seconds })
  }

  const currentCustom = (key: CustomKey) =>
    key === "retention"
      ? circle.settings.historyRetentionDays
      : key === "interval"
        ? circle.settings.minUpdateIntervalSeconds
        : key === "battery"
          ? Math.round(circle.settings.lowBatteryThreshold * 100)
          : (circle.settings.speedAlertKmh ?? 0)

  const applyCustom = (key: CustomKey, raw: string) => {
    const { min, max } = CUSTOM[key]
    const value = Number(raw.trim())
    if (!Number.isInteger(value) || value < min || value > max) {
      toast.error(translate("circle:customInvalid", { min, max }))
      return
    }
    if (key === "retention") patchSettings({ historyRetentionDays: value })
    else if (key === "interval")
      patchSettings({
        minUpdateIntervalSeconds: value,
        distanceFilterMeters: value >= 300 ? 150 : value >= 60 ? 80 : 40,
      })
    else if (key === "battery") patchSettings({ lowBatteryThreshold: value / 100 })
    else patchSettings({ speedAlertKmh: value })
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="circle:rename" />
      <View style={{ paddingHorizontal: theme.spacing.md }}>
        <TextField
          value={name}
          onChangeText={setName}
          onBlur={saveName}
          onSubmitEditing={saveName}
          returnKeyType="done"
          inputWrapperStyle={themed($input)}
        />
      </View>

      <SectionHeader tx="circle:alerts" />
      <Text
        size="xxs"
        tx="circle:alertsHint"
        style={{
          color: theme.colors.textFaint,
          paddingHorizontal: theme.spacing.md,
          paddingBottom: 4,
        }}
      />
      <SectionHeader tx="circle:speedAlert" />
      {chips(
        SPEED_OPTIONS,
        circle.settings.speedAlertKmh ?? 0,
        (kmh) => (kmh === 0 ? translate("circle:speedAlertOff") : `${kmh} km/h`),
        (kmh) => patchSettings({ speedAlertKmh: kmh }),
        "speed",
      )}
      <Text
        size="xxs"
        tx="circle:speedAlertHint"
        style={{
          color: theme.colors.textFaint,
          paddingHorizontal: theme.spacing.md,
          paddingTop: 6,
        }}
      />

      <ListGroup>
        <ListRow
          tx="circle:incidentDetection"
          subtitleTx="circle:incidentHint"
          icon="warning-outline"
          iconTone="error"
          value={circle.settings.incidentDetection ?? false}
          onValueChange={(value) => patchSettings({ incidentDetection: value })}
        />
      </ListGroup>

      <SectionHeader tx="circle:lowBattery" />
      {chips(
        BATTERY_OPTIONS,
        circle.settings.lowBatteryThreshold,
        (value) => `${Math.round(value * 100)}%`,
        (value) => patchSettings({ lowBatteryThreshold: value }),
        "battery",
      )}

      <SectionHeader tx="circle:location" />
      <SectionHeader tx="circle:updateInterval" />
      {chips(
        INTERVAL_OPTIONS.map((option) => option.seconds),
        circle.settings.minUpdateIntervalSeconds,
        intervalLabel,
        (seconds) =>
          patchSettings({
            minUpdateIntervalSeconds: seconds,
            distanceFilterMeters: seconds >= 300 ? 150 : seconds >= 60 ? 80 : 40,
          }),
        "interval",
      )}

      <SectionHeader tx="circle:historyRetention" />
      {chips(
        RETENTION_OPTIONS,
        circle.settings.historyRetentionDays,
        (days) =>
          days === 0
            ? translate("circle:daysOff")
            : days === 1
              ? translate("circle:dayOne")
              : translate("circle:days", { count: days }),
        (days) => patchSettings({ historyRetentionDays: days }),
        "retention",
      )}

      <SectionHeader tx="circle:privacy" />
      <ListGroup>
        <ListRow
          tx="circle:allowPause"
          icon="pause-circle-outline"
          value={circle.settings.allowSharingPause}
          onValueChange={(value) => patchSettings({ allowSharingPause: value })}
        />
        <ListRow
          tx="circle:allowHistory"
          icon="footsteps-outline"
          value={circle.settings.allowHistory}
          onValueChange={(value) => patchSettings({ allowHistory: value })}
        />
      </ListGroup>

      {customFor ? (
        <PromptDialog
          visible
          titleTx={CUSTOM[customFor].titleTx}
          initialValue={String(currentCustom(customFor))}
          keyboardType="number-pad"
          maxLength={4}
          helper={translate("circle:customRange", {
            min: CUSTOM[customFor].min,
            max: CUSTOM[customFor].max,
          })}
          onCancel={() => setCustomFor(null)}
          onSubmit={(value) => applyCustom(customFor, value)}
        />
      ) : null}

      <PrimaryButton
        tx="common:done"
        variant="soft"
        onPress={() => navigation.goBack()}
        style={{ margin: theme.spacing.md, marginTop: theme.spacing.xl }}
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
const $chips: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  flexWrap: "wrap",
  gap: spacing.xs,
  paddingHorizontal: spacing.md,
})
const $chip: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  paddingHorizontal: spacing.sm,
  paddingVertical: 8,
  borderRadius: 999,
  backgroundColor: colors.surface,
})
