import type { FC } from "react"
import { Alert, View, type ViewStyle } from "react-native"
import Constants from "expo-constants"

import { Avatar } from "@/components/Avatar"
import { ListGroup, ListRow } from "@/components/ListRow"
import { Pill } from "@/components/Pill"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { SegmentedControl } from "@/components/SegmentedControl"
import { Text } from "@/components/Text"
import { useMe, useUpdateMe } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { stopTracking } from "@/services/location/tracker"
import { disablePush } from "@/services/notifications"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore, type ThemeMode } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"

export const YouScreen: FC<MainTabScreenProps<"You">> = ({ navigation }) => {
  const { themed, theme, setThemeContextOverride } = useAppTheme()
  useMe()
  const user = useAuthStore((state) => state.user)
  const serverInfo = useAuthStore((state) => state.serverInfo)
  const serverUrl = useAuthStore((state) => state.serverUrl)
  const signedOut = useAuthStore((state) => state.signedOut)
  const settings = useSettingsStore()
  const tracking = useTrackingStore()
  const updateMe = useUpdateMe()

  const setTheme = (mode: ThemeMode) => {
    settings.setThemeMode(mode)
    setThemeContextOverride(mode === "system" ? undefined : mode)
  }

  const rename = () => {
    Alert.prompt?.(
      translate("settings:name"),
      undefined,
      (value) => {
        if (value?.trim()) updateMe.mutate({ displayName: value.trim() })
      },
      "plain-text",
      user?.displayName,
    )
  }

  const signOut = () => {
    Alert.alert(translate("common:logOut"), translate("settings:signOutConfirm"), [
      { text: translate("common:cancel"), style: "cancel" },
      {
        text: translate("common:logOut"),
        style: "destructive",
        onPress: async () => {
          await stopTracking()
          await disablePush()
          try {
            await endpoints.auth.logout()
          } catch {
            // Session may already be dead. Local cleanup below still has to run.
          }
          await tokenVault.set(null)
          tracking.reset()
          queryClient.clear()
          signedOut()
        },
      },
    ])
  }

  const version = Constants.expoConfig?.version ?? "0.1.0"

  return (
    <Screen preset="scroll" safeAreaEdges={["top"]} contentContainerStyle={themed($container)}>
      <View style={themed($profile)}>
        {user ? <Avatar user={user} size={72} /> : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Text preset="subheading" numberOfLines={1}>
            {user?.displayName}
          </Text>
          <Text size="xs" numberOfLines={1} style={{ color: theme.colors.textDim }}>
            {user?.email}
          </Text>
          {user?.isAdmin ? (
            <Pill
              text={translate("settings:admin")}
              tone="tint"
              icon="shield-checkmark"
              style={{ marginTop: 4 }}
            />
          ) : null}
        </View>
      </View>

      <SectionHeader tx="settings:tracking" />
      <ListGroup>
        <ListRow
          tx={tracking.backgroundActive ? "settings:trackingActive" : "settings:trackingInactive"}
          subtitle={[
            translate("settings:permission", { level: tracking.permission }),
            tracking.queue.length
              ? translate("settings:queued", { count: tracking.queue.length })
              : null,
            translate("settings:lastUpload", { time: relativeTime(tracking.lastUploadAt) }),
          ]
            .filter(Boolean)
            .join(" · ")}
          icon={tracking.backgroundActive ? "radio-outline" : "radio-button-off-outline"}
          iconTone={tracking.backgroundActive ? "success" : "warning"}
          onPress={() => navigation.navigate("Permissions")}
        />
        {tracking.lastError ? (
          <Text
            size="xxs"
            style={{
              color: theme.colors.error,
              paddingHorizontal: theme.spacing.md,
              paddingBottom: theme.spacing.sm,
            }}
          >
            {tracking.lastError}
          </Text>
        ) : null}
      </ListGroup>

      <SectionHeader tx="settings:privacy" />
      <ListGroup>
        <ListRow
          tx="settings:sharing"
          icon="eye-outline"
          iconTone="info"
          onPress={() => navigation.navigate("Sharing")}
        />
        <ListRow
          tx="settings:privacy"
          icon="lock-closed-outline"
          iconTone="tint"
          onPress={() => navigation.navigate("PrivacyData")}
        />
        <ListRow
          tx="settings:devices"
          icon="phone-portrait-outline"
          onPress={() => navigation.navigate("Devices")}
        />
      </ListGroup>

      <SectionHeader tx="settings:profile" />
      <ListGroup>
        <ListRow
          tx="settings:name"
          subtitle={user?.displayName}
          icon="person-outline"
          onPress={rename}
        />
        <ListRow
          tx="settings:changePassword"
          icon="key-outline"
          onPress={() => navigation.navigate("ChangePassword")}
        />
        <ListRow
          tx="settings:units"
          subtitle={translate(
            settings.units === "metric" ? "settings:metric" : "settings:imperial",
          )}
          icon="speedometer-outline"
          onPress={() => {
            const next = settings.units === "metric" ? "imperial" : "metric"
            settings.setUnits(next)
            updateMe.mutate({ units: next })
          }}
        />
      </ListGroup>

      <SectionHeader tx="settings:appearance" />
      <ListGroup>
        <View style={{ padding: theme.spacing.sm }}>
          <SegmentedControl
            value={settings.themeMode}
            onChange={setTheme}
            options={[
              { value: "system", tx: "settings:system" },
              { value: "light", tx: "settings:light" },
              { value: "dark", tx: "settings:dark" },
            ]}
          />
        </View>
        <ListRow
          tx="settings:haptics"
          icon="phone-portrait-outline"
          value={settings.hapticsEnabled}
          onValueChange={settings.setHaptics}
        />
      </ListGroup>

      <SectionHeader tx="settings:server" />
      <ListGroup>
        <ListRow
          text={serverInfo?.serverName ?? "Hearth"}
          subtitle={serverUrl ?? undefined}
          icon="server-outline"
        />
        {user?.isAdmin ? (
          <ListRow
            tx="settings:admin"
            icon="construct-outline"
            iconTone="tint"
            onPress={() => navigation.navigate("Admin")}
          />
        ) : null}
        <ListRow
          tx="settings:version"
          subtitle={`${version} · server ${serverInfo?.version ?? "?"}`}
          icon="information-circle-outline"
        />
      </ListGroup>

      <ListGroup style={{ marginTop: theme.spacing.lg }}>
        <ListRow tx="common:logOut" icon="log-out-outline" destructive onPress={signOut} />
      </ListGroup>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
const $profile: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.md,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.md,
})
