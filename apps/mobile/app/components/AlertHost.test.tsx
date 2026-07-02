import { act, fireEvent, render } from "@testing-library/react-native"

import { AlertHost } from "./AlertHost"
import { alert, useAlertStore } from "../stores/alert"
import { ThemeProvider } from "../theme/context"

function mount() {
  return render(
    <ThemeProvider>
      <AlertHost />
    </ThemeProvider>,
  )
}

describe("AlertHost", () => {
  beforeEach(() => {
    useAlertStore.setState({ current: null, queue: [] })
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
    expect(screen.queryByText("Delete place?")).toBeNull()
  })

  it("treats the back button as the cancel button", () => {
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
      screen.UNSAFE_getByType(require("react-native").Modal).props.onRequestClose()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByText("Leave circle?")).toBeNull()
  })

  it("offers OK when the caller gave no buttons", () => {
    const screen = mount()
    act(() => {
      alert("Saved")
    })
    fireEvent.press(screen.getByText("common:ok"))
    expect(screen.queryByText("Saved")).toBeNull()
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
