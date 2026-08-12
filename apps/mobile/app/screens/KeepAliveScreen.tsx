import { useCallback, useState, type FC } from "react"
import { AppState, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useFocusEffect } from "@react-navigation/native"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import type { TxKeyPath } from "@/i18n"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import {
  getPermissionSnapshot,
  openAppSettings,
  openVendorPowerManager,
  requestBatteryExemption,
  vendorFor,
  type PermissionSnapshot,
  type Vendor,
} from "@/services/permissions"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { withAlpha } from "@/utils/color"
import { useHeader } from "@/utils/useHeader"

const VENDOR_COPY: Record<Vendor | "generic", { title: TxKeyPath; steps: TxKeyPath }> = {
  generic: { title: "keepAlive:genericTitle", steps: "keepAlive:genericSteps" },
  xiaomi: { title: "keepAlive:xiaomiTitle", steps: "keepAlive:xiaomiSteps" },
  huawei: { title: "keepAlive:huaweiTitle", steps: "keepAlive:huaweiSteps" },
  oppo: { title: "keepAlive:oppoTitle", steps: "keepAlive:oppoSteps" },
  vivo: { title: "keepAlive:vivoTitle", steps: "keepAlive:vivoSteps" },
  samsung: { title: "keepAlive:samsungTitle", steps: "keepAlive:samsungSteps" },
  transsion: { title: "keepAlive:transsionTitle", steps: "keepAlive:transsionSteps" },
  asus: { title: "keepAlive:asusTitle", steps: "keepAlive:asusSteps" },
}

/**
 * The vendor's kill switch, spelled out. Nothing here can be granted from a
 * dialog: every one of these settings lives in the maker's own screens, so
 * the page says where they are, opens the nearest of them, and reads back
 * the two things the OS will admit to, the Restricted setting and the
 * optimiser, so the person can see whether what they changed took.
 */
export const KeepAliveScreen: FC<AppStackScreenProps<"KeepAlive">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()

  useHeader(
    { titleTx: "keepAlive:title", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setSnapshot(await getPermissionSnapshot())
  }, [])

  // The person goes to the vendor's screen and comes straight back, which is
  // a return to the foreground and not a focus, so both are listened for.
  useFocusEffect(
    useCallback(() => {
      void refresh()
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh()
      })
      return () => subscription.remove()
    }, [refresh]),
  )

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const vendor = vendorFor(snapshot?.manufacturer)
  const copy = VENDOR_COPY[vendor ?? "generic"]
  const steps = translate(copy.steps).split("\n")

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <Text tx="keepAlive:intro" size="sm" style={{ color: theme.colors.textDim }} />

      {snapshot ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text preset="subheading" tx="keepAlive:status" />
          <StatusRow
            ok={!snapshot.backgroundRestricted}
            tx={
              snapshot.backgroundRestricted
                ? "keepAlive:restrictedNow"
                : "keepAlive:restrictedClear"
            }
            action={
              snapshot.backgroundRestricted
                ? {
                    tx: "keepAlive:openAppSettings",
                    busy: busy === "restricted",
                    onPress: () => run("restricted", openAppSettings),
                  }
                : undefined
            }
          />
          {snapshot.batteryOptimization !== "n/a" ? (
            <StatusRow
              ok={snapshot.batteryOptimization === "exempt"}
              tx={
                snapshot.batteryOptimization === "exempt"
                  ? "keepAlive:exemptDone"
                  : "keepAlive:optimisedNow"
              }
              action={
                snapshot.batteryOptimization === "exempt"
                  ? undefined
                  : {
                      tx: "keepAlive:exempt",
                      busy: busy === "exempt",
                      onPress: () => run("exempt", requestBatteryExemption),
                    }
              }
            />
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: theme.spacing.xs }}>
        <Text preset="subheading" tx={copy.title} />
        <Text size="xs" tx="keepAlive:stepsHint" style={{ color: theme.colors.textFaint }} />
        <View style={themed($steps)}>
          {steps.map((step, index) => (
            <View key={step} style={{ flexDirection: "row", gap: theme.spacing.sm }}>
              <View style={themed($number)}>
                <Text size="xxs" weight="semiBold" style={{ color: theme.colors.tint }}>
                  {String(index + 1)}
                </Text>
              </View>
              <Text size="sm" style={{ flex: 1 }}>
                {step}
              </Text>
            </View>
          ))}
        </View>
        <Text size="xs" tx="keepAlive:reverts" style={{ color: theme.colors.textDim }} />
      </View>

      <View style={{ flex: 1 }} />

      <PrimaryButton
        tx="keepAlive:openVendor"
        variant="gradient"
        loading={busy === "vendor"}
        onPress={() => run("vendor", openVendorPowerManager)}
      />
    </Screen>
  )
}

function StatusRow({
  ok,
  tx,
  action,
}: {
  ok: boolean
  tx: TxKeyPath
  action?: { tx: TxKeyPath; busy: boolean; onPress: () => void }
}) {
  const { theme } = useAppTheme()
  const color = ok ? theme.colors.success : theme.colors.error
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(color, 0.14),
        }}
      >
        <Ionicons name={ok ? "checkmark" : "close"} size={18} color={color} />
      </View>
      <View style={{ flex: 1, gap: theme.spacing.xs }}>
        <Text size="xs" tx={tx} />
        {action ? (
          <PrimaryButton
            tx={action.tx}
            variant="soft"
            loading={action.busy}
            onPress={action.onPress}
            style={{ alignSelf: "flex-start" }}
          />
        ) : null}
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  flexGrow: 1,
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.lg,
  gap: spacing.lg,
  backgroundColor: colors.background,
})

const $steps: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  gap: spacing.sm,
  padding: spacing.md,
  borderRadius: 20,
  backgroundColor: colors.surface,
})

const $number: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 22,
  height: 22,
  borderRadius: 11,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: withAlpha(colors.tint, 0.14),
})
