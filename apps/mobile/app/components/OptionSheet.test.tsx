import { BottomSheetModalProvider } from "@gorhom/bottom-sheet"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { OptionSheet } from "./OptionSheet"
import { ThemeProvider } from "../theme/context"

type InnerSheetProps = {
  onAnimate?: (from: number, to: number, fromPosition: number, toPosition: number) => void
  onChange?: (index: number, position: number, type: number) => void
  onClose?: () => void
}

/** Props of the inner sheet the modal rendered last, so a test can swipe it away. */
const mockInner: { props: InnerSheetProps | null } = { props: null }

// The bug lives in BottomSheetModal's status machine and the portal gate in
// front of it, so both of those and the provider stay real. Only the inner
// BottomSheet is faked: it needs reanimated and gesture-handler natives, and
// all the modal wants from it is the callbacks it fires after each animation.
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
    // Present so SheetTextField renders the input it ships with, not
    // TextField's fallback for an undefined one.
    BottomSheetTextInput: react.forwardRef(function BottomSheetTextInput(props: any, ref: any) {
      return react.createElement(rn.TextInput, { ...props, ref })
    }),
  }
})
jest.mock("@gorhom/bottom-sheet/lib/commonjs/components/bottomSheet", () => {
  const react = require("react")
  const rn = require("react-native")
  const FakeSheet = react.forwardRef(function FakeSheet(props: any, ref: any) {
    mockInner.props = props
    // The real sheet reports every landing through these three callbacks,
    // in this order, and the modal's status machine is driven by nothing else.
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
// The barrels drag in every hook and utility of the library. The modal path
// only reads these two.
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

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
}

function sheet(visible: boolean, onClose: jest.Mock, onChoose: jest.Mock) {
  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={metrics}>
        <BottomSheetModalProvider>
          <OptionSheet
            visible={visible}
            titleTx="settings:photo"
            onClose={onClose}
            options={[
              { key: "choose", tx: "settings:choosePhoto", onPress: onChoose },
              { key: "remove", tx: "settings:removePhoto", destructive: true, onPress: jest.fn() },
            ]}
          />
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </ThemeProvider>
  )
}

// present() does its work on the next animation frame, which the RN jest
// setup runs as a zero delay timeout.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(visible: boolean) {
  const onClose = jest.fn()
  const onChoose = jest.fn()
  const utils = render(sheet(visible, onClose, onChoose))
  await settle()
  const setVisible = async (next: boolean) => {
    utils.rerender(sheet(next, onClose, onChoose))
    await settle()
  }
  return { ...utils, onClose, onChoose, setVisible }
}

describe("OptionSheet", () => {
  it("opens when a screen that mounted it hidden turns it on", async () => {
    const { queryByText, setVisible } = await mount(false)
    expect(queryByText("settings:photo")).toBeNull()
    await setVisible(true)
    expect(queryByText("settings:photo")).toBeTruthy()
    expect(queryByText("settings:removePhoto")).toBeTruthy()
  })

  it("runs the chosen option and asks the screen to close", async () => {
    const { getByText, onChoose, onClose } = await mount(true)
    fireEvent.press(getByText("settings:choosePhoto"))
    expect(onClose).toHaveBeenCalled()
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it("opens again after the screen closed it", async () => {
    const { queryByText, setVisible } = await mount(true)
    await setVisible(false)
    await settle()
    await setVisible(true)
    expect(queryByText("settings:photo")).toBeTruthy()
  })

  it("closes on the Android back button instead of leaving it to the screen below", async () => {
    const { BackHandler } = require("react-native")
    const spy = jest.spyOn(BackHandler, "addEventListener")
    const { onClose } = await mount(true)
    const handler = spy.mock.calls.find(([event]) => event === "hardwareBackPress")?.[1] as
      (() => boolean) | undefined
    expect(handler).toBeDefined()
    expect(handler?.()).toBe(true)
    expect(onClose).toHaveBeenCalled()
    spy.mockRestore()
  })
})
