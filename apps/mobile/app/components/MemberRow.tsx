import { Pressable, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { CircleMember, MemberPresence } from "@hearth/shared"

import { Avatar, type AvatarRing } from "@/components/Avatar"
import { BatteryPill } from "@/components/BatteryPill"
import { Pill } from "@/components/Pill"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { useAppTheme } from "@/theme/context"
import { activityIconName } from "@/utils/activity"
import { formatSpeed } from "@/utils/format"
import { relativeTime } from "@/utils/time"

export interface MemberRowProps {
  member: CircleMember
  presence?: MemberPresence
  isSelf: boolean
  units: "metric" | "imperial"
  onPress?: () => void
  onLongPress?: () => void
  compact?: boolean
}

export function ringFor(presence: MemberPresence | undefined, isSelf: boolean): AvatarRing {
  if (presence?.sosAlertId) return "sos"
  if (isSelf) return "self"
  if (!presence || presence.sharingState === "paused") return "none"
  if (presence.approximate) return "approximate"
  if (presence.stale) return "stale"
  return "none"
}

export function statusLine(presence: MemberPresence | undefined): string {
  if (!presence) return translate("map:noLocation")
  if (presence.sharingState === "paused") return translate("map:paused")
  if (presence.atPlace) return translate("map:atPlace", { place: presence.atPlace.name })
  if (!presence.recordedAt) return translate("map:noLocation")
  if (presence.stale) return `${translate("map:stale")} · ${relativeTime(presence.recordedAt)}`
  return translate("map:lastSeen", { time: relativeTime(presence.recordedAt) })
}

export function MemberRow({
  member,
  presence,
  isSelf,
  units,
  onPress,
  onLongPress,
  compact,
}: MemberRowProps) {
  const { theme } = useAppTheme()
  const name = member.nickname ?? member.user.displayName
  const speed = presence?.approximate ? null : formatSpeed(presence?.speedMps, units)
  const activityIcon = presence?.approximate ? null : activityIconName(presence?.activity)

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.sm,
        paddingVertical: compact ? theme.spacing.xs : theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Avatar user={member.user} size={compact ? 40 : 48} ring={ringFor(presence, isSelf)} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text weight="semiBold" size="sm" numberOfLines={1} style={{ flexShrink: 1 }}>
            {name}
          </Text>
          {isSelf ? <Pill text={translate("common:you")} tone="info" /> : null}
          {member.role === "owner" ? (
            <Ionicons name="star" size={12} color={theme.colors.warning} />
          ) : null}
          {presence?.sosAlertId ? <Pill text="SOS" tone="error" icon="alert" /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {activityIcon ? (
            <Ionicons name={activityIcon} size={13} color={theme.colors.textDim} />
          ) : null}
          <Text size="xs" numberOfLines={1} style={{ color: theme.colors.textDim, flexShrink: 1 }}>
            {statusLine(presence)}
            {speed ? ` · ${speed}` : ""}
          </Text>
        </View>
      </View>
      {presence?.sharingState !== "paused" ? (
        <BatteryPill level={presence?.batteryLevel} charging={presence?.isCharging} />
      ) : null}
      <Ionicons name="chevron-forward" size={18} color={theme.colors.textFaint} />
    </Pressable>
  )
}
