import { useRef, useState, type ComponentRef, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { ApiError, endpoints } from "@/services/api"
import { describeDevice, useAuthStore } from "@/stores/auth"
import { tokenVault } from "@/stores/tokenVault"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

export const LoginScreen: FC<AppStackScreenProps<"Login">> = ({ navigation }) => {
  const { themed, theme } = useAuthTheme()
  const serverInfo = useAuthStore((state) => state.serverInfo)
  const signedIn = useAuthStore((state) => state.signedIn)
  const passwordRef = useRef<ComponentRef<typeof TextField>>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const response = await endpoints.auth.login({
        email: email.trim(),
        password,
        device: describeDevice(),
      })
      await tokenVault.set({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      })
      signedIn(response.user)
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? translate("login:failed")
          : (caught as Error).message,
      )
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
      <View style={themed($serverChip)}>
        <Ionicons name="server-outline" size={14} color={theme.colors.textDim} />
        <Text size="xxs" style={{ color: theme.colors.textDim }} numberOfLines={1}>
          {translate("server:connectedTo", { name: serverInfo?.serverName ?? "Hearth" })}
        </Text>
        <Pressable onPress={() => navigation.navigate("Server")} hitSlop={8}>
          <Text
            size="xxs"
            weight="medium"
            tx="server:change"
            style={{ color: theme.colors.tint }}
          />
        </Pressable>
      </View>

      <Text preset="heading" tx="login:title" style={{ marginTop: theme.spacing.xl }} />
      <Text tx="login:subtitle" size="sm" style={{ color: theme.colors.textDim }} />

      <TextField
        value={email}
        onChangeText={setEmail}
        labelTx="login:email"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        containerStyle={{ marginTop: theme.spacing.lg }}
        inputWrapperStyle={themed($input)}
      />
      <TextField
        ref={passwordRef}
        value={password}
        onChangeText={setPassword}
        labelTx="login:password"
        secureTextEntry
        autoComplete="password"
        returnKeyType="go"
        onSubmitEditing={submit}
        status={error ? "error" : undefined}
        helper={error ?? undefined}
        containerStyle={{ marginTop: theme.spacing.md }}
        inputWrapperStyle={themed($input)}
      />

      <PrimaryButton
        tx="login:signIn"
        onPress={submit}
        loading={busy}
        disabled={!email || !password}
        style={{ marginTop: theme.spacing.lg }}
      />

      {serverInfo?.registrationMode !== "closed" || serverInfo?.setupRequired ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            gap: 6,
            marginTop: theme.spacing.lg,
          }}
        >
          <Text size="xs" tx="login:noAccount" style={{ color: theme.colors.textDim }} />
          <Pressable onPress={() => navigation.navigate("Register")} hitSlop={8}>
            <Text
              size="xs"
              weight="semiBold"
              tx="login:createAccount"
              style={{ color: theme.colors.tint }}
            />
          </Pressable>
        </View>
      ) : null}
    </Screen>
  )
}

function useAuthTheme() {
  return useAppTheme()
}

const $container: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  flexGrow: 1,
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.md,
  backgroundColor: colors.background,
})

const $serverChip: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.xs,
  alignSelf: "flex-start",
  paddingHorizontal: spacing.sm,
  paddingVertical: 6,
  borderRadius: 999,
  backgroundColor: colors.surface,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
