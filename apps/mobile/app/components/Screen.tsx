import { ReactNode, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  KeyboardAvoidingViewProps,
  LayoutChangeEvent,
  Platform,
  ScrollViewProps,
  StyleProp,
  View,
  ViewStyle,
} from "react-native"
import { useScrollToTop } from "@react-navigation/native"
import { SystemBars, SystemBarsProps, SystemBarStyle } from "react-native-edge-to-edge"
import {
  KeyboardAwareScrollView,
  type KeyboardAwareScrollViewRef,
} from "react-native-keyboard-controller"

import { useAppTheme } from "@/theme/context"
import { $styles } from "@/theme/styles"
import { ExtendedEdge, useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"

export const DEFAULT_BOTTOM_OFFSET = 50

interface BaseScreenProps {
  children?: ReactNode
  style?: StyleProp<ViewStyle>
  contentContainerStyle?: StyleProp<ViewStyle>
  safeAreaEdges?: ExtendedEdge[]
  backgroundColor?: string
  systemBarStyle?: SystemBarStyle
  keyboardOffset?: number
  keyboardBottomOffset?: number
  SystemBarsProps?: SystemBarsProps
  KeyboardAvoidingViewProps?: KeyboardAvoidingViewProps
}

interface FixedScreenProps extends BaseScreenProps {
  preset?: "fixed"
}
interface ScrollScreenProps extends BaseScreenProps {
  preset?: "scroll"
  keyboardShouldPersistTaps?: "handled" | "always" | "never"
  ScrollViewProps?: ScrollViewProps
}

interface AutoScreenProps extends Omit<ScrollScreenProps, "preset"> {
  preset?: "auto"
  /**
   * Content shorter than `percent` of the viewport, or `point` pixels shorter,
   * turns scrolling off.
   */
  scrollEnabledToggleThreshold?: { percent?: number; point?: number }
}

export type ScreenProps = ScrollScreenProps | FixedScreenProps | AutoScreenProps

const isIos = Platform.OS === "ios"

type ScreenPreset = "fixed" | "scroll" | "auto"

function isNonScrolling(preset?: ScreenPreset) {
  return !preset || preset === "fixed"
}

function useAutoPreset(props: AutoScreenProps): {
  scrollEnabled: boolean
  onContentSizeChange: (w: number, h: number) => void
  onLayout: (e: LayoutChangeEvent) => void
} {
  const { preset, scrollEnabledToggleThreshold } = props
  const { percent = 0.92, point = 0 } = scrollEnabledToggleThreshold || {}

  const scrollViewHeight = useRef<null | number>(null)
  const scrollViewContentHeight = useRef<null | number>(null)
  const [scrollEnabled, setScrollEnabled] = useState(true)

  function updateScrollState() {
    if (scrollViewHeight.current === null || scrollViewContentHeight.current === null) return

    const contentFitsScreen = (function () {
      if (point) {
        return scrollViewContentHeight.current < scrollViewHeight.current - point
      } else {
        return scrollViewContentHeight.current < scrollViewHeight.current * percent
      }
    })()

    if (scrollEnabled && contentFitsScreen) setScrollEnabled(false)

    if (!scrollEnabled && !contentFitsScreen) setScrollEnabled(true)
  }

  function onContentSizeChange(w: number, h: number) {
    scrollViewContentHeight.current = h
    updateScrollState()
  }

  function onLayout(e: LayoutChangeEvent) {
    const { height } = e.nativeEvent.layout
    scrollViewHeight.current = height
    updateScrollState()
  }

  if (preset === "auto") updateScrollState()

  return {
    scrollEnabled: preset === "auto" ? scrollEnabled : true,
    onContentSizeChange,
    onLayout,
  }
}

function ScreenWithoutScrolling(props: ScreenProps) {
  const { style, contentContainerStyle, children, preset } = props
  return (
    <View style={[$outerStyle, style]}>
      <View style={[$innerStyle, preset === "fixed" && $justifyFlexEnd, contentContainerStyle]}>
        {children}
      </View>
    </View>
  )
}

function ScreenWithScrolling(props: ScreenProps) {
  const {
    children,
    keyboardShouldPersistTaps = "handled",
    keyboardBottomOffset = DEFAULT_BOTTOM_OFFSET,
    contentContainerStyle,
    ScrollViewProps,
    style,
  } = props as ScrollScreenProps

  const ref = useRef<KeyboardAwareScrollViewRef>(null)

  const { scrollEnabled, onContentSizeChange, onLayout } = useAutoPreset(props as AutoScreenProps)

  // Tapping the active tab scrolls this list back to the top.
  // https://reactnavigation.org/docs/use-scroll-to-top/
  useScrollToTop(ref)

  return (
    <KeyboardAwareScrollView
      bottomOffset={keyboardBottomOffset}
      {...{ keyboardShouldPersistTaps, scrollEnabled, ref }}
      {...ScrollViewProps}
      onLayout={(e) => {
        onLayout(e)
        ScrollViewProps?.onLayout?.(e)
      }}
      onContentSizeChange={(w: number, h: number) => {
        onContentSizeChange(w, h)
        ScrollViewProps?.onContentSizeChange?.(w, h)
      }}
      style={[$outerStyle, ScrollViewProps?.style, style]}
      contentContainerStyle={[
        $innerStyle,
        ScrollViewProps?.contentContainerStyle,
        contentContainerStyle,
      ]}
    >
      {children}
    </KeyboardAwareScrollView>
  )
}

/** @see https://docs.infinite.red/ignite-cli/boilerplate/app/components/Screen/ */
export function Screen(props: ScreenProps) {
  const {
    theme: { colors },
    themeContext,
  } = useAppTheme()
  const {
    backgroundColor,
    KeyboardAvoidingViewProps,
    keyboardOffset = 0,
    safeAreaEdges,
    SystemBarsProps,
    systemBarStyle,
  } = props

  const $containerInsets = useSafeAreaInsetsStyle(safeAreaEdges)

  return (
    <View
      style={[
        $containerStyle,
        { backgroundColor: backgroundColor || colors.background },
        $containerInsets,
      ]}
    >
      <SystemBars
        style={systemBarStyle || (themeContext === "dark" ? "light" : "dark")}
        {...SystemBarsProps}
      />

      <KeyboardAvoidingView
        behavior={isIos ? "padding" : "height"}
        keyboardVerticalOffset={keyboardOffset}
        {...KeyboardAvoidingViewProps}
        style={[$styles.flex1, KeyboardAvoidingViewProps?.style]}
      >
        {isNonScrolling(props.preset) ? (
          <ScreenWithoutScrolling {...props} />
        ) : (
          <ScreenWithScrolling {...props} />
        )}
      </KeyboardAvoidingView>
    </View>
  )
}

const $containerStyle: ViewStyle = {
  flex: 1,
  height: "100%",
  width: "100%",
}

const $outerStyle: ViewStyle = {
  flex: 1,
  height: "100%",
  width: "100%",
}

const $justifyFlexEnd: ViewStyle = {
  justifyContent: "flex-end",
}

const $innerStyle: ViewStyle = {
  justifyContent: "flex-start",
  alignItems: "stretch",
}
