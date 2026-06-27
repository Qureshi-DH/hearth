import { useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { REGISTRATION_MODES, type AdminUserSummary, type RegistrationMode } from "@hearth/shared"

import { ListGroup, ListRow } from "@/components/ListRow"
import { OptionSheet } from "@/components/OptionSheet"
import { Pill } from "@/components/Pill"
import { PromptDialog, type PromptDialogProps } from "@/components/PromptDialog"
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

  // One sheet serves both rows. Which row it shows is kept apart from whether
  // it is open, so the copy stays put while the sheet slides away after a close.
  const [field, setField] = useState<"serverName" | "retention">("serverName")
  const [editing, setEditing] = useState(false)
  const [managing, setManaging] = useState<AdminUserSummary | null>(null)

  const edit = (next: typeof field) => {
    setField(next)
    setEditing(true)
  }

  const save = (patch: Parameters<typeof updateSettings.mutate>[0]) =>
    updateSettings.mutate(patch, { onError: (error) => toast.error((error as Error).message) })

  const prompt: Omit<PromptDialogProps, "visible" | "onCancel"> =
    field === "serverName"
      ? {
          titleTx: "admin:serverName",
          helper: translate("admin:serverNameHint"),
          initialValue: settings.data?.serverName,
          maxLength: 80,
          onSubmit: (value) => {
            if (value) save({ serverName: value })
          },
        }
      : {
          titleTx: "admin:maxRetention",
          helper: translate("admin:retentionHelper"),
          initialValue: settings.data?.maxHistoryRetentionDays?.toString() ?? "",
          keyboardType: "number-pad",
          maxLength: 4,
          onSubmit: (value) => {
            // Empty means no cap, which is a real answer here rather than a
            // refusal to answer, so it is sent as null instead of ignored.
            if (value === "") return save({ maxHistoryRetentionDays: null })
            const days = Number(value)
            if (!Number.isInteger(days) || days < 1 || days > 3650) {
              return toast.error(translate("admin:retentionHelper"))
            }
            save({ maxHistoryRetentionDays: days })
          },
        }

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
            value={String(stats.data?.users ?? "-")}
          />
          <StatTile
            icon="pulse-outline"
            label={translate("admin:active24h")}
            value={String(stats.data?.activeUsers24h ?? "-")}
          />
          <StatTile
            icon="ellipse-outline"
            label={translate("admin:circles")}
            value={String(stats.data?.circles ?? "-")}
          />
        </View>
        <View style={{ flexDirection: "row", gap: theme.spacing.xs }}>
          <StatTile
            icon="footsteps-outline"
            label={translate("admin:points")}
            value={stats.data ? stats.data.locationPoints.toLocaleString() : "-"}
          />
          <StatTile
            icon="server-outline"
            label={translate("admin:dbSize")}
            value={formatBytes(stats.data?.databaseSizeBytes)}
          />
          <StatTile
            icon="time-outline"
            label={translate("admin:uptime")}
            value={stats.data ? formatDuration(stats.data.uptimeSeconds) : "-"}
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
                onPress={() =>
                  updateSettings.mutate(
                    { registrationMode: mode },
                    { onError: (error) => toast.error((error as Error).message) },
                  )
                }
                style={{
                  flex: 1,
                  minHeight: 44,
                  paddingVertical: 10,
                  paddingHorizontal: 6,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: active ? theme.colors.tint : theme.colors.surfaceElevated,
                }}
              >
                <Text
                  size="xs"
                  weight="medium"
                  numberOfLines={1}
                  tx={MODE_LABEL[mode]}
                  style={{ color: active ? theme.colors.onTint : theme.colors.text }}
                />
              </Pressable>
            )
          })}
        </View>
        <ListRow
          tx="admin:serverName"
          subtitle={settings.data?.serverName}
          icon="pricetag-outline"
          onPress={() => edit("serverName")}
        />
        <ListRow
          tx="admin:maxRetention"
          subtitle={
            // Undefined while it loads. Saying "no limit" before the answer
            // arrives is a claim about someone's data, not a placeholder.
            !settings.data
              ? undefined
              : settings.data.maxHistoryRetentionDays == null
                ? translate("admin:retentionNone")
                : translate("admin:retentionDays", {
                    count: settings.data.maxHistoryRetentionDays,
                  })
          }
          icon="hourglass-outline"
          iconTone="warning"
          onPress={() => edit("retention")}
        />
        <ListRow
          tx="admin:queueTitle"
          subtitle={translate("admin:queueStatus", {
            count: stats.data?.pushQueueDepth ?? 0,
            provider: stats.data?.pushProvider ?? "none",
          })}
          icon="notifications-outline"
          iconTone="warning"
          right={
            <Pressable
              onPress={drain}
              accessibilityRole="button"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 999,
                backgroundColor: theme.colors.tintSoft,
              }}
            >
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
            icon={user.isAdmin ? "shield-checkmark-outline" : "person-outline"}
            iconTone={user.isAdmin ? "tint" : "neutral"}
            onPress={() => setManaging(user)}
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

      <PromptDialog {...prompt} visible={editing} onCancel={() => setEditing(false)} />

      <OptionSheet
        visible={managing !== null}
        title={managing?.displayName}
        onClose={() => setManaging(null)}
        options={
          managing
            ? [
                {
                  key: "active",
                  label: translate(managing.isActive ? "admin:deactivate" : "admin:activate"),
                  destructive: managing.isActive,
                  onPress: () =>
                    updateUser.mutate(
                      { userId: managing.id, isActive: !managing.isActive },
                      { onError: (error) => toast.error((error as Error).message) },
                    ),
                },
                {
                  key: "admin",
                  label: translate(managing.isAdmin ? "admin:removeAdmin" : "admin:makeAdmin"),
                  onPress: () =>
                    updateUser.mutate(
                      { userId: managing.id, isAdmin: !managing.isAdmin },
                      { onError: (error) => toast.error((error as Error).message) },
                    ),
                },
              ]
            : []
        }
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingBottom: spacing.xxl,
})
