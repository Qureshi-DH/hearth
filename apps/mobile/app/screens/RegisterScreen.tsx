import { useRef, useState, type ComponentRef, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"

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
import { useHeader } from "@/utils/useHeader"

export const RegisterScreen: FC<AppStackScreenProps<"Register">> = ({ navigation, route }) => {
  const { themed, theme } = useAppTheme()
  const serverInfo = useAuthStore((state) => state.serverInfo)
  const pendingInvite = useAuthStore((state) => state.pendingInviteCode)
  const signedIn = useAuthStore((state) => state.signedIn)
  const setPendingInvite = useAuthStore((state) => state.setPendingInvite)
  // The server lets the very first account through without an invite, and on a
  // brand new server there is no circle to be invited to anyway.
  const isFirstAccount = serverInfo?.setupRequired === true
  const requiresInvite = serverInfo?.registrationMode === "invite" && !isFirstAccount

  const emailRef = useRef<ComponentRef<typeof TextField>>(null)
  const passwordRef = useRef<ComponentRef<typeof TextField>>(null)
  const [displayName, setDisplayName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteCode, setInviteCode] = useState(route.params?.inviteCode ?? pendingInvite ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useHeader({ leftIcon: "back", onLeftPress: () => navigation.goBack() }, [navigation])

  const canSubmit =
    displayName.trim().length > 0 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    password.length >= 10 &&
    (!requiresInvite || inviteCode.trim().length >= 4)

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const response = await endpoints.auth.register({
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        inviteCode: inviteCode.trim() || undefined,
        device: describeDevice(),
      })
      await tokenVault.set({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      })
      setPendingInvite(null)
      signedIn(response.user)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : translate("errors:generic"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <Text preset="heading" tx="register:title" />
      <Text tx="register:subtitle" size="sm" style={{ color: theme.colors.textDim }} />

      <TextField
        value={displayName}
        onChangeText={setDisplayName}
        labelTx="register:name"
        placeholderTx="register:namePlaceholder"
        autoComplete="name"
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
        containerStyle={{ marginTop: theme.spacing.lg }}
        inputWrapperStyle={themed($input)}
      />
      <TextField
        ref={emailRef}
        value={email}
        onChangeText={setEmail}
        labelTx="register:email"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        containerStyle={{ marginTop: theme.spacing.md }}
        inputWrapperStyle={themed($input)}
      />
      <TextField
        ref={passwordRef}
        value={password}
        onChangeText={setPassword}
        labelTx="register:password"
        helperTx="register:passwordHint"
        secureTextEntry
        autoComplete="new-password"
        returnKeyType="next"
        containerStyle={{ marginTop: theme.spacing.md }}
        inputWrapperStyle={themed($input)}
      />
      {isFirstAccount ? (
        <Text
          size="xs"
          tx="register:firstAccount"
          style={{ color: theme.colors.textDim, marginTop: theme.spacing.md }}
        />
      ) : (
        <TextField
          value={inviteCode}
          onChangeText={(value) => setInviteCode(value.toUpperCase())}
          labelTx="register:inviteCode"
          helperTx={requiresInvite ? "register:inviteHint" : "register:inviteOptional"}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={16}
          returnKeyType="go"
          onSubmitEditing={submit}
          containerStyle={{ marginTop: theme.spacing.md }}
          inputWrapperStyle={themed($input)}
        />
      )}

      {error ? (
        <Text size="xs" style={{ color: theme.colors.error, marginTop: theme.spacing.sm }}>
          {error}
        </Text>
      ) : null}

      <PrimaryButton
        tx="register:create"
        onPress={submit}
        loading={busy}
        disabled={!canSubmit}
        style={{ marginTop: theme.spacing.lg }}
      />

      <View
        style={{
          flexDirection: "row",
          justifyContent: "center",
          gap: 6,
          marginTop: theme.spacing.lg,
        }}
      >
        <Text size="xs" tx="register:haveAccount" style={{ color: theme.colors.textDim }} />
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <Text
            size="xs"
            weight="semiBold"
            tx="register:signIn"
            style={{ color: theme.colors.tint }}
          />
        </Pressable>
      </View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  flexGrow: 1,
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.sm,
  backgroundColor: colors.background,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
