import { View, type ViewStyle } from "react-native"
import { Ionicons } from "@expo/vector-icons"

import type { TxKeyPath } from "@/i18n"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { PrimaryButton } from "./PrimaryButton"
import { Text } from "./Text"

export interface LoadFailedProps {
  headingTx: TxKeyPath
  /** What went wrong, in words, or the reason the request came back with. */
  contentTx?: TxKeyPath
  content?: string
  onRetry: () => void
}

/** In place of a list that never arrived, so a failure never reads as an empty one. */
export function LoadFailed({ headingTx, contentTx, content, onRetry }: LoadFailedProps) {
  const { themed, theme } = useAppTheme()
  return (
    <View style={themed($container)}>
      <View style={themed($icon)}>
        <Ionicons name="cloud-offline-outline" size={26} color={theme.colors.textDim} />
      </View>
      <Text preset="subheading" tx={headingTx} style={{ textAlign: "center" }} />
      {contentTx || content ? (
        <Text
          tx={contentTx}
          text={content}
          size="sm"
          style={{ color: theme.colors.textDim, textAlign: "center" }}
        />
      ) : null}
      <PrimaryButton
        tx="common:retry"
        variant="soft"
        onPress={onRetry}
        style={{ alignSelf: "stretch", marginTop: theme.spacing.sm }}
      />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  alignItems: "center",
  gap: spacing.xs,
  paddingTop: spacing.xxl,
  paddingHorizontal: spacing.lg,
})

const $icon: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  width: 56,
  height: 56,
  borderRadius: 28,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.surfaceElevated,
  marginBottom: spacing.xs,
})
