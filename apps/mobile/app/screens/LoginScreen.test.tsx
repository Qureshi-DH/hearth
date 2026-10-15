import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { LoginScreen } from "./LoginScreen"
import { ThemeProvider } from "../theme/context"

const mockLogin = jest.fn(async (_body: { email: string; password: string }) => ({
  accessToken: "access",
  refreshToken: "refresh",
  user: { id: "ana" },
}))

jest.mock("../services/api", () => ({
  ApiError: class ApiError extends Error {},
  endpoints: { auth: { login: (body: { email: string; password: string }) => mockLogin(body) } },
}))
jest.mock("../stores/tokenVault", () => ({ tokenVault: { set: jest.fn(async () => {}) } }))
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

async function renderLogin() {
  const view = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <LoginScreen
          navigation={navigation as never}
          route={{ key: "login", name: "Login" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return view
}

describe("LoginScreen", () => {
  beforeEach(() => jest.clearAllMocks())

  it("lets the password be read back before signing in with it", async () => {
    const { getByLabelText, getByRole, getByText } = await renderLogin()

    fireEvent.changeText(getByLabelText(/^login:email/), "ana@example.com")
    fireEvent.changeText(getByLabelText(/^login:password/), "correct horse")
    expect(getByLabelText(/^login:password/).props.secureTextEntry).toBe(true)

    fireEvent.press(getByRole("togglebutton", { name: /^common:showPassword/ }))
    expect(getByLabelText(/^login:password/).props.secureTextEntry).toBe(false)

    await act(async () => {
      fireEvent.press(getByText(/^login:signIn/))
    })
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ana@example.com", password: "correct horse" }),
    )
  })
})
