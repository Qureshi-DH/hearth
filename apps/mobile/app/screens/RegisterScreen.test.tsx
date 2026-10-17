import type { RegisterResponse } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { RegisterScreen } from "./RegisterScreen"
import { useAlertStore } from "../stores/alert"
import { useAuthStore } from "../stores/auth"
import { ThemeProvider } from "../theme/context"

let mockResponse: Partial<RegisterResponse>
const mockRegister = jest.fn(async (_body: Record<string, unknown>) => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresIn: 900,
  user: { id: "ana", displayName: "Ana" },
  ...mockResponse,
}))

jest.mock("../services/api", () => ({
  ApiError: class ApiError extends Error {},
  endpoints: { auth: { register: (body: Record<string, unknown>) => mockRegister(body) } },
}))
jest.mock("../stores/tokenVault", () => ({ tokenVault: { set: jest.fn(async () => {}) } }))
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

async function signUp() {
  const view = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <RegisterScreen
          navigation={navigation as never}
          route={{ key: "register", name: "Register" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  fireEvent.changeText(view.getByLabelText(/^register:name/), "Ana")
  fireEvent.changeText(view.getByLabelText(/^register:email/), "ana@example.com")
  fireEvent.changeText(view.getByLabelText(/^register:password/), "correct horse battery")
  await act(async () => {
    fireEvent.press(view.getByText(/^register:create/))
  })
  return view
}

describe("RegisterScreen invite", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResponse = {}
    useAlertStore.setState({ current: null, queue: [] })
    useAuthStore.setState({
      status: "signed_out",
      serverUrl: "https://hearth.example.com",
      user: null,
    })
    useAuthStore.getState().setPendingInvite("AB12CD34", "https://hearth.example.com")
  })

  it("sends the code the link carried", async () => {
    await signUp()
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ inviteCode: "AB12CD34" }))
    expect(useAuthStore.getState().status).toBe("signed_in")
    expect(useAuthStore.getState().pendingInviteCode).toBeNull()
  })

  // Signed in to an empty map with no word why, the invite looks lost.
  it("says the invite did not work, and why, once the account is made", async () => {
    mockResponse = {
      invite: { joined: false, reason: "expired", message: "That invite has expired." },
    }
    await signUp()
    const shown = useAlertStore.getState().current
    expect(shown?.title).toBe("register:inviteFailed")
    expect(shown?.message).toContain("join:expired")
    expect(useAuthStore.getState().status).toBe("signed_in")
  })

  it("falls back to the server's words for a reason the app does not know", async () => {
    mockResponse = {
      invite: { joined: false, reason: "failed", message: "Joining the circle failed." },
    }
    await signUp()
    expect(useAlertStore.getState().current?.message).toContain("Joining the circle failed.")
  })

  it("says nothing when the invite worked", async () => {
    mockResponse = { invite: { joined: true, circleId: "c1", circleName: "Family" } }
    await signUp()
    expect(useAlertStore.getState().current).toBeNull()
  })

  // An older server leaves the field out, and the app cannot tell.
  it("says nothing when the server does not say", async () => {
    await signUp()
    expect(useAlertStore.getState().current).toBeNull()
  })
})
