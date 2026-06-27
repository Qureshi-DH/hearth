import { useEffect, useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { Ionicons } from "@expo/vector-icons"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SheetScreen, SheetTextField } from "@/components/SheetScreen"
import { Text } from "@/components/Text"
import { useAcceptInvite, useInvitePreview } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useAuthStore } from "@/stores/auth"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

/** Accepts a URL, a deep link, or a bare code, since a QR could hold any of them. */
export function extractInviteCode(raw: string): string | null {
  const match = raw.trim().match(/([A-Z0-9]{6,16})\s*$/i)
  return match ? match[1]!.toUpperCase() : null
}

export const JoinCircleScreen: FC<AppStackScreenProps<"JoinCircle">> = ({ navigation, route }) => {
  const { themed, theme } = useAppTheme()
  const status = useAuthStore((state) => state.status)
  const setPendingInvite = useAuthStore((state) => state.setPendingInvite)
  const setActiveCircle = useSettingsStore((state) => state.setActiveCircle)
  const [code, setCode] = useState((route.params?.code ?? "").toUpperCase())
  const [scanning, setScanning] = useState(false)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()

  const preview = useInvitePreview(code.length >= 4 ? code : null)
  const accept = useAcceptInvite()

  // A deep link can land here signed out, so stash the code for after login.
  useEffect(() => {
    if (status !== "signed_in" && code) {
      setPendingInvite(code)
    }
  }, [status, code, setPendingInvite])

  const join = async () => {
    try {
      const result = await accept.mutateAsync(code)
      setActiveCircle(result.circleId)
      toast.success(translate("join:success", { name: result.circleName }))
      navigation.navigate("Main", { screen: "Map" })
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const startScan = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission()
      if (!result.granted) return
    }
    setScanning(true)
  }

  const reason = preview.data && !preview.data.valid ? preview.data.reason : null
  const reasonText =
    reason === "expired"
      ? translate("join:expired")
      : reason === "revoked"
        ? translate("join:revoked")
        : reason === "exhausted"
          ? translate("join:exhausted")
          : reason === "already_member"
            ? translate("join:alreadyMember")
            : reason === "not_found"
              ? translate("join:notFound")
              : null

  return (
    <SheetScreen scroll>
      <View style={themed($container)}>
        <Text preset="heading" tx="join:title" />
        <Text tx="join:subtitle" size="sm" style={{ color: theme.colors.textDim }} />

        {scanning ? (
          <View style={themed($scanner)}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                const found = extractInviteCode(data)
                if (found) {
                  setCode(found)
                  setScanning(false)
                }
              }}
            />
            <Pressable onPress={() => setScanning(false)} style={themed($scanClose)}>
              <Ionicons name="close" size={20} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={startScan} style={themed($scanButton)}>
            <Ionicons name="qr-code-outline" size={22} color={theme.colors.tint} />
            <Text tx="join:scan" weight="medium" size="sm" style={{ color: theme.colors.tint }} />
          </Pressable>
        )}

        <SheetTextField
          value={code}
          onChangeText={(value) => setCode(value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          labelTx="join:codeLabel"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={16}
          style={{ letterSpacing: 4, fontSize: 22, height: 32 }}
          inputWrapperStyle={themed($input)}
          containerStyle={{ marginTop: theme.spacing.lg }}
          status={reasonText ? "error" : undefined}
          helper={reasonText ?? undefined}
        />

        {preview.data?.valid ? (
          <View style={themed($preview)}>
            <Text size="xl">{preview.data.circleEmoji ?? "🏠"}</Text>
            <View style={{ flex: 1 }}>
              <Text weight="semiBold" size="md">
                {preview.data.circleName}
              </Text>
              <Text size="xs" style={{ color: theme.colors.textDim }}>
                {translate("circles:members", { count: preview.data.memberCount })}
                {preview.data.invitedBy
                  ? ` · ${translate("join:invitedBy", { name: preview.data.invitedBy })}`
                  : ""}
              </Text>
            </View>
          </View>
        ) : null}

        <PrimaryButton
          text={
            preview.data?.valid
              ? translate("join:join", { name: preview.data.circleName })
              : translate("join:title")
          }
          onPress={join}
          loading={accept.isPending}
          disabled={!preview.data?.valid}
          style={{ marginTop: theme.spacing.lg }}
        />
      </View>
    </SheetScreen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.lg,
})

const $scanButton: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  marginTop: spacing.md,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: spacing.xs,
  paddingVertical: spacing.md,
  borderRadius: 18,
  backgroundColor: colors.tintSoft,
})

const $scanner: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginTop: spacing.md,
  height: 260,
  borderRadius: 22,
  overflow: "hidden",
  backgroundColor: "#000",
})

const $scanClose: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: 10,
  right: 10,
  width: 36,
  height: 36,
  borderRadius: 18,
  backgroundColor: "rgba(0,0,0,0.5)",
  alignItems: "center",
  justifyContent: "center",
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 8,
})

const $preview: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  marginTop: spacing.md,
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.sm,
  padding: spacing.md,
  borderRadius: 20,
  backgroundColor: colors.surface,
})
