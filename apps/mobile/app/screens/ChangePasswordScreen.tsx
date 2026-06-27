import { useState, type FC } from "react"
import { View, type ViewStyle } from "react-native"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SheetScreen, SheetTextField } from "@/components/SheetScreen"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { endpoints } from "@/services/api"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

export const ChangePasswordScreen: FC<AppStackScreenProps<"ChangePassword">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <SheetScreen scroll>
      <View style={themed($container)}>
        <Text preset="heading" tx="settings:changePassword" />
        <Text
          tx="settings:changePasswordSubtitle"
          size="sm"
          style={{ color: theme.colors.textDim }}
        />
        <SheetTextField
          value={current}
          onChangeText={setCurrent}
          labelTx="settings:currentPassword"
          secureTextEntry
          autoComplete="current-password"
          inputWrapperStyle={themed($input)}
          containerStyle={{ marginTop: theme.spacing.lg }}
        />
        <SheetTextField
          value={next}
          onChangeText={setNext}
          labelTx="settings:newPassword"
          // Passing the hint as helperTx alongside this would win over the
          // server's reason, which then only ever turned the hint red.
          helper={error ?? translate("register:passwordHint")}
          secureTextEntry
          autoComplete="new-password"
          status={error ? "error" : undefined}
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
      </View>
    </SheetScreen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.lg,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
