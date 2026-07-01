import { forwardRef, useCallback, useRef, type ComponentRef, type Ref } from "react"
import { View, type ViewStyle } from "react-native"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useNavigation } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { TextField, type TextFieldProps } from "@/components/TextField"
import { useAppTheme } from "@/theme/context"

export interface SheetScreenProps {
  children: React.ReactNode
  /** Omit to let the sheet take the height of its content. */
  snapPoints?: (string | number)[]
  /** Long content needs its own scroller. Short forms must not have one. */
  scroll?: boolean
}

/**
 * A navigator route rendered as a bottom sheet.
 *
 * React Navigation's `presentation: "modal"` is the reason these screens looked
 * like two different apps: iOS gives it a card that slides up over the previous
 * screen, Android gives it a plain full screen. Presenting the route
 * transparently and putting a real bottom sheet inside it makes both platforms
 * agree, and matches the sheets the app already uses elsewhere.
 *
 * Every existing `navigation.navigate("...")` call site keeps working, because
 * this changes how a route is drawn rather than how it is reached.
 */
export function SheetScreen({ children, snapPoints, scroll = false }: SheetScreenProps) {
  const navigation = useNavigation()
  const { theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const sheet = useRef<BottomSheet>(null)

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

  const body = (
    <>
      {children}
      {/* Home indicator, plus room so the last control is not flush. */}
      <View style={{ height: insets.bottom + theme.spacing.md }} />
    </>
  )

  return (
    <BottomSheet
      ref={sheet}
      index={0}
      snapPoints={snapPoints}
      // Without snap points the sheet measures its content, which is what a
      // short form wants. A tall checklist passes its own instead.
      enableDynamicSizing={!snapPoints}
      enablePanDownToClose
      // A sheet sized by its content grows with it, and a tall one would slide
      // under the status bar. This caps the travel, so it stops below the bar
      // and scrolls instead.
      topInset={insets.top}
      // Settles the sheet back down once the keyboard goes. Rising to meet it
      // in the first place takes a SheetTextField, see below.
      keyboardBlurBehavior="restore"
      // Dragging it away and tapping the backdrop both end the route, so the
      // sheet never lingers as an empty transparent screen.
      onClose={() => navigation.goBack()}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive }}
      backgroundStyle={{ backgroundColor: theme.colors.background }}
      style={{ marginHorizontal: 0 }}
    >
      {scroll ? (
        // Same as Screen. With the keyboard up, a ScrollView's default is to
        // spend the first tap on dismissing it, so Save under a raised sheet
        // took two presses and the sheet dropped away under the finger.
        <BottomSheetScrollView style={$body} keyboardShouldPersistTaps="handled">
          {body}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={$body}>{body}</BottomSheetView>
      )}
    </BottomSheet>
  )
}

/**
 * The TextField to use inside any bottom sheet, this one or PromptDialog's.
 *
 * A plain TextField leaves the sheet where it is and lets the keyboard slide
 * over it. The sheet library only offsets itself for a keyboard it can tie to
 * one of its own inputs, and Android is no help under edge-to-edge because the
 * window is never resized for the keyboard. Baking the input in here means no
 * sheet form has to remember to opt in.
 *
 * Rendering it outside a sheet throws, because the library's input reads the
 * sheet context unconditionally.
 */
export const SheetTextField = forwardRef(function SheetTextField(
  props: TextFieldProps,
  ref: Ref<ComponentRef<typeof TextField>>,
) {
  return <TextField ref={ref} InputComponent={BottomSheetTextInput} {...props} />
})

const $body: ViewStyle = { flexGrow: 1 }
