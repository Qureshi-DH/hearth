import type { FC } from "react"
import { Alert, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { ListGroup, ListRow } from "@/components/ListRow"
import { MemberRow } from "@/components/MemberRow"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import {
  useCircle,
  useDeleteCircle,
  useMembers,
  usePresence,
  useRemoveMember,
} from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { useHeader } from "@/utils/useHeader"

export const CircleScreen: FC<AppStackScreenProps<"Circle">> = ({ navigation, route }) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const circle = useCircle(circleId)
  const me = useAuthStore((state) => state.user)
  const units = useSettingsStore((state) => state.units)
  const { data: members } = useMembers(circleId)
  const { data: presence } = usePresence(circleId)
  const removeMember = useRemoveMember(circleId)
  const deleteCircle = useDeleteCircle()

  useHeader(
    {
      title: circle ? `${circle.emoji ?? ""} ${circle.name}`.trim() : "",
      leftIcon: "back",
      onLeftPress: () => navigation.goBack(),
    },
    [circle?.name, navigation],
  )

  const isAdmin = circle?.role === "admin" || circle?.role === "owner"
  const isOwner = circle?.role === "owner"

  const leave = () => {
    if (!me || !circle) return
    Alert.alert(
      translate("member:leave"),
      translate("member:leaveConfirm", { name: circle.name }),
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("member:leave"),
          style: "destructive",
          onPress: async () => {
            try {
              await removeMember.mutateAsync(me.id)
              navigation.navigate("Main", { screen: "Map" })
            } catch (error) {
              toast.error((error as Error).message)
            }
          },
        },
      ],
    )
  }

  const destroy = () => {
    if (!circle) return
    Alert.alert(
      translate("circle:deleteCircle"),
      translate("circle:deleteConfirm", { name: circle.name }),
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("common:delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCircle.mutateAsync(circle.id)
              navigation.navigate("Main", { screen: "Map" })
            } catch (error) {
              toast.error((error as Error).message)
            }
          },
        },
      ],
    )
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <SectionHeader
        tx="circle:members"
        text={members ? `${translate("circle:members")} · ${members.length}` : undefined}
      />
      <ListGroup>
        {members?.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            presence={presence?.find((entry) => entry.userId === member.userId)}
            isSelf={member.userId === me?.id}
            units={units}
            compact
            onPress={() => navigation.navigate("MemberDetail", { circleId, userId: member.userId })}
          />
        ))}
      </ListGroup>

      <SectionHeader tx="circle:title" />
      <ListGroup>
        {isAdmin ? (
          <ListRow
            tx="circle:invites"
            icon="qr-code-outline"
            iconTone="tint"
            onPress={() => navigation.navigate("Invites", { circleId })}
          />
        ) : null}
        <ListRow
          tx="sharing:title"
          icon="eye-outline"
          iconTone="info"
          onPress={() => navigation.navigate("Sharing", { circleId })}
        />
        <ListRow
          tx="notifications:title"
          icon="notifications-outline"
          iconTone="warning"
          onPress={() => navigation.navigate("NotificationPrefs", { circleId })}
        />
        {isAdmin ? (
          <ListRow
            tx="circle:settings"
            icon="options-outline"
            onPress={() => navigation.navigate("CircleSettings", { circleId })}
          />
        ) : null}
      </ListGroup>

      <SectionHeader tx="circle:danger" />
      <ListGroup>
        {!isOwner ? (
          <ListRow tx="circle:leave" icon="log-out-outline" destructive onPress={leave} />
        ) : null}
        {isOwner ? (
          <ListRow tx="circle:deleteCircle" icon="trash-outline" destructive onPress={destroy} />
        ) : null}
        {isOwner && members && members.length > 1 ? (
          <View
            style={{
              paddingHorizontal: theme.spacing.md,
              paddingBottom: theme.spacing.sm,
              flexDirection: "row",
              gap: 6,
            }}
          >
            <Ionicons name="information-circle-outline" size={14} color={theme.colors.textFaint} />
            <Text size="xxs" style={{ color: theme.colors.textFaint, flex: 1 }}>
              To leave instead, transfer ownership to another member first.
            </Text>
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
