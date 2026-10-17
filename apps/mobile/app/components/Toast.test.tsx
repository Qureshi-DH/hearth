import { AccessibilityInfo } from "react-native"
import { act, render } from "@testing-library/react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"

import { ToastHost } from "./Toast"
import { toast, useToastStore } from "../stores/toast"
import { ThemeProvider } from "../theme/context"

jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  const chain = { duration: () => chain }
  const View = ({ entering: _e, exiting: _x, ...props }: Record<string, unknown>) =>
    react.createElement(rn.View, props)
  return { __esModule: true, default: { View }, FadeInUp: chain, FadeOutUp: chain }
})

describe("ToastHost", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useToastStore.setState({ current: null })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("reads each toast out to a screen reader, since it is gone before it can be found", () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility")
    const { getByText } = render(
      <ThemeProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <ToastHost />
        </SafeAreaProvider>
      </ThemeProvider>,
    )
    act(() => toast.error("Couldn't save the place"))
    expect(getByText("Couldn't save the place")).toBeTruthy()
    expect(announce).toHaveBeenCalledWith("Couldn't save the place")
  })
})
