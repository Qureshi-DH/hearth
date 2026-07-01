import { act, render } from "@testing-library/react-native"

import { AppProviders } from "./AppProviders"
import { PromptDialog } from "./components/PromptDialog"
import { translate } from "./i18n/translate"

// A BottomSheetModal renders its content wherever the provider's host sits in
// the tree, so the modal, the provider and the portal stay real here. Only
// the inner sheet is faked, the same way PromptDialog.test.tsx does it.
jest.mock("@gorhom/bottom-sheet", () => {
  const react = require("react")
  const rn = require("react-native")
  const lib = "@gorhom/bottom-sheet/lib/commonjs/components"
  return {
    __esModule: true,
    BottomSheetModal: jest.requireActual(`${lib}/bottomSheetModal/BottomSheetModal`).default,
    BottomSheetModalProvider: jest.requireActual(
      `${lib}/bottomSheetModalProvider/BottomSheetModalProvider`,
    ).default,
    BottomSheetView: ({ children }: { children?: unknown }) =>
      react.createElement(rn.View, null, children),
    BottomSheetBackdrop: () => null,
    BottomSheetTextInput: react.forwardRef(function BottomSheetTextInput(props: any, ref: any) {
      return react.createElement(rn.TextInput, { ...props, ref })
    }),
  }
})
jest.mock("@gorhom/bottom-sheet/lib/commonjs/components/bottomSheet", () => {
  const react = require("react")
  const rn = require("react-native")
  const FakeSheet = react.forwardRef(function FakeSheet(props: any, ref: any) {
    const land = (from: number, to: number) => {
      props.onAnimate?.(from, to, 0, 0)
      props.onChange?.(to, 0, 0)
      if (to === -1) props.onClose?.()
    }
    react.useImperativeHandle(ref, () => ({
      snapToIndex: (index: number) => land(-1, index),
      close: () => land(0, -1),
      forceClose: () => land(0, -1),
    }))
    react.useEffect(() => {
      land(-1, 0)
    }, [])
    return react.createElement(rn.View, null, props.children)
  })
  return { __esModule: true, default: FakeSheet }
})
jest.mock("@gorhom/bottom-sheet/lib/commonjs/hooks", () => ({
  useBottomSheetModalInternal: jest.requireActual(
    "@gorhom/bottom-sheet/lib/commonjs/hooks/useBottomSheetModalInternal",
  ).useBottomSheetModalInternal,
}))
jest.mock("@gorhom/bottom-sheet/lib/commonjs/utilities", () => ({ print: () => {} }))
jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const easing = (value: unknown) => value
  return {
    __esModule: true,
    Easing: { out: easing, exp: easing },
    useSharedValue: (initial: unknown) => react.useRef({ value: initial }).current,
  }
})
jest.mock("react-native-gesture-handler", () => {
  const rn = require("react-native")
  return { GestureHandlerRootView: rn.View }
})
jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: unknown }) => children,
}))
// Without native metrics the safe area provider renders nothing at all.
jest.mock("react-native-safe-area-context", () => ({
  ...jest.requireActual("react-native-safe-area-context"),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  },
}))

describe("AppProviders", () => {
  it("gives a modal sheet the theme, even though it renders at the provider's host", async () => {
    const screen = render(
      <AppProviders>
        <PromptDialog visible titleTx="settings:name" onCancel={jest.fn()} onSubmit={jest.fn()} />
      </AppProviders>,
    )
    // present() does its work on the next animation frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(translate("settings:name"))).toBeTruthy()
  })
})
