import type { FC } from "react"
import { View, type DimensionValue, type ViewStyle } from "react-native"
import type { SessionSummary } from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { LoadFailed } from "@/components/LoadFailed"
import { Pill } from "@/components/Pill"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Bone, Skeleton } from "@/components/Skeleton"
import { Text } from "@/components/Text"
import { useRevokeSession, useSessions } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { alert } from "@/stores/alert"
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
  const { themed, theme } = useAppTheme()
  const { data: sessions, isError, error, refetch } = useSessions()
  const revoke = useRevokeSession()

  useHeader(
    { titleTx: "settings:devices", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="settings:devices" />
      {/* A list still loading, or one that failed, must not look like no devices. */}
      {!sessions ? (
        isError ? (
          <LoadFailed
            headingTx="settings:devicesFailed"
            content={error?.message}
            onRetry={() => void refetch()}
          />
        ) : (
          <DevicesSkeleton />
        )
      ) : sessions.length === 0 ? (
        <Text
          tx="settings:devicesEmpty"
          size="sm"
          style={{ color: theme.colors.textDim, paddingHorizontal: theme.spacing.lg }}
        />
      ) : (
        <ListGroup>
          {sessions.map((session) => {
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
                  session.current || session.onMap ? (
                    <View style={{ flexDirection: "row", gap: theme.spacing.xxs }}>
                      {session.onMap ? (
                        <Pill text={translate("settings:onMap")} tone="tint" icon="location" />
                      ) : null}
                      {session.current ? (
                        <Pill text={translate("settings:thisDevice")} tone="info" />
                      ) : null}
                    </View>
                  ) : undefined
                }
                onPress={
                  session.current
                    ? undefined
                    : () =>
                        alert(translate("settings:signOutDevice"), title, [
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
      )}
      {sessions && sessions.length > 1 && sessions.some((session) => session.onMap) ? (
        <Text
          tx="settings:onMapNote"
          size="xs"
          style={{
            color: theme.colors.textDim,
            paddingHorizontal: theme.spacing.lg,
            marginTop: theme.spacing.sm,
          }}
        />
      ) : null}
    </Screen>
  )
}

const SKELETON_TITLES: DimensionValue[] = ["62%", "48%"]

/** Laid out like the rows it stands in for, so the list lands where the shapes were. */
function DevicesSkeleton() {
  const { theme } = useAppTheme()
  return (
    <Skeleton accessibilityLabel={translate("settings:devicesLoading")}>
      <ListGroup>
        {SKELETON_TITLES.map((width) => (
          <View
            key={String(width)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              minHeight: 56,
            }}
          >
            <Bone width={34} height={34} radius={10} />
            <View style={{ flex: 1, gap: 6 }}>
              <Bone width={width} height={12} />
              <Bone width="80%" height={10} />
            </View>
          </View>
        ))}
      </ListGroup>
    </Skeleton>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
