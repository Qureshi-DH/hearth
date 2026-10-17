import type { AdminUserSummary } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { AdminScreen } from "./AdminScreen"
import { ThemeProvider } from "../theme/context"

const person = (id: string, displayName: string): AdminUserSummary =>
  ({
    id,
    displayName,
    email: `${id}@example.com`,
    isAdmin: true,
    isActive: true,
    circleCount: 1,
    lastSeenAt: new Date().toISOString(),
    longestSilenceSeconds: null,
  }) as unknown as AdminUserSummary

jest.mock("../hooks/queries", () => ({
  useAdminStats: () => ({ data: undefined, refetch: jest.fn() }),
  useAdminSettings: () => ({ data: undefined }),
  useAdminUsers: () => ({ data: [person("ana", "Ana"), person("omar", "Omar")] }),
  useUpdateAdminSettings: () => ({ mutate: jest.fn() }),
  useUpdateAdminUser: () => ({ mutate: jest.fn() }),
}))
jest.mock("../services/api", () => ({ endpoints: { admin: { drainPush: jest.fn() } } }))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "ana", isAdmin: true } }),
}))
jest.mock("../stores/settings", () => {
  const state = { hapticsEnabled: false }
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state)
  // A press reads the haptics setting outside React.
  useSettingsStore.getState = () => state
  return { useSettingsStore }
})
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../components/PromptDialog", () => ({ PromptDialog: () => null }))
// Sheets sit on reanimated, which has no native side here. The options are
// drawn as plain text so a test can see which are offered.
jest.mock("../components/OptionSheet", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    OptionSheet: ({
      visible,
      options,
    }: {
      visible: boolean
      options: Array<{ key: string; label?: string }>
    }) =>
      visible
        ? react.createElement(
            rn.View,
            null,
            options.map((option) =>
              react.createElement(rn.Text, { key: option.key }, option.label ?? option.key),
            ),
          )
        : null,
  }
})
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

async function renderAdmin() {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <AdminScreen navigation={{ goBack: jest.fn() } as never} route={{} as never} />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return utils
}

describe("managing an account", () => {
  // The server refuses both for your own account with a 400.
  it("offers nothing to do to your own account", async () => {
    const screen = await renderAdmin()
    fireEvent.press(screen.getByText("Ana"))
    expect(screen.queryByText(/admin:deactivate/)).toBeNull()
    expect(screen.queryByText(/admin:removeAdmin/)).toBeNull()
  })

  it("offers deactivating and removing admin for somebody else", async () => {
    const screen = await renderAdmin()
    fireEvent.press(screen.getByText("Omar"))
    expect(screen.getByText(/admin:deactivate/)).toBeTruthy()
    expect(screen.getByText(/admin:removeAdmin/)).toBeTruthy()
  })
})
