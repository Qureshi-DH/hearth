import { forwardRef, ReactElement } from "react"
import {
  StyleProp,
  TextStyle,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewStyle,
} from "react-native"

import { useAppTheme } from "@/theme/context"
import { $styles } from "@/theme/styles"
import type { ThemedStyle } from "@/theme/types"

import { Icon, IconTypes } from "./Icon"
import { Text, TextProps } from "./Text"

export interface ListItemProps extends TouchableOpacityProps {
  height?: number
  topSeparator?: boolean
  bottomSeparator?: boolean
  text?: TextProps["text"]
  tx?: TextProps["tx"]
  children?: TextProps["children"]
  txOptions?: TextProps["txOptions"]
  textStyle?: StyleProp<TextStyle>
  TextProps?: TextProps
  containerStyle?: StyleProp<ViewStyle>
  style?: StyleProp<ViewStyle>
  leftIcon?: IconTypes
  leftIconColor?: string
  rightIcon?: IconTypes
  rightIconColor?: string
  RightComponent?: ReactElement
  LeftComponent?: ReactElement
}

interface ListItemActionProps {
  icon?: IconTypes
  iconColor?: string
  Component?: ReactElement
  size: number
  side: "left" | "right"
}

/** @see https://docs.infinite.red/ignite-cli/boilerplate/app/components/ListItem/ */
export const ListItem = forwardRef<View, ListItemProps>(function ListItem(
  props: ListItemProps,
  ref,
) {
  const {
    bottomSeparator,
    children,
    height = 56,
    LeftComponent,
    leftIcon,
    leftIconColor,
    RightComponent,
    rightIcon,
    rightIconColor,
    style,
    text,
    TextProps,
    topSeparator,
    tx,
    txOptions,
    textStyle: $textStyleOverride,
    containerStyle: $containerStyleOverride,
    ...TouchableOpacityProps
  } = props
  const { themed } = useAppTheme()

  const isTouchable =
    TouchableOpacityProps.onPress !== undefined ||
    TouchableOpacityProps.onPressIn !== undefined ||
    TouchableOpacityProps.onPressOut !== undefined ||
    TouchableOpacityProps.onLongPress !== undefined

  const $textStyles = [$textStyle, $textStyleOverride, TextProps?.style]

  const $containerStyles = [
    topSeparator && $separatorTop,
    bottomSeparator && $separatorBottom,
    $containerStyleOverride,
  ]

  const $touchableStyles = [$styles.row, $touchableStyle, { minHeight: height }, style]

  const Wrapper = isTouchable ? TouchableOpacity : View

  return (
    <View ref={ref} style={themed($containerStyles)}>
      <Wrapper {...TouchableOpacityProps} style={$touchableStyles}>
        <ListItemAction
          side="left"
          size={height}
          icon={leftIcon}
          iconColor={leftIconColor}
          Component={LeftComponent}
        />

        <Text {...TextProps} tx={tx} text={text} txOptions={txOptions} style={themed($textStyles)}>
          {children}
        </Text>

        <ListItemAction
          side="right"
          size={height}
          icon={rightIcon}
          iconColor={rightIconColor}
          Component={RightComponent}
        />
      </Wrapper>
    </View>
  )
})

function ListItemAction(props: ListItemActionProps) {
  const { icon, Component, iconColor, size, side } = props
  const { themed } = useAppTheme()

  const $iconContainerStyles = [$iconContainer]

  if (Component) return Component

  if (icon !== undefined) {
    return (
      <Icon
        size={24}
        icon={icon}
        color={iconColor}
        containerStyle={themed([
          $iconContainerStyles,
          side === "left" && $iconContainerLeft,
          side === "right" && $iconContainerRight,
          { height: size },
        ])}
      />
    )
  }

  return null
}

const $separatorTop: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderTopWidth: 1,
  borderTopColor: colors.separator,
})

const $separatorBottom: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderBottomWidth: 1,
  borderBottomColor: colors.separator,
})

const $textStyle: ThemedStyle<TextStyle> = ({ spacing }) => ({
  paddingVertical: spacing.xs,
  alignSelf: "center",
  flexGrow: 1,
  flexShrink: 1,
})

const $touchableStyle: ViewStyle = {
  alignItems: "flex-start",
}

const $iconContainer: ViewStyle = {
  justifyContent: "center",
  alignItems: "center",
  flexGrow: 0,
}
const $iconContainerLeft: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginEnd: spacing.md,
})

const $iconContainerRight: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginStart: spacing.md,
})
