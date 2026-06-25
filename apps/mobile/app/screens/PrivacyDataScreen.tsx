import { useState, type FC } from "react"
import { Alert, View, type ViewStyle } from "react-native"
import { File, Paths } from "expo-file-system"
import * as Sharing from "expo-sharing"

import { ListGroup, ListRow } from "@/components/ListRow"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useMyStats } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { stopTracking } from "@/services/location/tracker"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { tokenVault } from "@/stores/tokenVault"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const PrivacyDataScreen: FC<AppStackScreenProps<"PrivacyData">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const stats = useMyStats()
  const signedOut = useAuthStore((state) => state.signedOut)
  const [exporting, setExporting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [password, setPassword] = useState("")
  const [deleting, setDeleting] = useState(false)

  useHeader(
    { titleTx: "settings:privacy", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const exportData = async () => {
    setExporting(true)
    try {
      const data = await endpoints.auth.exportData()
      const file = new File(Paths.cache, `hearth-export-${Date.now()}.json`)
      file.write(JSON.stringify(data, null, 2))
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: "application/json",
          dialogTitle: translate("settings:export"),
        })
      } else {
        toast.success(file.uri)
      }
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const eraseHistory = () => {
    Alert.alert(translate("settings:eraseHistory"), translate("settings:eraseConfirm"), [
      { text: translate("common:cancel"), style: "cancel" },
      {
        text: translate("common:delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await endpoints.locations.eraseMine()
            toast.success(translate("settings:erased"))
            void stats.refetch()
          } catch (error) {
            toast.error((error as Error).message)
          }
        },
      },
    ])
  }

  const deleteAccount = async () => {
    if (!password) return
    setDeleting(true)
    try {
      await endpoints.auth.deleteAccount(password)
      // The account is already gone by this point, so a tracker that refuses to
      // stop must not strand the app signed in to it.
      await stopTracking().catch(() => {})
      await tokenVault.set(null)
      // Stopping the tracker leaves whatever it had already queued on the
      // phone. Nothing is left to upload those fixes to, and they describe
      // where somebody who asked to be forgotten has been.
      useTrackingStore.getState().reset()
      queryClient.clear()
      signedOut()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="settings:privacy" />
      <ListGroup>
        <ListRow
          text={translate("settings:dataStored", { count: stats.data?.locationPoints ?? 0 })}
          subtitle={
            stats.data?.oldestPointAt
              ? translate("settings:oldest", { time: relativeTime(stats.data.oldestPointAt) })
              : undefined
          }
          icon="footsteps-outline"
          iconTone="info"
        />
        <ListRow
          tx="settings:export"
          subtitleTx="settings:exportBody"
          icon="download-outline"
          iconTone="tint"
          onPress={exportData}
          disabled={exporting}
        />
        <ListRow
          tx="settings:eraseHistory"
          icon="trash-bin-outline"
          destructive
          onPress={eraseHistory}
        />
      </ListGroup>

      <SectionHeader tx="settings:deleteAccount" />
      <ListGroup>
        <ListRow
          tx="settings:deleteAccount"
          subtitleTx="settings:deleteAccountBody"
          icon="warning-outline"
          destructive
          onPress={() => setConfirmingDelete((value) => !value)}
        />
        {confirmingDelete ? (
          <View style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
            <Text
              size="xs"
              tx="settings:deleteAccountConfirm"
              style={{ color: theme.colors.textDim }}
            />
            <TextField
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholderTx="login:password"
              inputWrapperStyle={themed($input)}
            />
            <PrimaryButton
              tx="settings:deleteAccount"
              variant="danger"
              onPress={deleteAccount}
              loading={deleting}
              disabled={!password}
            />
          </View>
        ) : null}
      </ListGroup>
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
  backgroundColor: colors.surfaceElevated,
  borderColor: colors.border,
  paddingVertical: 6,
})
