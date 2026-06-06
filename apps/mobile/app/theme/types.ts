import type { StyleProp } from "react-native"

import { colors as colorsLight } from "./colors"
import { colors as colorsDark } from "./colorsDark"
import { spacing as spacingLight } from "./spacing"
import { spacing as spacingDark } from "./spacingDark"
import { timing } from "./timing"
import { typography } from "./typography"

// undefined means follow the system theme.
export type ImmutableThemeContextModeT = "light" | "dark"
export type ThemeContextModeT = ImmutableThemeContextModeT | undefined

// colorsLight and colorsDark should have the same keys, but different values.
export type Colors = typeof colorsLight | typeof colorsDark
export type Spacing = typeof spacingLight | typeof spacingDark

// These two are consistent across themes.
export type Timing = typeof timing
export type Typography = typeof typography

export interface Theme {
  colors: Colors
  spacing: Spacing
  typography: Typography
  timing: Timing
  isDark: boolean
}

/**
 * @example
 * const $container: ThemedStyle<ViewStyle> = (theme) => ({
 *   flex: 1,
 *   backgroundColor: theme.colors.background,
 *   justifyContent: "center",
 *   alignItems: "center",
 * })
 * // Then use in a component like so:
 * const Component = () => {
 *   const { themed } = useAppTheme()
 *   return <View style={themed($container)} />
 * }
 */
export type ThemedStyle<T> = (theme: Theme) => T
export type ThemedStyleArray<T> = (
  ThemedStyle<T> | StyleProp<T> | (StyleProp<T> | ThemedStyle<T>)[]
)[]

export type AllowedStylesT<T> = ThemedStyle<T> | StyleProp<T> | ThemedStyleArray<T>
export type ThemedFnT = <T>(styleOrStyleFn: AllowedStylesT<T>) => T
