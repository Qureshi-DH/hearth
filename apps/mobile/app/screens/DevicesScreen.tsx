import type { FC } from "react"
import { Alert, type ViewStyle } from "react-native"
import type { SessionSummary } from "@hearth/shared"

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

// A switch over literal keys rather than a template so the i18n key test can
// see every string.
function platformLabel(platform: SessionSummary["platform"]): string {
  switch (platform) {
    case "ios":
      return translate("settings:platformIos")
    case "android":
      return translate("settings:platformAndroid")
    case "web":
      return translate("settings:platformWeb")
    case "other":
      return translate("settings:platformOther")
    default:
      return translate("common:unknown")
  }
}

function subtitleFor(session: SessionSummary): string {
  // A row without a device name is already titled by its platform.
  const device = [session.deviceName ? platformLabel(session.platform) : null, session.appVersion]
    .filter(Boolean)
    .join(" ")
  return [
    device,
    translate("settings:lastUsed", { time: relativeTime(session.lastUsedAt) }),
    translate("settings:signedIn", { time: relativeTime(session.createdAt) }),
  ]
    .filter(Boolean)
    .join(" · ")
}

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
        {sessions?.map((session) => {
          const title = session.deviceName ?? platformLabel(session.platform)
          return (
            <ListRow
              key={session.id}
              text={title}
              subtitle={subtitleFor(session)}
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
                      Alert.alert(translate("settings:signOutDevice"), title, [
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
          )
        })}
      </ListGroup>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
