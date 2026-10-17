import { fireEvent, render } from "@testing-library/react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"

import { Header } from "./Header"
import { ThemeProvider } from "../theme/context"

// The test setup swaps Image for a plain object, which cannot render.
jest.mock("./Icon", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    PressableIcon: ({
      icon: _i,
      color: _c,
      size: _s,
      containerStyle: _cs,
      ...props
    }: Record<string, unknown>) => react.createElement(rn.TouchableOpacity, props),
  }
})

function mount(element: React.ReactElement) {
  return render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        {element}
      </SafeAreaProvider>
    </ThemeProvider>,
  )
}

describe("Header", () => {
  it("names its back arrow for a screen reader", () => {
    const onBack = jest.fn()
    const { getByRole } = mount(
      <Header titleTx="trips:title" leftIcon="back" onLeftPress={onBack} />,
    )
    fireEvent.press(getByRole("button", { name: "common:back" }))
    expect(onBack).toHaveBeenCalled()
  })

  it("names a close cross as closing", () => {
    const { getByRole } = mount(<Header leftIcon="x" onLeftPress={jest.fn()} />)
    expect(getByRole("button", { name: "common:close" })).toBeTruthy()
  })

  it("marks a text action as a button", () => {
    const { getByRole } = mount(<Header rightTx="common:save" onRightPress={jest.fn()} />)
    expect(getByRole("button", { name: "common:save" })).toBeTruthy()
  })
})
