import { ReactElement } from "react"
import {
  StyleProp,
  TextStyle,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewStyle,
} from "react-native"

import { isRTL } from "@/i18n"
import { translate } from "@/i18n/translate"
import { useAppTheme } from "@/theme/context"
import { $styles } from "@/theme/styles"
import type { ThemedStyle } from "@/theme/types"
import { ExtendedEdge, useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"

import { IconTypes, PressableIcon } from "./Icon"
import { Text, TextProps } from "./Text"

export interface HeaderProps {
  /**
   * `center` pins the title to the middle of the header and lets a long title
   * clip. `flex` centres it between the action buttons, which looks off-centre
   * when the two sides are different widths.
   */
  titleMode?: "center" | "flex"
  titleStyle?: StyleProp<TextStyle>
  titleContainerStyle?: StyleProp<ViewStyle>
  style?: StyleProp<ViewStyle>
  containerStyle?: StyleProp<ViewStyle>
  backgroundColor?: string
  title?: TextProps["text"]
  titleTx?: TextProps["tx"]
  titleTxOptions?: TextProps["txOptions"]
  leftIcon?: IconTypes
  leftIconColor?: string
  leftText?: TextProps["text"]
  leftTx?: TextProps["tx"]
  LeftActionComponent?: ReactElement
  leftTxOptions?: TextProps["txOptions"]
  onLeftPress?: TouchableOpacityProps["onPress"]
  rightIcon?: IconTypes
  rightIconColor?: string
  rightText?: TextProps["text"]
  rightTx?: TextProps["tx"]
  RightActionComponent?: ReactElement
  rightTxOptions?: TextProps["txOptions"]
  onRightPress?: TouchableOpacityProps["onPress"]
  safeAreaEdges?: ExtendedEdge[]
}

interface HeaderActionProps {
  backgroundColor?: string
  icon?: IconTypes
  iconColor?: string
  text?: TextProps["text"]
  tx?: TextProps["tx"]
  txOptions?: TextProps["txOptions"]
  onPress?: TouchableOpacityProps["onPress"]
  ActionComponent?: ReactElement
}

/** @see https://docs.infinite.red/ignite-cli/boilerplate/app/components/Header/ */
export function Header(props: HeaderProps) {
  const {
    theme: { colors },
    themed,
  } = useAppTheme()
  const {
    backgroundColor = colors.background,
    LeftActionComponent,
    leftIcon,
    leftIconColor,
    leftText,
    leftTx,
    leftTxOptions,
    onLeftPress,
    onRightPress,
    RightActionComponent,
    rightIcon,
    rightIconColor,
    rightText,
    rightTx,
    rightTxOptions,
    safeAreaEdges = ["top"],
    title,
    titleMode = "center",
    titleTx,
    titleTxOptions,
    titleContainerStyle: $titleContainerStyleOverride,
    style: $styleOverride,
    titleStyle: $titleStyleOverride,
    containerStyle: $containerStyleOverride,
  } = props

  const $containerInsets = useSafeAreaInsetsStyle(safeAreaEdges)

  const titleContent = titleTx ? translate(titleTx, titleTxOptions) : title

  return (
    <View style={[$container, $containerInsets, { backgroundColor }, $containerStyleOverride]}>
      <View style={[$styles.row, $wrapper, $styleOverride]}>
        <HeaderAction
          tx={leftTx}
          text={leftText}
          icon={leftIcon}
          iconColor={leftIconColor}
          onPress={onLeftPress}
          txOptions={leftTxOptions}
          backgroundColor={backgroundColor}
          ActionComponent={LeftActionComponent}
        />

        {!!titleContent && (
          <View
            style={[
              $titleWrapperPointerEvents,
              titleMode === "center" && themed($titleWrapperCenter),
              titleMode === "flex" && $titleWrapperFlex,
              $titleContainerStyleOverride,
            ]}
          >
            <Text
              weight="medium"
              size="md"
              text={titleContent}
              style={[$title, $titleStyleOverride]}
            />
          </View>
        )}

        <HeaderAction
          tx={rightTx}
          text={rightText}
          icon={rightIcon}
          iconColor={rightIconColor}
          onPress={onRightPress}
          txOptions={rightTxOptions}
          backgroundColor={backgroundColor}
          ActionComponent={RightActionComponent}
        />
      </View>
    </View>
  )
}

function HeaderAction(props: HeaderActionProps) {
  const { backgroundColor, icon, text, tx, txOptions, onPress, ActionComponent, iconColor } = props
  const { themed } = useAppTheme()

  const content = tx ? translate(tx, txOptions) : text

  if (ActionComponent) return ActionComponent

  if (content) {
    return (
      <TouchableOpacity
        style={themed([$actionTextContainer, { backgroundColor }])}
        onPress={onPress}
        disabled={!onPress}
        activeOpacity={0.8}
      >
        <Text weight="medium" size="md" text={content} style={themed($actionText)} />
      </TouchableOpacity>
    )
  }

  if (icon) {
    return (
      <PressableIcon
        size={24}
        icon={icon}
        color={iconColor}
        onPress={onPress}
        containerStyle={themed([$actionIconContainer, { backgroundColor }])}
        style={isRTL ? { transform: [{ rotate: "180deg" }] } : {}}
      />
    )
  }

  return <View style={[$actionFillerContainer, { backgroundColor }]} />
}

const $wrapper: ViewStyle = {
  height: 56,
  alignItems: "center",
  justifyContent: "space-between",
}

const $container: ViewStyle = {
  width: "100%",
}

const $title: TextStyle = {
  textAlign: "center",
}

const $actionTextContainer: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexGrow: 0,
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  paddingHorizontal: spacing.md,
  zIndex: 2,
})

const $actionText: ThemedStyle<TextStyle> = ({ colors }) => ({
  color: colors.tint,
})

const $actionIconContainer: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexGrow: 0,
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  paddingHorizontal: spacing.md,
  zIndex: 2,
})

const $actionFillerContainer: ViewStyle = {
  width: 16,
}

const $titleWrapperPointerEvents: ViewStyle = {
  pointerEvents: "none",
}

const $titleWrapperCenter: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  width: "100%",
  position: "absolute",
  paddingHorizontal: spacing.xxl,
  zIndex: 1,
})

const $titleWrapperFlex: ViewStyle = {
  justifyContent: "center",
  flexGrow: 1,
}
