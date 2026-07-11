import { act, fireEvent, render } from "@testing-library/react-native"

import { AlertHost } from "./AlertHost"
import { alert, useAlertStore } from "../stores/alert"
import { ThemeProvider } from "../theme/context"

// The overlay needs a native window. A plain view stands in, and a marker
// prop lets a test tell the two hosts apart.
jest.mock("react-native-screens", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    FullWindowOverlay: ({ children }: { children: unknown }) =>
      react.createElement(rn.View, { testID: "full-window-overlay" }, children),
  }
})

// Layout animations need the native side. The mock renders plain views and
// drops the entering and exiting props on the floor.
jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  const chain = { duration: () => chain }
  const View = ({ entering: _e, exiting: _x, ...props }: Record<string, unknown>) =>
    react.createElement(rn.View, props)
  return {
    __esModule: true,
    default: { View },
    Easing: { out: (v: unknown) => v, quad: (v: unknown) => v },
    FadeIn: chain,
    FadeOut: chain,
    Keyframe: class {
      duration() {
        return this
      }
    },
  }
})

/** The host keeps a closed alert on screen for its fade, so a test settles that first. */
function settle() {
  act(() => {
    jest.advanceTimersByTime(200)
  })
}

function mount() {
  return render(
    <ThemeProvider>
      <AlertHost />
    </ThemeProvider>,
  )
}

describe("AlertHost", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useAlertStore.setState({ current: null, queue: [] })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("draws nothing until something is asked", () => {
    const { toJSON } = mount()
    expect(toJSON()).toBeNull()
  })

  it("shows the title, the message and every button", () => {
    const screen = mount()
    act(() => {
      alert("Sign out", "You will need your password.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive" },
      ])
    })
    // The title and the destructive button share the text, as they do at the
    // call sites, so both must be there.
    expect(screen.getAllByText("Sign out")).toHaveLength(2)
    expect(screen.getByText("You will need your password.")).toBeTruthy()
    expect(screen.getByText("Cancel")).toBeTruthy()
  })

  it("runs the pressed button and closes", () => {
    const onPress = jest.fn()
    const screen = mount()
    act(() => {
      alert("Delete place?", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress },
      ])
    })
    fireEvent.press(screen.getByText("Delete"))
    expect(onPress).toHaveBeenCalledTimes(1)
    settle()
    expect(screen.queryByText("Delete place?")).toBeNull()
  })

  it("treats the Android back button as the cancel button", () => {
    const { Platform, Modal } = require("react-native")
    const os = Platform.OS
    Platform.OS = "android"
    try {
      const onCancel = jest.fn()
      const onConfirm = jest.fn()
      const screen = mount()
      act(() => {
        alert("Leave circle?", undefined, [
          { text: "Stay", style: "cancel", onPress: onCancel },
          { text: "Leave", style: "destructive", onPress: onConfirm },
        ])
      })
      act(() => {
        screen.UNSAFE_getByType(Modal).props.onRequestClose()
      })
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onConfirm).not.toHaveBeenCalled()
      settle()
      expect(screen.queryByText("Leave circle?")).toBeNull()
    } finally {
      Platform.OS = os
    }
  })

  it("offers OK when the caller gave no buttons", () => {
    const screen = mount()
    act(() => {
      alert("Saved")
    })
    fireEvent.press(screen.getByText("common:ok"))
    settle()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("uses a window overlay on iOS, where a Modal cannot show over a modal screen", () => {
    const { Platform, Modal } = require("react-native")
    const os = Platform.OS
    Platform.OS = "ios"
    try {
      const screen = mount()
      act(() => {
        alert("Mark this SOS as resolved?")
      })
      expect(screen.getByTestId("full-window-overlay")).toBeTruthy()
      expect(screen.UNSAFE_queryByType(Modal)).toBeNull()
      expect(screen.getByText("Mark this SOS as resolved?")).toBeTruthy()
    } finally {
      Platform.OS = os
    }
  })

  it("ignores a second tap that asks the same question", () => {
    const screen = mount()
    act(() => {
      alert("Sign out", "Sure?")
      alert("Sign out", "Sure?")
      alert("Sign out", "Sure?")
    })
    fireEvent.press(screen.getByText("common:ok"))
    settle()
    expect(screen.queryByText("Sure?")).toBeNull()
  })

  it("lingers for its fade, and ignores a tap during it", () => {
    const onPress = jest.fn()
    const screen = mount()
    act(() => {
      alert("Erase history?", undefined, [{ text: "Erase", onPress }])
    })
    fireEvent.press(screen.getByText("Erase"))
    expect(onPress).toHaveBeenCalledTimes(1)
    // Still mounted while the exit plays, but no longer answering.
    expect(screen.getByTestId("full-window-overlay")).toBeTruthy()
    expect(screen.queryByText("Erase")).toBeNull()
    settle()
    expect(screen.queryByTestId("full-window-overlay")).toBeNull()
  })

  it("shows alerts one after another rather than dropping the second", () => {
    const screen = mount()
    act(() => {
      alert("First")
      alert("Second")
    })
    expect(screen.getByText("First")).toBeTruthy()
    expect(screen.queryByText("Second")).toBeNull()
    fireEvent.press(screen.getByText("common:ok"))
    expect(screen.getByText("Second")).toBeTruthy()
  })
})
