import type { FC } from "react"
import { Alert, Pressable, View, type ViewStyle } from "react-native"
import { REGISTRATION_MODES, type RegistrationMode } from "@hearth/shared"

import { Avatar } from "@/components/Avatar"
import { ListGroup, ListRow } from "@/components/ListRow"
import { Pill } from "@/components/Pill"
import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { StatTile } from "@/components/StatTile"
import { Text } from "@/components/Text"
import {
  useAdminSettings,
  useAdminStats,
  useAdminUsers,
  useUpdateAdminSettings,
  useUpdateAdminUser,
} from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatBytes } from "@/utils/format"
import { formatDuration, relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

const MODE_LABEL: Record<
  RegistrationMode,
  "admin:regOpen" | "admin:regInvite" | "admin:regClosed"
> = {
  open: "admin:regOpen",
  invite: "admin:regInvite",
  closed: "admin:regClosed",
}

export const AdminScreen: FC<AppStackScreenProps<"Admin">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const me = useAuthStore((state) => state.user)
  const isAdmin = Boolean(me?.isAdmin)
  const stats = useAdminStats(isAdmin)
  const settings = useAdminSettings(isAdmin)
  const users = useAdminUsers(isAdmin)
  const updateSettings = useUpdateAdminSettings()
  const updateUser = useUpdateAdminUser()

  useHeader({ titleTx: "admin:title", leftIcon: "back", onLeftPress: () => navigation.goBack() }, [
    navigation,
  ])

  const drain = async () => {
    try {
      const result = await endpoints.admin.drainPush()
      toast.success(`Sent ${result.sent}, skipped ${result.skipped}, failed ${result.failed}`)
      void stats.refetch()
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader tx="admin:stats" />
      <View style={{ paddingHorizontal: theme.spacing.md, gap: theme.spacing.xs }}>
        <View style={{ flexDirection: "row", gap: theme.spacing.xs }}>
          <StatTile
            icon="people-outline"
            label={translate("admin:users")}
            value={String(stats.data?.users ?? "—")}
          />
          <StatTile
            icon="pulse-outline"
            label="Active 24h"
            value={String(stats.data?.activeUsers24h ?? "—")}
          />
          <StatTile
            icon="ellipse-outline"
            label="Circles"
            value={String(stats.data?.circles ?? "—")}
          />
        </View>
        <View style={{ flexDirection: "row", gap: theme.spacing.xs }}>
          <StatTile
            icon="footsteps-outline"
            label="Points"
            value={stats.data ? stats.data.locationPoints.toLocaleString() : "—"}
          />
          <StatTile
            icon="server-outline"
            label="Database"
            value={formatBytes(stats.data?.databaseSizeBytes)}
          />
          <StatTile
            icon="time-outline"
            label="Uptime"
            value={stats.data ? formatDuration(stats.data.uptimeSeconds) : "—"}
          />
        </View>
      </View>

      <SectionHeader tx="admin:settings" />
      <ListGroup>
        <ListRow
          text={translate("admin:registration")}
          subtitle={
            settings.data ? translate(MODE_LABEL[settings.data.registrationMode]) : undefined
          }
          icon="person-add-outline"
          iconTone="tint"
        />
        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            paddingBottom: theme.spacing.sm,
          }}
        >
          {REGISTRATION_MODES.map((mode) => {
            const active = settings.data?.registrationMode === mode
            return (
              <Pressable
                key={mode}
                onPress={() => updateSettings.mutate({ registrationMode: mode })}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 12,
                  alignItems: "center",
                  backgroundColor: active ? theme.colors.tint : theme.colors.surfaceElevated,
                }}
              >
                <Text
                  size="xs"
                  weight="medium"
                  tx={MODE_LABEL[mode]}
                  style={{ color: active ? theme.colors.onTint : theme.colors.text }}
                />
              </Pressable>
            )
          })}
        </View>
        <ListRow
          text={`${translate("admin:queue", { count: stats.data?.pushQueueDepth ?? 0 })} · ${stats.data?.pushProvider ?? "none"}`}
          icon="notifications-outline"
          iconTone="warning"
          right={
            <Pressable onPress={drain} hitSlop={8}>
              <Text
                size="xs"
                weight="medium"
                tx="admin:drainPush"
                style={{ color: theme.colors.tint }}
              />
            </Pressable>
          }
        />
      </ListGroup>

      <SectionHeader
        tx="admin:users"
        text={users.data ? translate("admin:usersCount", { count: users.data.length }) : undefined}
      />
      <ListGroup>
        {users.data?.map((user) => (
          <ListRow
            key={user.id}
            text={user.displayName}
            subtitle={`${user.email} · ${relativeTime(user.lastSeenAt)} · ${user.circleCount} circles`}
            right={
              <View style={{ flexDirection: "row", gap: 4 }}>
                {user.isAdmin ? <Pill text="admin" tone="tint" /> : null}
                {!user.isActive ? <Pill text="off" tone="error" /> : null}
              </View>
            }
            icon={undefined}
            onPress={() =>
              Alert.alert(user.displayName, user.email, [
                {
                  text: translate(user.isActive ? "admin:deactivate" : "admin:activate"),
                  style: user.isActive ? "destructive" : "default",
                  onPress: () => updateUser.mutate({ userId: user.id, isActive: !user.isActive }),
                },
                {
                  text: translate(user.isAdmin ? "admin:removeAdmin" : "admin:makeAdmin"),
                  onPress: () =>
                    updateUser.mutate(
                      { userId: user.id, isAdmin: !user.isAdmin },
                      { onError: (error) => toast.error((error as Error).message) },
                    ),
                },
                { text: translate("common:cancel"), style: "cancel" },
              ])
            }
            style={{ paddingLeft: 0 }}
          />
        ))}
      </ListGroup>
      <View style={{ height: theme.spacing.md }} />
      <PrimaryButton
        tx="common:done"
        variant="soft"
        onPress={() => navigation.goBack()}
        style={{ marginHorizontal: theme.spacing.md }}
      />
      <View style={{ display: "none" }}>{me ? <Avatar user={me} /> : null}</View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
