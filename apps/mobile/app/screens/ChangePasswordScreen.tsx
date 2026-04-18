import { useState, type FC } from "react"
import { type ViewStyle } from "react-native"

import { PrimaryButton } from "@/components/PrimaryButton"
import { Screen } from "@/components/Screen"
import { TextField } from "@/components/TextField"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { useHeader } from "@/utils/useHeader"

export const ChangePasswordScreen: FC<AppStackScreenProps<"ChangePassword">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useHeader(
    { titleTx: "settings:changePassword", leftIcon: "x", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await endpoints.auth.changePassword({ currentPassword: current, newPassword: next })
      toast.success(translate("settings:passwordChanged"))
      navigation.goBack()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen preset="scroll" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <TextField
        value={current}
        onChangeText={setCurrent}
        labelTx="settings:currentPassword"
        secureTextEntry
        autoComplete="current-password"
        inputWrapperStyle={themed($input)}
      />
      <TextField
        value={next}
        onChangeText={setNext}
        labelTx="settings:newPassword"
        helperTx="register:passwordHint"
        secureTextEntry
        autoComplete="new-password"
        status={error ? "error" : undefined}
        helper={error ?? undefined}
        containerStyle={{ marginTop: theme.spacing.md }}
        inputWrapperStyle={themed($input)}
      />
      <PrimaryButton
        tx="common:save"
        onPress={submit}
        loading={busy}
        disabled={!current || next.length < 10}
        style={{ marginTop: theme.spacing.lg }}
      />
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexGrow: 1,
  backgroundColor: colors.background,
  padding: spacing.lg,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
