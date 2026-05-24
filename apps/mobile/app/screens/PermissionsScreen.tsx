import { useCallback, useState, type FC } from "react"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useFocusEffect } from "@react-navigation/native"

import { Pill } from "@/components/Pill"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { requestPermissions, startTracking } from "@/services/location/tracker"
import { ensureMotionPermission, motionPermission } from "@/services/location/motion"
import { useAuthStore } from "@/stores/auth"
import {
  getPermissionSnapshot,
  openAppSettings,
  openLocationSettings,
  requestBatteryExemption,
  requestNotifications,
  type PermissionSnapshot,
} from "@/services/permissions"
import { useSettingsStore } from "@/stores/settings"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import type { IoniconName, Tone } from "@/utils/activity"
import { withAlpha } from "@/utils/color"
import { useHeader } from "@/utils/useHeader"

type ItemState = "done" | "todo" | "blocked" | "info"

interface Item {
  key: string
  icon: IoniconName
  title: string
  body: string
  state: ItemState
  action?: { label: string; onPress: () => Promise<void> | void }
}

/**
 * Every reason is spelled out before the system dialog fires. Apps that skip
 * that get "While Using" from most people, and then nobody shows up on the map.
 */
export const PermissionsScreen: FC<AppStackScreenProps<"Permissions">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()

  useHeader(
    { titleTx: "permissions:title", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null)
  // Only asked for when the server has turned the motion path on, so the
  // checklist must not demand it otherwise.
  const nativeMotion = useAuthStore((state) => state.serverInfo?.nativeMotion === true)
  // Mirrors whether any circle asked for incident alerts, which is the only
  // condition under which the sensors below are read at all.
  const incidentDetection = useSettingsStore((state) => state.incidentDetection)
  const [motion, setMotion] = useState<Awaited<ReturnType<typeof motionPermission>>>("unavailable")
  const [busy, setBusy] = useState<string | null>(null)
  const setOnboarded = useTrackingStore((state) => state.setOnboardedPermissions)

  const refresh = useCallback(async () => {
    const next = await getPermissionSnapshot()
    setSnapshot(next)
    useTrackingStore.getState().setPermission(next.location)
    setMotion(await motionPermission())
  }, [])

  // Users flip toggles in Settings and come straight back, so re-read on focus.
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh]),
  )

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const items: Item[] = snapshot
    ? [
        {
          key: "location",
          icon: "navigate",
          // Being granted access to a switched-off sensor is not a working
          // state, and saying "On" while the phone reports nothing is how this
          // screen ends up lying to someone whose family cannot see them.
          title: !snapshot.servicesEnabled
            ? translate("permissions:servicesOffTitle")
            : translate("permissions:locationTitle"),
          body: !snapshot.servicesEnabled
            ? translate("permissions:servicesOffBody")
            : snapshot.location === "always"
              ? translate("permissions:locationAlwaysBody")
              : snapshot.location === "foreground"
                ? translate("permissions:locationForegroundBody")
                : snapshot.location === "denied"
                  ? translate("permissions:deniedBody")
                  : translate("permissions:subtitle"),
          state: !snapshot.servicesEnabled
            ? "blocked"
            : snapshot.location === "always"
              ? "done"
              : snapshot.location === "denied"
                ? "blocked"
                : "todo",
          action: !snapshot.servicesEnabled
            ? { label: translate("permissions:openSettings"), onPress: openLocationSettings }
            : snapshot.location === "always"
              ? undefined
              : snapshot.location === "denied" || snapshot.location === "foreground"
                ? { label: translate("permissions:openSettings"), onPress: openAppSettings }
                : {
                    label: translate("permissions:always"),
                    onPress: async () => {
                      const level = await requestPermissions()
                      if (level === "always" || level === "foreground") {
                        useTrackingStore.getState().setEnabled(true)
                        await startTracking()
                      }
                    },
                  },
        },
        ...((snapshot.preciseLocation
          ? []
          : [
              {
                key: "precise",
                icon: "locate",
                title: translate("permissions:preciseTitle"),
                body: translate("permissions:preciseBody"),
                state: "todo" as ItemState,
                action: { label: translate("permissions:openSettings"), onPress: openAppSettings },
              },
            ]) as Item[]),
        ...((nativeMotion && motion !== "unavailable"
          ? [
              {
                key: "motion",
                icon: "walk" as IoniconName,
                title: translate("permissions:motionTitle"),
                body: translate("permissions:motionBody"),
                state: (motion === "granted"
                  ? "done"
                  : motion === "denied"
                    ? "blocked"
                    : "todo") as ItemState,
                action:
                  motion === "granted"
                    ? undefined
                    : motion === "denied"
                      ? {
                          label: translate("permissions:openSettings"),
                          onPress: openAppSettings,
                        }
                      : {
                          label: translate("permissions:allow"),
                          onPress: async () => {
                            await ensureMotionPermission()
                          },
                        },
              },
            ]
          : []) as Item[]),
        // Not a permission, which is exactly why it is worth saying. Crash
        // detection reads the accelerometer, gyroscope and barometer, and at
        // the rates Hearth samples them neither platform asks the person
        // anything — so without a line here it would run unannounced.
        ...((incidentDetection
          ? [
              {
                key: "sensors",
                icon: "pulse" as IoniconName,
                title: translate("permissions:sensorsTitle"),
                body: translate("permissions:sensorsBody"),
                state: "info" as ItemState,
              },
            ]
          : []) as Item[]),
        {
          key: "notifications",
          icon: "notifications",
          title: translate("permissions:notificationsTitle"),
          body: translate("permissions:notificationsBody"),
          state:
            snapshot.notifications === "granted"
              ? "done"
              : snapshot.notifications === "denied"
                ? "blocked"
                : snapshot.notifications === "n/a"
                  ? "info"
                  : "todo",
          action:
            snapshot.notifications === "granted" || snapshot.notifications === "n/a"
              ? undefined
              : snapshot.notifications === "denied"
                ? { label: translate("permissions:openSettings"), onPress: openAppSettings }
                : {
                    label: translate("permissions:allow"),
                    onPress: async () => {
                      await requestNotifications()
                    },
                  },
        },
        ...((Platform.OS === "android"
          ? [
              {
                key: "battery",
                icon: "battery-charging",
                title: translate("permissions:batteryTitle"),
                body: translate("permissions:batteryBody"),
                state: (snapshot.batteryOptimization === "exempt_requested"
                  ? "done"
                  : "todo") as ItemState,
                action: {
                  label: translate(
                    snapshot.batteryOptimization === "exempt_requested"
                      ? "permissions:review"
                      : "permissions:allow",
                  ),
                  onPress: requestBatteryExemption,
                },
              },
            ]
          : [
              {
                key: "refresh",
                icon: "refresh-circle",
                title: translate("permissions:refreshTitle"),
                body: translate("permissions:refreshBody"),
                state: "info" as ItemState,
                action: { label: translate("permissions:openSettings"), onPress: openAppSettings },
              },
            ]) as Item[]),
      ]
    : []

  const allGood = items.every((item) => item.state === "done" || item.state === "info")

  return (
    <Screen
      preset="scroll"
      safeAreaEdges={["top", "bottom"]}
      contentContainerStyle={themed($container)}
    >
      <View style={themed($iconWrap)}>
        <Ionicons name="shield-checkmark" size={40} color={theme.colors.tint} />
      </View>
      <Text preset="heading" tx="permissions:title" style={{ textAlign: "center" }} />
      <Text
        tx="permissions:intro"
        size="sm"
        style={{ color: theme.colors.textDim, textAlign: "center" }}
      />

      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.lg }}>
        {items.map((item) => (
          <ChecklistRow
            key={item.key}
            item={item}
            busy={busy === item.key}
            onAction={() => item.action && run(item.key, async () => item.action!.onPress())}
          />
        ))}
      </View>

      <View style={themed($note)}>
        <Ionicons name="lock-closed-outline" size={14} color={theme.colors.textFaint} />
        <Text
          size="xxs"
          tx="permissions:notRequested"
          style={{ color: theme.colors.textFaint, flex: 1 }}
        />
      </View>

      <View style={{ flex: 1 }} />

      <PrimaryButton
        tx={allGood ? "common:done" : "permissions:later"}
        variant={allGood ? "gradient" : "ghost"}
        onPress={() => {
          setOnboarded(true)
          navigation.goBack()
        }}
      />
    </Screen>
  )
}

function ChecklistRow({
  item,
  busy,
  onAction,
}: {
  item: Item
  busy: boolean
  onAction: () => void
}) {
  const { theme } = useAppTheme()
  const tone: Tone =
    item.state === "done"
      ? "success"
      : item.state === "blocked"
        ? "error"
        : item.state === "info"
          ? "info"
          : "warning"
  const color =
    tone === "success"
      ? theme.colors.success
      : tone === "error"
        ? theme.colors.error
        : tone === "info"
          ? theme.colors.info
          : theme.colors.warning

  return (
    <View
      style={{
        flexDirection: "row",
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(color, 0.14),
        }}
      >
        <Ionicons name={item.icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text weight="semiBold" size="sm" style={{ flex: 1 }}>
            {item.title}
          </Text>
          <Pill
            text={translate(
              item.state === "done"
                ? "permissions:stateDone"
                : item.state === "blocked"
                  ? "permissions:stateBlocked"
                  : item.state === "info"
                    ? "permissions:stateInfo"
                    : "permissions:stateTodo",
            )}
            tone={tone}
          />
        </View>
        <Text size="xs" style={{ color: theme.colors.textDim }}>
          {item.body}
        </Text>
        {item.action ? (
          <Pressable
            onPress={onAction}
            disabled={busy}
            hitSlop={8}
            style={{ alignSelf: "flex-start", marginTop: 4, opacity: busy ? 0.5 : 1 }}
          >
            <Text size="xs" weight="semiBold" style={{ color: theme.colors.tint }}>
              {item.action.label} →
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  flexGrow: 1,
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.xl,
  gap: spacing.sm,
  backgroundColor: colors.background,
})

const $iconWrap: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  alignSelf: "center",
  width: 88,
  height: 88,
  borderRadius: 44,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: withAlpha(colors.tint, 0.14),
  marginBottom: spacing.md,
})

const $note: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
  marginTop: spacing.md,
  paddingHorizontal: spacing.xs,
})
