import { BottomSheetModalProvider } from "@gorhom/bottom-sheet"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { PromptDialog } from "./PromptDialog"
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

type Handlers = { onCancel: jest.Mock; onSubmit: jest.Mock }

function dialog(visible: boolean, handlers: Handlers, initialValue = "Ana") {
  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={metrics}>
        <BottomSheetModalProvider>
          <PromptDialog
            visible={visible}
            titleTx="settings:name"
            initialValue={initialValue}
            {...handlers}
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

/** Mounts the dialog the way a screen does and hands back the screen's controls. */
async function mount(visible: boolean) {
  const handlers: Handlers = { onCancel: jest.fn(), onSubmit: jest.fn() }
  const utils = render(dialog(visible, handlers))
  await settle()
  const setVisible = async (next: boolean) => {
    utils.rerender(dialog(next, handlers))
    await settle()
  }
  const setInitialValue = async (next: string) => {
    utils.rerender(dialog(true, handlers, next))
    await settle()
  }
  return { ...utils, ...handlers, setVisible, setInitialValue }
}

/** What the inner sheet reports after the user drags it off the bottom of the screen. */
async function swipeAway() {
  await act(async () => {
    mockInner.props?.onAnimate?.(0, -1, 0, 0)
    mockInner.props?.onChange?.(-1, 0, 0)
    mockInner.props?.onClose?.()
  })
}

describe("PromptDialog", () => {
  it("closes on the Android back button instead of leaving it to the screen below", async () => {
    const { BackHandler } = require("react-native")
    const spy = jest.spyOn(BackHandler, "addEventListener")
    const { onCancel } = await mount(true)
    const handler = spy.mock.calls.find(([event]) => event === "hardwareBackPress")?.[1] as
      (() => boolean) | undefined
    expect(handler).toBeDefined()
    expect(handler?.()).toBe(true)
    expect(onCancel).toHaveBeenCalled()
    spy.mockRestore()
  })

  beforeEach(() => {
    mockInner.props = null
  })

  it("opens when a screen that mounted it hidden turns it on", async () => {
    const { queryByText, queryByDisplayValue, setVisible } = await mount(false)
    expect(queryByText("settings:name")).toBeNull()

    await setVisible(true)

    expect(queryByText("settings:name")).not.toBeNull()
    expect(queryByDisplayValue("Ana")).not.toBeNull()
  })

  it("opens on first mount when it starts visible", async () => {
    const { queryByText } = await mount(true)

    expect(queryByText("settings:name")).not.toBeNull()
  })

  it("submits the trimmed value and asks the screen to close it", async () => {
    const { getByDisplayValue, getByText, onSubmit, onCancel } = await mount(true)

    fireEvent.changeText(getByDisplayValue("Ana"), "  Ana Banana ")
    fireEvent.press(getByText("common:save"))

    expect(onSubmit).toHaveBeenCalledWith("Ana Banana")
    expect(onCancel).toHaveBeenCalled()
  })

  it("keeps what was typed when a refetch changes the initial value", async () => {
    const { getByDisplayValue, queryByDisplayValue, queryByText, setInitialValue } =
      await mount(true)

    fireEvent.changeText(getByDisplayValue("Ana"), "Ana Banana")
    // The screen's query refetching behind the open sheet hands down a new
    // initialValue. Only the visible edge may reset the field or present again.
    await setInitialValue("Ana B.")

    expect(queryByDisplayValue("Ana Banana")).not.toBeNull()
    expect(queryByText("settings:name")).not.toBeNull()
  })

  it("opens again after the screen closed it on save", async () => {
    const { queryByText, setVisible } = await mount(true)

    await setVisible(false)
    expect(queryByText("settings:name")).toBeNull()
    await setVisible(true)

    expect(queryByText("settings:name")).not.toBeNull()
  })

  it("opens again after the user swiped it away", async () => {
    const { queryByText, onCancel, setVisible } = await mount(true)

    await swipeAway()
    expect(onCancel).toHaveBeenCalled()
    expect(queryByText("settings:name")).toBeNull()
    // The screen answers onCancel by hiding the dialog, which used to poison
    // the modal for the next tap.
    await setVisible(false)
    await setVisible(true)

    expect(queryByText("settings:name")).not.toBeNull()
  })
})
