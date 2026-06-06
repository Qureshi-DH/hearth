import { useCallback, useRef } from "react"
import { View, type ViewStyle } from "react-native"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet"
import { useNavigation } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

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

  const Body = scroll ? BottomSheetScrollView : BottomSheetView

  return (
    <BottomSheet
      ref={sheet}
      index={0}
      snapPoints={snapPoints}
      // Without snap points the sheet measures its content, which is what a
      // short form wants. A tall checklist passes its own instead.
      enableDynamicSizing={!snapPoints}
      enablePanDownToClose
      // Dragging it away and tapping the backdrop both end the route, so the
      // sheet never lingers as an empty transparent screen.
      onClose={() => navigation.goBack()}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: theme.colors.tintInactive }}
      backgroundStyle={{ backgroundColor: theme.colors.background }}
      style={{ marginHorizontal: 0 }}
    >
      <Body style={$body}>
        {children}
        {/* Home indicator, plus room so the last control is not flush. */}
        <View style={{ height: insets.bottom + theme.spacing.md }} />
      </Body>
    </BottomSheet>
  )
}

const $body: ViewStyle = { flexGrow: 1 }
