import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { ChangePasswordScreen } from "./ChangePasswordScreen"
import { ThemeProvider } from "../theme/context"

const mockChangePassword = jest.fn(
  async (_body: { currentPassword: string; newPassword: string }) => ({ ok: true as const }),
)

jest.mock("../services/api", () => ({
  endpoints: {
    auth: {
      changePassword: (body: { currentPassword: string; newPassword: string }) =>
        mockChangePassword(body),
    },
  },
}))
// The sheet needs reanimated and gesture-handler natives, and the form under
// test does not care what it is drawn inside.
jest.mock("../components/SheetScreen", () => {
  const react = require("react")
  const rn = require("react-native")
  const { TextField } = require("../components/TextField")
  return {
    SheetScreen: ({ children }: { children?: unknown }) =>
      react.createElement(rn.View, null, children),
    SheetTextField: TextField,
  }
})
jest.mock("../stores/toast", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

function mount() {
  return render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <ChangePasswordScreen
          navigation={navigation as never}
          route={{ key: "change-password", name: "ChangePassword" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
}

describe("ChangePasswordScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("shows the server's reason when the change is refused", async () => {
    mockChangePassword.mockRejectedValueOnce(new Error("Current password is incorrect"))
    const { getAllByDisplayValue, getByText, queryByText } = mount()

    const [current, next] = getAllByDisplayValue("")
    fireEvent.changeText(current!, "old-password")
    fireEvent.changeText(next!, "a longer new password")
    await act(async () => {
      fireEvent.press(getByText("common:save"))
    })

    expect(mockChangePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "a longer new password",
    })
    expect(getByText("Current password is incorrect")).toBeDefined()
    expect(queryByText("register:passwordHint")).toBeNull()
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it("shows the password hint while there is nothing to report", () => {
    const { getByText, getAllByDisplayValue } = mount()

    expect(getByText("register:passwordHint")).toBeDefined()
    expect(getAllByDisplayValue("")).toHaveLength(2)
  })
})
