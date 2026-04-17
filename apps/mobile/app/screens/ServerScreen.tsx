import { useState, type FC } from "react"
import { View, type ViewStyle } from "react-native"
import Constants from "expo-constants"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { useAuthStore } from "@/stores/auth"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

/** Accepts a bare hostname and tries https first, so nobody has to type a scheme. */
export const ServerScreen: FC<AppStackScreenProps<"Server">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const setServer = useAuthStore((state) => state.setServer)
  const existing = useAuthStore((state) => state.serverUrl)
  const status = useAuthStore((state) => state.status)
  const [url, setUrl] = useState(existing ?? devServerGuess())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const candidates = (raw: string): string[] => {
    const trimmed = raw.trim().replace(/\/+$/, "")
    if (!trimmed) return []
    if (/^https?:\/\//i.test(trimmed)) return [trimmed]
    return [`https://${trimmed}`, `http://${trimmed}`]
  }

  const connect = async () => {
    setError(null)
    setBusy(true)
    try {
      let lastError: unknown = null
      for (const candidate of candidates(url)) {
        try {
          const info = await endpoints.system.probe(candidate)
          setServer(candidate, info)
          useAuthStore.getState().markBooted()
          if (status === "signed_out" && navigation.canGoBack()) navigation.goBack()
          return
        } catch (probeError) {
          lastError = probeError
        }
      }
      setError(describeProbeFailure(lastError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      preset="scroll"
      safeAreaEdges={["top", "bottom"]}
      contentContainerStyle={themed($container)}
    >
      <LinearGradient
        colors={[theme.colors.gradientStart, theme.colors.gradientEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={themed($hero)}
      >
        <Ionicons name="flame" size={44} color="#FFFFFF" />
        <Text weight="bold" size="xxl" style={{ color: "#FFFFFF", marginTop: 12 }}>
          Hearth
        </Text>
        <Text size="xs" style={{ color: "rgba(255,255,255,0.85)", marginTop: 4 }}>
          Your family. Your server. Your data.
        </Text>
      </LinearGradient>

      <View style={themed($body)}>
        <Text preset="heading" tx="server:title" />
        <Text tx="server:subtitle" size="sm" style={{ color: theme.colors.textDim }} />

        <TextField
          value={url}
          onChangeText={setUrl}
          labelTx="server:urlLabel"
          placeholderTx="server:urlPlaceholder"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={connect}
          status={error ? "error" : undefined}
          helper={error ?? undefined}
          helperTx={error ? undefined : "server:hint"}
          containerStyle={{ marginTop: theme.spacing.md }}
          inputWrapperStyle={themed($input)}
        />

        <PrimaryButton
          tx={busy ? "server:connecting" : "server:connect"}
          onPress={connect}
          loading={busy}
          disabled={!url.trim()}
          style={{ marginTop: theme.spacing.lg }}
        />
      </View>
    </Screen>
  )
}

/**
 * Metro already knows which machine serves the JS, and the Hearth server is
 * almost always that same host. Saves hunting for your own LAN address.
 */
function devServerGuess(): string {
  if (!__DEV__) return ""
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.experienceUrl ?? ""
  const host = hostUri
    .replace(/^\w+:\/\//, "")
    .split("/")[0]
    ?.split(":")[0]
  if (!host) return ""
  return `http://${host}:4000`
}

function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("different API")) return message
  if (message.includes("answered")) return translate("server:notHearth")
  if (/abort/i.test(message)) return translate("server:timeout")
  return translate("server:invalid")
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
})

const $hero: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  margin: spacing.md,
  paddingVertical: spacing.xxl,
  borderRadius: 28,
  alignItems: "center",
  justifyContent: "center",
})

const $body: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  paddingHorizontal: spacing.lg,
  paddingBottom: spacing.xl,
  gap: spacing.xs,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
