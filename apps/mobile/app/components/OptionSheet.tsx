import { useCallback, useEffect, useRef } from "react"
import { BackHandler, View, type ViewStyle } from "react-native"
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { ListGroup, ListRow } from "@/components/ListRow"
import { Text, type TextProps } from "@/components/Text"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

export interface SheetOption {
  key: string
  label?: string
  tx?: TextProps["tx"]
  destructive?: boolean
  onPress: () => void
}

export interface OptionSheetProps {
  visible: boolean
  titleTx?: TextProps["tx"]
  title?: string
  options: SheetOption[]
  onClose: () => void
}

/**
 * Android's Alert keeps at most three buttons and silently drops the rest, so
 * a four or five way chooser loses its last options. A list has no such limit
 * and reads the same on both platforms.
 *
 * Built on the same modal sheet as PromptDialog so every sheet in the app
 * drags, dismisses and looks the same. There is no Cancel row. The grabber,
 * the backdrop and the back button all dismiss it, and a row that only means
 * "never mind" is noise next to the real choices.
 */
export function OptionSheet({ visible, titleTx, title, options, onClose }: OptionSheetProps) {
  const { themed, theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const sheet = useRef<BottomSheetModal>(null)
  // dismiss() on a modal that was never presented leaves the library's status
  // machine stuck in DISMISSING, after which its portal drops every present().
  // Screens mount this with visible false, so dismiss() only runs once a
  // present() has gone through. See PromptDialog for the same guard.
  const presented = useRef(false)

  useEffect(() => {
    if (visible) {
      presented.current = true
      sheet.current?.present()
    } else if (presented.current) {
      sheet.current?.dismiss()
    }
  }, [visible])

  const handleDismiss = () => {
    presented.current = false
    onClose()
  }

  // The native stack under the sheet would answer the back button by popping
  // the screen and leave the sheet floating over the next one.
  useEffect(() => {
    if (!visible) return
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose()
      return true
    })
    return () => subscription.remove()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  )

  const choose = (action: () => void) => {
    onClose()
    action()
  }

  return (
    <BottomSheetModal
      ref={sheet}
      enableDynamicSizing
      enablePanDownToClose
      topInset={insets.top}
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive }}
      backgroundStyle={{ backgroundColor: theme.colors.background }}
    >
      <BottomSheetView style={themed($sheet)}>
        {titleTx || title ? (
          <Text preset="subheading" tx={titleTx} text={title} style={themed($title)} />
        ) : null}
        {/* The sheet already pads its sides, and a chooser's rows are the
            choice itself, not a way somewhere, so no chevron. */}
        <ListGroup style={{ marginHorizontal: 0 }}>
          {options.map((option) => (
            <ListRow
              key={option.key}
              tx={option.tx}
              text={option.label}
              destructive={option.destructive}
              onPress={() => choose(option.onPress)}
              right={<View />}
            />
          ))}
        </ListGroup>
        <View style={{ height: insets.bottom + theme.spacing.md }} />
      </BottomSheetView>
    </BottomSheetModal>
  )
}

const $sheet: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.xs,
})

const $title: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginBottom: spacing.md,
})
