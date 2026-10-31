import { createRef, forwardRef, useImperativeHandle } from "react"
import { Platform, type TextInputInstance, type TextInputProps } from "react-native"
import { fireEvent, render } from "@testing-library/react-native"

import { TextField } from "./TextField"
import { ThemeProvider } from "../theme/context"

const mockFocus = jest.fn()
const seen: TextInputProps[] = []

/**
 * Stands in for BottomSheetTextInput: a forwardRef component that hands the
 * parent something with focus() on it, the way the real one hands back the
 * underlying native input.
 */
const SpyInput = forwardRef<TextInputInstance, TextInputProps>(function SpyInput(props, ref) {
  seen.push(props)
  useImperativeHandle(ref, () => ({ focus: mockFocus }) as unknown as TextInputInstance)
  return null
})

describe("TextField InputComponent", () => {
  beforeEach(() => {
    seen.length = 0
    mockFocus.mockClear()
  })

  it("renders the given input in place of the default one", () => {
    const onChangeText = jest.fn()
    render(
      <ThemeProvider>
        <TextField InputComponent={SpyInput} value="hunter2" onChangeText={onChangeText} />
      </ThemeProvider>,
    )

    const props = seen.at(-1)!
    expect(props.value).toBe("hunter2")
    props.onChangeText?.("hunter22")
    expect(onChangeText).toHaveBeenCalledWith("hunter22")
  })

  it("forwards the ref to the given input", () => {
    const ref = createRef<TextInputInstance>()
    const { getByText } = render(
      <ThemeProvider>
        <TextField
          ref={ref}
          InputComponent={SpyInput}
          label="Spy"
          value=""
          onChangeText={jest.fn()}
        />
      </ThemeProvider>,
    )

    ref.current?.focus()
    expect(mockFocus).toHaveBeenCalledTimes(1)

    // Tapping anywhere on the field, its label included, focuses the same input.
    // VoiceOver reads the label from the input, so the label itself is hidden.
    fireEvent.press(getByText("Spy", { includeHiddenElements: true }))
    expect(mockFocus).toHaveBeenCalledTimes(2)
  })
})

describe("TextField password", () => {
  function renderPassword() {
    return render(
      <ThemeProvider>
        <TextField label="Password" value="hunter2" onChangeText={jest.fn()} secureTextEntry />
      </ThemeProvider>,
    )
  }

  it("hides what is typed until asked to show it, and hides it again", () => {
    const { getByDisplayValue, getByRole } = renderPassword()
    expect(getByDisplayValue("hunter2").props.secureTextEntry).toBe(true)

    const toggle = getByRole("togglebutton", { name: /^common:showPassword/ })
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false })

    fireEvent.press(toggle)
    expect(getByDisplayValue("hunter2").props.secureTextEntry).toBe(false)
    expect(getByRole("togglebutton").props.accessibilityState).toMatchObject({ checked: true })

    fireEvent.press(getByRole("togglebutton"))
    expect(getByDisplayValue("hunter2").props.secureTextEntry).toBe(true)
  })

  // A shown password is typed in the open, where the keyboard's defaults
  // capitalise the first letter and correct the rest, and the server then
  // refuses what the person meant to type.
  it("types a shown password exactly as keyed", () => {
    const { getByDisplayValue, getByRole } = renderPassword()
    fireEvent.press(getByRole("togglebutton"))

    expect(getByDisplayValue("hunter2").props).toMatchObject({
      autoCapitalize: "none",
      autoCorrect: false,
      spellCheck: false,
    })
  })

  describe("on Android", () => {
    const os = Platform.OS
    beforeEach(() => {
      Platform.OS = "android"
    })
    afterEach(() => {
      Platform.OS = os
    })

    it("keeps a shown password out of the keyboard's suggestions", () => {
      const { getByDisplayValue, getByRole } = renderPassword()
      fireEvent.press(getByRole("togglebutton"))

      expect(getByDisplayValue("hunter2").props.keyboardType).toBe("visible-password")
    })

    // TalkBack reads an edit box's description in place of its text, so a
    // label there would read "Email" back to somebody checking what they typed.
    it("leaves the input unlabelled, so what is typed is what is read", () => {
      const { getByDisplayValue } = renderPassword()

      expect(getByDisplayValue("hunter2").props.accessibilityLabel).toBeUndefined()
    })
  })

  describe("on iOS", () => {
    const os = Platform.OS
    beforeEach(() => {
      Platform.OS = "ios"
    })
    afterEach(() => {
      Platform.OS = os
    })

    it("names the input after its label, and reads the label once", () => {
      // The toggle has to be reachable on its own, which an accessible wrapper
      // would stop on iOS by folding everything inside it into one element.
      const { getByLabelText, getByText } = renderPassword()

      expect(getByLabelText("Password").props.value).toBe("hunter2")
      expect(
        getByText("Password", { includeHiddenElements: true }).props.accessibilityElementsHidden,
      ).toBe(true)
    })
  })

  it("offers no toggle on a field that is not secret", () => {
    const { queryByRole } = render(
      <ThemeProvider>
        <TextField label="Email" value="" onChangeText={jest.fn()} />
      </ThemeProvider>,
    )

    expect(queryByRole("togglebutton")).toBeNull()
  })
})
