import { Image, ImageProps, ImageStyle, StyleProp, TextStyle, View, ViewStyle } from "react-native"

import { translate } from "@/i18n/translate"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { Button, ButtonProps } from "./Button"
import { Text, TextProps } from "./Text"

interface EmptyStateProps {
  preset?: "generic"
  style?: StyleProp<ViewStyle>
  imageSource?: ImageProps["source"]
  imageStyle?: StyleProp<ImageStyle>
  ImageProps?: Omit<ImageProps, "source">
  heading?: TextProps["text"]
  headingTx?: TextProps["tx"]
  headingTxOptions?: TextProps["txOptions"]
  headingStyle?: StyleProp<TextStyle>
  HeadingTextProps?: TextProps
  content?: TextProps["text"]
  contentTx?: TextProps["tx"]
  contentTxOptions?: TextProps["txOptions"]
  contentStyle?: StyleProp<TextStyle>
  ContentTextProps?: TextProps
  button?: TextProps["text"]
  buttonTx?: TextProps["tx"]
  buttonTxOptions?: TextProps["txOptions"]
  buttonStyle?: ButtonProps["style"]
  buttonTextStyle?: ButtonProps["textStyle"]
  buttonOnPress?: ButtonProps["onPress"]
  ButtonProps?: ButtonProps
}

interface EmptyStatePresetItem {
  imageSource?: ImageProps["source"]
  heading: TextProps["text"]
  content: TextProps["text"]
  button: TextProps["text"]
}

export function EmptyState(props: EmptyStateProps) {
  const {
    theme,
    themed,
    theme: { spacing },
  } = useAppTheme()

  const EmptyStatePresets = {
    generic: {
      heading: translate("emptyStateComponent:generic.heading"),
      content: translate("emptyStateComponent:generic.content"),
      button: translate("emptyStateComponent:generic.button"),
    } as EmptyStatePresetItem,
  } as const

  const preset = props.preset ? EmptyStatePresets[props.preset] : undefined

  const {
    button = preset?.button,
    buttonTx,
    buttonOnPress,
    buttonTxOptions,
    content = preset?.content,
    contentTx,
    contentTxOptions,
    heading = preset?.heading,
    headingTx,
    headingTxOptions,
    imageSource = preset?.imageSource,
    style: $containerStyleOverride,
    buttonStyle: $buttonStyleOverride,
    buttonTextStyle: $buttonTextStyleOverride,
    contentStyle: $contentStyleOverride,
    headingStyle: $headingStyleOverride,
    imageStyle: $imageStyleOverride,
    ButtonProps,
    ContentTextProps,
    HeadingTextProps,
    ImageProps,
  } = props

  const isImagePresent = !!imageSource
  const isHeadingPresent = !!(heading || headingTx)
  const isContentPresent = !!(content || contentTx)
  const isButtonPresent = !!(button || buttonTx)

  const $containerStyles = [$containerStyleOverride]
  const $imageStyles = [
    $image,
    (isHeadingPresent || isContentPresent || isButtonPresent) && { marginBottom: spacing.xxxs },
    $imageStyleOverride,
    ImageProps?.style,
  ]
  const $headingStyles = [
    themed($heading),
    isImagePresent && { marginTop: spacing.xxxs },
    (isContentPresent || isButtonPresent) && { marginBottom: spacing.xxxs },
    $headingStyleOverride,
    HeadingTextProps?.style,
  ]
  const $contentStyles = [
    themed($content),
    (isImagePresent || isHeadingPresent) && { marginTop: spacing.xxxs },
    isButtonPresent && { marginBottom: spacing.xxxs },
    $contentStyleOverride,
    ContentTextProps?.style,
  ]
  const $buttonStyles = [
    (isImagePresent || isHeadingPresent || isContentPresent) && { marginTop: spacing.xl },
    $buttonStyleOverride,
    ButtonProps?.style,
  ]

  return (
    <View style={$containerStyles}>
      {isImagePresent && (
        <Image
          source={imageSource}
          {...ImageProps}
          style={$imageStyles}
          tintColor={theme.colors.palette.neutral900}
        />
      )}

      {isHeadingPresent && (
        <Text
          preset="subheading"
          text={heading}
          tx={headingTx}
          txOptions={headingTxOptions}
          {...HeadingTextProps}
          style={$headingStyles}
        />
      )}

      {isContentPresent && (
        <Text
          text={content}
          tx={contentTx}
          txOptions={contentTxOptions}
          {...ContentTextProps}
          style={$contentStyles}
        />
      )}

      {isButtonPresent && (
        <Button
          onPress={buttonOnPress}
          text={button}
          tx={buttonTx}
          txOptions={buttonTxOptions}
          textStyle={$buttonTextStyleOverride}
          {...ButtonProps}
          style={$buttonStyles}
        />
      )}
    </View>
  )
}

const $image: ImageStyle = { alignSelf: "center" }
const $heading: ThemedStyle<TextStyle> = ({ spacing }) => ({
  textAlign: "center",
  paddingHorizontal: spacing.lg,
})
const $content: ThemedStyle<TextStyle> = ({ spacing }) => ({
  textAlign: "center",
  paddingHorizontal: spacing.lg,
})
