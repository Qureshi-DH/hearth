import { useCallback, useState, type FC } from "react"
import { Alert, Pressable, View, type ViewStyle } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import * as ImagePicker from "expo-image-picker"
import { manipulateAsync, SaveFormat } from "expo-image-manipulator"
import Constants from "expo-constants"

import { Avatar } from "@/components/Avatar"
import { ListGroup, ListRow } from "@/components/ListRow"
import { OptionSheet } from "@/components/OptionSheet"
import { Pill } from "@/components/Pill"
import { PromptDialog } from "@/components/PromptDialog"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { SegmentedControl } from "@/components/SegmentedControl"
import { Text } from "@/components/Text"
import { useMe, useRemoveAvatar, useUpdateMe, useUploadAvatar } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { MainTabScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { refreshMotionWatch, stopTracking } from "@/services/location/tracker"
import { disablePush } from "@/services/notifications"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useSettingsStore, type ThemeMode } from "@/stores/settings"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"

export const YouScreen: FC<MainTabScreenProps<"You">> = ({ navigation }) => {
  const { themed, theme, setThemeContextOverride } = useAppTheme()
  useMe()

  // serverInfo is persisted and otherwise only refetched at launch, so an
  // operator turning on object storage would not reach an already-installed
  // app until it was killed and reopened.
  useFocusEffect(
    useCallback(() => {
      endpoints.system
        .info()
        .then(useAuthStore.getState().setServerInfo)
        .catch(() => {
          // Offline. The cached copy is still the best answer available.
        })
    }, []),
  )
  const user = useAuthStore((state) => state.user)
  const serverInfo = useAuthStore((state) => state.serverInfo)
  const serverUrl = useAuthStore((state) => state.serverUrl)
  const signedOut = useAuthStore((state) => state.signedOut)
  const clearServer = useAuthStore((state) => state.clearServer)
  // Per-field selectors, not the whole store: the tracking store writes on
  // every fix and every upload attempt, and this screen stays mounted.
  const themeMode = useSettingsStore((state) => state.themeMode)
  const setThemeMode = useSettingsStore((state) => state.setThemeMode)
  const units = useSettingsStore((state) => state.units)
  const setUnits = useSettingsStore((state) => state.setUnits)
  const hapticsEnabled = useSettingsStore((state) => state.hapticsEnabled)
  const setHaptics = useSettingsStore((state) => state.setHaptics)
  const nativeMotion = useSettingsStore((state) => state.nativeMotion)
  const setNativeMotion = useSettingsStore((state) => state.setNativeMotion)
  const backgroundActive = useTrackingStore((state) => state.backgroundActive)
  const permission = useTrackingStore((state) => state.permission)
  const queuedCount = useTrackingStore((state) => state.queue.length)
  const lastUploadAt = useTrackingStore((state) => state.lastUploadAt)
  const lastError = useTrackingStore((state) => state.lastError)
  const resetTracking = useTrackingStore((state) => state.reset)
  const updateMe = useUpdateMe()

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode)
    setThemeContextOverride(mode === "system" ? undefined : mode)
  }

  const [renaming, setRenaming] = useState(false)
  const rename = () => setRenaming(true)

  const uploadAvatar = useUploadAvatar()
  const removeAvatar = useRemoveAvatar()
  const canUploadAvatar = useAuthStore((state) => state.serverInfo?.features.avatars === true)
  const [photoOpen, setPhotoOpen] = useState(false)

  const pickPhoto = async () => {
    try {
      await launchPicker()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const launchPicker = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    })
    const asset = picked.canceled ? null : picked.assets[0]
    if (!asset) return
    // Re-encoding at avatar size also drops the photo's EXIF, which on a phone
    // picture includes where it was taken.
    const resized = await manipulateAsync(asset.uri, [{ resize: { width: 512, height: 512 } }], {
      compress: 0.85,
      format: SaveFormat.JPEG,
    })
    uploadAvatar.mutate(
      { uri: resized.uri, name: "avatar.jpg", type: "image/jpeg" },
      { onError: (error) => toast.error((error as Error).message) },
    )
  }

  /**
   * A session belongs to one server, so pointing the app somewhere else means
   * leaving this one. Everything sign-out clears has to go too, or the tracker
   * keeps uploading to the old address.
   */
  const changeServer = () => {
    Alert.alert(translate("settings:changeServer"), translate("settings:changeServerConfirm"), [
      { text: translate("common:cancel"), style: "cancel" },
      {
        text: translate("settings:changeServer"),
        style: "destructive",
        onPress: async () => {
          await stopTracking()
          await disablePush()
          try {
            await endpoints.auth.logout()
          } catch {
            // The old server may already be unreachable, which is often why
            // somebody is changing it. Local cleanup below still has to run.
          }
          await tokenVault.set(null)
          resetTracking()
          queryClient.clear()
          clearServer()
        },
      },
    ])
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
          resetTracking()
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
        {user ? (
          <Pressable
            // Tapping always does something. An avatar that silently ignores
            // the tap when the server has no object storage is
            // indistinguishable from a broken one.
            onPress={() => {
              if (!canUploadAvatar) return toast.info(translate("settings:photoUnavailable"))
              if (user.avatarUrl) return setPhotoOpen(true)
              void pickPhoto()
            }}
            hitSlop={8}
          >
            <Avatar user={user} size={72} />
          </Pressable>
        ) : null}
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
          tx={backgroundActive ? "settings:trackingActive" : "settings:trackingInactive"}
          subtitle={[
            translate("settings:permission", { level: permission }),
            queuedCount ? translate("settings:queued", { count: queuedCount }) : null,
            translate("settings:lastUpload", { time: relativeTime(lastUploadAt) }),
          ]
            .filter(Boolean)
            .join(" · ")}
          icon={backgroundActive ? "radio-outline" : "radio-button-off-outline"}
          iconTone={backgroundActive ? "success" : "warning"}
          onPress={() => navigation.navigate("Permissions")}
        />
        <ListRow
          tx="settings:nativeMotion"
          subtitleTx="settings:nativeMotionHint"
          icon="walk-outline"
          value={nativeMotion}
          onValueChange={(on) => {
            setNativeMotion(on)
            void refreshMotionWatch()
          }}
        />
        {lastError ? (
          <Text
            size="xxs"
            style={{
              color: theme.colors.error,
              paddingHorizontal: theme.spacing.md,
              paddingBottom: theme.spacing.sm,
            }}
          >
            {lastError}
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
      </ListGroup>

      <SectionHeader tx="settings:appearance" />
      <ListGroup>
        <View style={{ padding: theme.spacing.sm }}>
          <SegmentedControl
            value={themeMode}
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
          value={hapticsEnabled}
          onValueChange={setHaptics}
        />
        <ListRow
          tx="settings:imperialUnits"
          subtitleTx={units === "imperial" ? "settings:imperialOn" : "settings:imperialOff"}
          icon="speedometer-outline"
          value={units === "imperial"}
          onValueChange={(on) => {
            const next = on ? "imperial" : "metric"
            setUnits(next)
            updateMe.mutate({ units: next })
          }}
        />
      </ListGroup>

      <SectionHeader tx="settings:server" />
      <ListGroup>
        {user?.isAdmin ? (
          <ListRow
            tx="settings:admin"
            icon="construct-outline"
            iconTone="tint"
            onPress={() => navigation.navigate("Admin")}
          />
        ) : null}
        <ListRow
          text={serverInfo?.serverName ?? "Hearth"}
          subtitle={serverUrl ?? undefined}
          icon="server-outline"
          onPress={changeServer}
        />
        <ListRow
          tx="settings:version"
          subtitle={`${version} · server ${serverInfo?.version ?? "?"}`}
          icon="information-circle-outline"
        />
      </ListGroup>

      <ListGroup style={{ marginTop: theme.spacing.lg }}>
        <ListRow tx="common:logOut" icon="log-out-outline" destructive onPress={signOut} />
      </ListGroup>
      <OptionSheet
        visible={photoOpen}
        titleTx="settings:photo"
        onClose={() => setPhotoOpen(false)}
        options={[
          { key: "choose", tx: "settings:choosePhoto", onPress: pickPhoto },
          ...(user?.avatarUrl
            ? [
                {
                  key: "remove",
                  tx: "settings:removePhoto" as const,
                  destructive: true,
                  onPress: () =>
                    removeAvatar.mutate(undefined, {
                      onError: (error) => toast.error((error as Error).message),
                    }),
                },
              ]
            : []),
        ]}
      />

      <PromptDialog
        visible={renaming}
        titleTx="settings:name"
        initialValue={user?.displayName}
        onCancel={() => setRenaming(false)}
        onSubmit={(value) => {
          if (value) updateMe.mutate({ displayName: value })
        }}
      />
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
