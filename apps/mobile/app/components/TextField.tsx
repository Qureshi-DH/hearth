import {
  ComponentType,
  ElementType,
  forwardRef,
  Ref,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import {
  ImageStyle,
  Platform,
  Pressable,
  StyleProp,
  // eslint-disable-next-line no-restricted-imports
  TextInput,
  TextInputInstance,
  TextInputProps,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"

import { isRTL } from "@/i18n"
import { translate } from "@/i18n/translate"
import { useAppTheme } from "@/theme/context"
import { $styles } from "@/theme/styles"
import type { ThemedStyle, ThemedStyleArray } from "@/theme/types"

import { Text, TextProps } from "./Text"

export interface TextFieldAccessoryProps {
  style: StyleProp<ViewStyle | TextStyle | ImageStyle>
  status: TextFieldProps["status"]
  multiline: boolean
  editable: boolean
}

export interface TextFieldProps extends Omit<TextInputProps, "ref"> {
  status?: "error" | "disabled"
  label?: TextProps["text"]
  labelTx?: TextProps["tx"]
  labelTxOptions?: TextProps["txOptions"]
  LabelTextProps?: TextProps
  helper?: TextProps["text"]
  helperTx?: TextProps["tx"]
  helperTxOptions?: TextProps["txOptions"]
  HelperTextProps?: TextProps
  placeholder?: TextProps["text"]
  placeholderTx?: TextProps["tx"]
  placeholderTxOptions?: TextProps["txOptions"]
  style?: StyleProp<TextStyle>
  containerStyle?: StyleProp<ViewStyle>
  inputWrapperStyle?: StyleProp<ViewStyle>
  /**
   * Memoize this. A new component identity remounts the accessory. On a
   * secureTextEntry field it takes the place of the show password toggle.
   */
  RightAccessory?: ComponentType<TextFieldAccessoryProps>
  /** Memoize this. A new component identity remounts the accessory. */
  LeftAccessory?: ComponentType<TextFieldAccessoryProps>
  /**
   * What draws the input itself. A bottom sheet only rides the keyboard for
   * inputs it knows about, so sheet forms swap in the sheet library's own.
   * Typed loosely because that one is a memo around a forwardRef, which
   * ComponentType<TextInputProps> rejects. Whatever is passed must forward its
   * ref to a native TextInput so focus() keeps working.
   */
  InputComponent?: ElementType
}

/** @see https://docs.infinite.red/ignite-cli/boilerplate/app/components/TextField/ */
export const TextField = forwardRef(function TextField(
  props: TextFieldProps,
  ref: Ref<TextInputInstance>,
) {
  const {
    labelTx,
    label,
    labelTxOptions,
    placeholderTx,
    placeholder,
    placeholderTxOptions,
    helper,
    helperTx,
    helperTxOptions,
    status,
    RightAccessory,
    LeftAccessory,
    HelperTextProps,
    LabelTextProps,
    InputComponent = TextInput,
    style: $inputStyleOverride,
    containerStyle: $containerStyleOverride,
    inputWrapperStyle: $inputWrapperStyleOverride,
    secureTextEntry,
    ...TextInputProps
  } = props
  const input = useRef<TextInputInstance>(null)
  const [revealed, setRevealed] = useState(false)
  // A typo on a phone keyboard is easy to make and impossible to see in a
  // hidden field, so every password field gets the toggle.
  const revealable = !!secureTextEntry && !RightAccessory

  const {
    themed,
    theme: { colors },
  } = useAppTheme()

  const disabled = TextInputProps.editable === false || status === "disabled"

  const placeholderContent = placeholderTx
    ? translate(placeholderTx, placeholderTxOptions)
    : placeholder
  const labelContent = labelTx ? translate(labelTx, labelTxOptions) : label

  const $containerStyles = [$containerStyleOverride]

  const $labelStyles = [$labelStyle, LabelTextProps?.style]

  const $inputWrapperStyles = [
    $styles.row,
    $inputWrapperStyle,
    status === "error" && { borderColor: colors.error },
    TextInputProps.multiline && { minHeight: 112 },
    LeftAccessory && { paddingStart: 0 },
    (RightAccessory || revealable) && { paddingEnd: 0 },
    $inputWrapperStyleOverride,
  ]

  const $inputStyles: ThemedStyleArray<TextStyle> = [
    $inputStyle,
    disabled && { color: colors.textDim },
    isRTL && { textAlign: "right" as TextStyle["textAlign"] },
    TextInputProps.multiline && { height: "auto" },
    $inputStyleOverride,
  ]

  const $helperStyles = [
    $helperStyle,
    status === "error" && { color: colors.error },
    HelperTextProps?.style,
  ]

  function focusInput() {
    if (disabled) return

    input.current?.focus()
  }

  useImperativeHandle(ref, () => input.current as TextInputInstance)

  return (
    <TouchableOpacity
      activeOpacity={1}
      style={$containerStyles}
      onPress={focusInput}
      // Left accessible, iOS folds the whole field into one element, and the
      // password toggle inside it could never be reached.
      accessible={false}
      accessibilityState={{ disabled }}
    >
      {!!(label || labelTx) && (
        <Text
          preset="formLabel"
          text={label}
          tx={labelTx}
          txOptions={labelTxOptions}
          // VoiceOver hears it from the input instead, and would read it twice.
          accessibilityElementsHidden={Platform.OS === "ios"}
          {...LabelTextProps}
          style={themed($labelStyles)}
        />
      )}

      <View style={themed($inputWrapperStyles)}>
        {!!LeftAccessory && (
          <LeftAccessory
            style={themed($leftAccessoryStyle)}
            status={status}
            editable={!disabled}
            multiline={TextInputProps.multiline ?? false}
          />
        )}

        <InputComponent
          ref={input}
          underlineColorAndroid={colors.transparent}
          textAlignVertical="top"
          placeholder={placeholderContent}
          placeholderTextColor={colors.textDim}
          // On Android the label is its own element and stays off the input,
          // because TalkBack reads an edit box's description in place of its text.
          accessibilityLabel={Platform.OS === "ios" ? labelContent : undefined}
          // A shown password is typed in the open, where the keyboard would
          // capitalise and correct it into something the server refuses.
          {...(revealable
            ? { autoCapitalize: "none", autoCorrect: false, spellCheck: false }
            : null)}
          {...TextInputProps}
          secureTextEntry={!!secureTextEntry && !revealed}
          // Shown on Android, it still asks the keyboard not to learn it.
          keyboardType={
            revealable && revealed && Platform.OS === "android"
              ? "visible-password"
              : TextInputProps.keyboardType
          }
          editable={!disabled}
          style={themed($inputStyles)}
        />

        {revealable && (
          <Pressable
            onPress={() => setRevealed((value) => !value)}
            disabled={disabled}
            hitSlop={8}
            accessibilityRole="togglebutton"
            accessibilityLabel={translate("common:showPassword")}
            accessibilityState={{ checked: revealed, disabled }}
            style={themed($revealStyle)}
          >
            <Ionicons
              name={revealed ? "eye-off-outline" : "eye-outline"}
              size={20}
              color={colors.textDim}
            />
          </Pressable>
        )}

        {!!RightAccessory && (
          <RightAccessory
            style={themed($rightAccessoryStyle)}
            status={status}
            editable={!disabled}
            multiline={TextInputProps.multiline ?? false}
          />
        )}
      </View>

      {!!(helper || helperTx) && (
        <Text
          preset="formHelper"
          text={helper}
          tx={helperTx}
          txOptions={helperTxOptions}
          {...HelperTextProps}
          style={themed($helperStyles)}
        />
      )}
    </TouchableOpacity>
  )
})

const $labelStyle: ThemedStyle<TextStyle> = ({ spacing }) => ({
  marginBottom: spacing.xs,
})

const $inputWrapperStyle: ThemedStyle<ViewStyle> = ({ colors }) => ({
  alignItems: "flex-start",
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  overflow: "hidden",
})

const $inputStyle: ThemedStyle<TextStyle> = ({ colors, typography, spacing }) => ({
  flex: 1,
  alignSelf: "stretch",
  fontFamily: typography.primary.normal,
  color: colors.text,
  fontSize: 16,
  height: 24,
  // https://github.com/facebook/react-native/issues/21720#issuecomment-532642093
  paddingVertical: 0,
  paddingHorizontal: 0,
  marginVertical: spacing.xs,
  marginHorizontal: spacing.sm,
})

const $helperStyle: ThemedStyle<TextStyle> = ({ spacing }) => ({
  marginTop: spacing.xs,
})

const $rightAccessoryStyle: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginEnd: spacing.xs,
  height: 40,
  justifyContent: "center",
  alignItems: "center",
})

const $revealStyle: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginEnd: spacing.xxs,
  width: 40,
  height: 40,
  justifyContent: "center",
  alignItems: "center",
})

const $leftAccessoryStyle: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginStart: spacing.xs,
  height: 40,
  justifyContent: "center",
  alignItems: "center",
})
