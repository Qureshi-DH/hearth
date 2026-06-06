import type { FC } from "react"
import { Alert, type ViewStyle } from "react-native"

import { ListGroup, ListRow } from "@/components/ListRow"
import { Pill } from "@/components/Pill"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { useRevokeSession, useSessions } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const DevicesScreen: FC<AppStackScreenProps<"Devices">> = ({ navigation }) => {
  const { themed } = useAppTheme()
  const { data: sessions } = useSessions()
  const revoke = useRevokeSession()

  useHeader(
    { titleTx: "settings:devices", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="settings:devices" />
      <ListGroup>
        {sessions?.map((session) => (
          <ListRow
            key={session.id}
            text={session.deviceName ?? session.platform ?? translate("common:unknown")}
            subtitle={`${session.platform ?? ""} ${session.appVersion ?? ""} · ${relativeTime(session.lastUsedAt)}`.trim()}
            icon={
              session.platform === "android"
                ? "logo-android"
                : session.platform === "web"
                  ? "globe-outline"
                  : "phone-portrait-outline"
            }
            right={
              session.current ? (
                <Pill text={translate("settings:thisDevice")} tone="info" />
              ) : undefined
            }
            onPress={
              session.current
                ? undefined
                : () =>
                    Alert.alert(translate("settings:signOutDevice"), session.deviceName ?? "", [
                      { text: translate("common:cancel"), style: "cancel" },
                      {
                        text: translate("settings:signOutDevice"),
                        style: "destructive",
                        onPress: () =>
                          revoke.mutate(session.id, {
                            onError: (error) => toast.error((error as Error).message),
                          }),
                      },
                    ])
            }
          />
        ))}
      </ListGroup>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
