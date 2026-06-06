import { useState, type FC } from "react"
import { Pressable, Share, View, type ViewStyle } from "react-native"
import * as Clipboard from "expo-clipboard"
import { Ionicons } from "@expo/vector-icons"
import type { CircleInvite } from "@hearth/shared"
import QRCode from "react-native-qrcode-svg"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { SectionHeader } from "@/components/SectionHeader"
import { Text } from "@/components/Text"
import { useCircle, useCreateInvite, useInvites, useRevokeInvite } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { relativeTime } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

export const InvitesScreen: FC<AppStackScreenProps<"Invites">> = ({ navigation, route }) => {
  const { circleId } = route.params
  const { themed, theme } = useAppTheme()
  const circle = useCircle(circleId)
  const { data: invites, isLoading } = useInvites(circleId)
  const createInvite = useCreateInvite(circleId)
  const revokeInvite = useRevokeInvite(circleId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useHeader(
    { titleTx: "circle:invites", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const active = (invites ?? []).filter((invite) => {
    const extended = invite as CircleInvite & { revokedAt?: string | null }
    if (extended.revokedAt) return false
    if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) return false
    if (invite.maxUses != null && invite.uses >= invite.maxUses) return false
    return true
  })
  const selected = active.find((invite) => invite.id === selectedId) ?? active[0] ?? null

  const share = async (invite: CircleInvite) => {
    await Share.share({
      message: translate("circle:shareMessage", { code: invite.code, url: invite.url }),
    })
  }

  const copy = async (invite: CircleInvite) => {
    await Clipboard.setStringAsync(invite.code)
    toast.success(translate("common:copied"))
  }

  const mint = async () => {
    try {
      const invite = await createInvite.mutateAsync({ expiresInHours: 24 * 7 })
      setSelectedId(invite.id)
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      {selected ? (
        <View style={themed($hero)}>
          <Text size="xs" style={{ color: theme.colors.textDim }}>
            {circle?.name}
          </Text>
          <Text
            tx="circles:inviteReady"
            size="xs"
            style={{ color: theme.colors.textDim, textAlign: "center" }}
          />
          <View style={themed($qr)}>
            <QRCode
              value={`hearth://join/${selected.code}`}
              size={180}
              backgroundColor="#FFFFFF"
              color="#1E1714"
            />
          </View>
          <Text weight="bold" style={{ fontSize: 34, lineHeight: 42, letterSpacing: 6 }}>
            {selected.code}
          </Text>
          <Text size="xxs" style={{ color: theme.colors.textFaint }}>
            {selected.expiresAt
              ? translate("circle:inviteExpires", {
                  time: relativeTime(selected.expiresAt).replace(" ago", ""),
                })
              : ""}
            {selected.maxUses != null
              ? ` · ${translate("circle:inviteUses", { uses: selected.uses, max: selected.maxUses })}`
              : ` · ${translate("circle:inviteUnlimited")}`}
          </Text>
          <View
            style={{ flexDirection: "row", gap: theme.spacing.xs, marginTop: theme.spacing.sm }}
          >
            <PrimaryButton
              tx="common:share"
              variant="gradient"
              onPress={() => share(selected)}
              style={{ flex: 1 }}
              Left={<Ionicons name="share-outline" size={18} color="#FFFFFF" />}
            />
            <PrimaryButton
              tx="common:copy"
              variant="soft"
              onPress={() => copy(selected)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : !isLoading ? (
        <View style={themed($hero)}>
          <Ionicons name="qr-code-outline" size={40} color={theme.colors.textFaint} />
          <Text size="sm" style={{ color: theme.colors.textDim }}>
            No active invites.
          </Text>
        </View>
      ) : null}

      <PrimaryButton
        tx="circle:newInvite"
        variant={selected ? "soft" : "gradient"}
        onPress={mint}
        loading={createInvite.isPending}
        style={{ marginHorizontal: theme.spacing.md, marginTop: theme.spacing.md }}
      />

      {active.length > 1 ? (
        <>
          <SectionHeader tx="circle:invites" />
          <View
            style={{
              marginHorizontal: theme.spacing.md,
              borderRadius: 20,
              backgroundColor: theme.colors.surface,
              overflow: "hidden",
            }}
          >
            {active.map((invite) => (
              <Pressable
                key={invite.id}
                onPress={() => setSelectedId(invite.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                }}
              >
                <Ionicons
                  name={invite.id === selected?.id ? "radio-button-on" : "radio-button-off"}
                  size={18}
                  color={theme.colors.tint}
                />
                <Text weight="medium" style={{ flex: 1, letterSpacing: 2 }}>
                  {invite.code}
                </Text>
                <Pressable
                  onPress={() =>
                    revokeInvite.mutate(invite.id, {
                      onError: (error) => toast.error((error as Error).message),
                    })
                  }
                  hitSlop={8}
                >
                  <Text size="xs" tx="circle:revoke" style={{ color: theme.colors.error }} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        </>
      ) : selected ? (
        <Pressable
          onPress={() =>
            revokeInvite.mutate(selected.id, {
              onError: (error) => toast.error((error as Error).message),
            })
          }
          style={{ alignSelf: "center", marginTop: theme.spacing.md }}
        >
          <Text size="xs" tx="circle:revoke" style={{ color: theme.colors.error }} />
        </Pressable>
      ) : null}
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  paddingTop: spacing.md,
  paddingBottom: spacing.xxl,
})

const $hero: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  marginHorizontal: spacing.md,
  padding: spacing.lg,
  borderRadius: 28,
  backgroundColor: colors.surface,
  alignItems: "center",
  gap: spacing.xs,
})

const $qr: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.sm,
  borderRadius: 20,
  backgroundColor: "#FFFFFF",
  marginVertical: spacing.sm,
})
