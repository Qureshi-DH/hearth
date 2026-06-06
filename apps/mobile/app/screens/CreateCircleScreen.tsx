import { useState, type FC } from "react"
import { Pressable, View, type ViewStyle } from "react-native"

import { PrimaryButton } from "@/components/PrimaryButton"
import { SheetScreen } from "@/components/SheetScreen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useCreateCircle } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

const EMOJI = ["🏠", "❤️", "👨‍👩‍👧‍👦", "🌙", "⭐", "🐾", "🚗", "🌿", "🔥", "🛡️"]

export const CreateCircleScreen: FC<AppStackScreenProps<"CreateCircle">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const [name, setName] = useState("")
  const [emoji, setEmoji] = useState("🏠")
  const create = useCreateCircle()
  const setActiveCircle = useSettingsStore((state) => state.setActiveCircle)

  const submit = async () => {
    try {
      const circle = await create.mutateAsync({ name: name.trim(), emoji })
      setActiveCircle(circle.id)
      toast.success(translate("circles:created"))
      navigation.replace("Invites", { circleId: circle.id })
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <SheetScreen scroll>
      <View style={themed($container)}>
        <Text preset="heading" tx="circles:create" />

        <View style={themed($emojiRow)}>
          {EMOJI.map((candidate) => (
            <Pressable
              key={candidate}
              onPress={() => setEmoji(candidate)}
              style={[
                themed($emoji),
                candidate === emoji && {
                  borderColor: theme.colors.tint,
                  backgroundColor: theme.colors.tintSoft,
                },
              ]}
            >
              <Text size="lg">{candidate}</Text>
            </Pressable>
          ))}
        </View>

        <TextField
          value={name}
          onChangeText={setName}
          labelTx="circles:nameLabel"
          placeholderTx="circles:namePlaceholder"
          autoFocus
          maxLength={80}
          returnKeyType="done"
          onSubmitEditing={submit}
          inputWrapperStyle={themed($input)}
          containerStyle={{ marginTop: theme.spacing.lg }}
        />

        <PrimaryButton
          tx="circles:create"
          onPress={submit}
          loading={create.isPending}
          disabled={name.trim().length === 0}
          style={{ marginTop: theme.spacing.lg }}
        />
      </View>
    </SheetScreen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.lg,
})

const $emojiRow: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  flexWrap: "wrap",
  gap: spacing.xs,
  justifyContent: "center",
})

const $emoji: ThemedStyle<ViewStyle> = ({ colors }) => ({
  width: 52,
  height: 52,
  borderRadius: 16,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderColor: "transparent",
  backgroundColor: colors.surface,
})

const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 16,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 6,
})
