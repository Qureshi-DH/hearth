import { createRef, forwardRef, useImperativeHandle } from "react"
// eslint-disable-next-line no-restricted-imports
import type { TextInput, TextInputProps } from "react-native"
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
const SpyInput = forwardRef<TextInput, TextInputProps>(function SpyInput(props, ref) {
  seen.push(props)
  useImperativeHandle(ref, () => ({ focus: mockFocus }) as unknown as TextInput)
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
    const ref = createRef<TextInput>()
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
    fireEvent.press(getByText("Spy"))
    expect(mockFocus).toHaveBeenCalledTimes(2)
  })
})
