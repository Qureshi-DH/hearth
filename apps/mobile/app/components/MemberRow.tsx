import { Pressable, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import type { CircleMember, MemberPresence } from "@hearth/shared"

import { Avatar, type AvatarRing } from "@/components/Avatar"
import { BatteryPill } from "@/components/BatteryPill"
import { Pill } from "@/components/Pill"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { useNearby } from "@/hooks/useNearby"
import { useAppTheme } from "@/theme/context"
import { activityIconName } from "@/utils/activity"
import { formatSpeed } from "@/utils/format"
import { relativeTime, sinceTime } from "@/utils/time"

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

/**
 * One line under a name. A place the family named comes first, then the
 * street the phone's geocoder knows, then only when it was heard from.
 */
export function statusLine(presence: MemberPresence | undefined, nearby?: string | null): string {
  if (!presence) return translate("map:noLocation")
  if (presence.sharingState === "paused") return translate("map:paused")
  // What the phone said is wrong with it comes before where it last was:
  // "location permission off" is the sentence a parent can act on.
  const issue = presence.issues?.[0]
  if (issue && (presence.stale || !presence.recordedAt)) {
    return translate(`map:issue_${issue}` as const)
  }
  if (presence.atPlace) {
    const since = presence.atPlace.since ? sinceTime(presence.atPlace.since) : null
    return since
      ? translate("map:atPlaceSince", { place: presence.atPlace.name, since })
      : translate("map:atPlace", { place: presence.atPlace.name })
  }
  if (!presence.recordedAt) return translate("map:noLocation")
  const when = presence.stale
    ? `${translate("map:stale")} · ${relativeTime(presence.recordedAt)}`
    : translate("map:lastSeen", { time: relativeTime(presence.recordedAt) })
  if (nearby && !presence.approximate) {
    return `${translate("map:near", { where: nearby })} · ${relativeTime(presence.recordedAt)}`
  }
  return when
}

/** The street under a member, where there is no named place and they share precisely. */
export function useMemberNearby(presence: MemberPresence | undefined): string | null {
  const wanted = presence != null && !presence.atPlace && !presence.approximate
  return useNearby(wanted ? presence.lat : null, wanted ? presence.lon : null)
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
  const nearby = useMemberNearby(presence)

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
            {statusLine(presence, nearby)}
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
