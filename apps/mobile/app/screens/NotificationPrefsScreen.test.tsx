import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { NotificationPrefsScreen } from "./NotificationPrefsScreen"
import { ThemeProvider } from "../theme/context"
import { storage } from "../utils/storage"

const mockPushTest = jest.fn(async () => ({ ok: true, queued: true }))

jest.mock("../hooks/queries", () => ({
  useMembers: () => ({ data: [] }),
  useSetNotifications: () => ({ mutate: jest.fn() }),
}))
jest.mock("../services/api", () => ({
  endpoints: { push: { test: () => mockPushTest() } },
}))
jest.mock("../services/permissions", () => ({ openAppSettings: jest.fn() }))
jest.mock("../stores/push", () => ({
  usePushStore: (selector: (state: unknown) => unknown) =>
    selector({ setup: { kind: "registered" } }),
}))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "ana" }, serverInfo: { pushProvider: "expo" } }),
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
jest.mock("../components/OptionSheet", () => ({ OptionSheet: () => null }))
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

const navigation = { goBack: jest.fn(), navigate: jest.fn() }

beforeEach(() => {
  jest.clearAllMocks()
  storage.clearAll()
})

describe("sending a test notification", () => {
  // The server takes five in five minutes from one account and answers the
  // sixth with a 429, which a firewall in front of it can answer by locking
  // the house out.
  it("asks the person to wait rather than send a fourth inside five minutes", async () => {
    const { getByText } = render(
      <ThemeProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <NotificationPrefsScreen
            navigation={navigation as never}
            route={{ key: "prefs", name: "NotificationPrefs", params: { circleId: "c1" } } as never}
          />
        </SafeAreaProvider>
      </ThemeProvider>,
    )
    await act(async () => {})
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        fireEvent.press(getByText("notifications:test"))
      })
    }
    const { useToastStore } = require("../stores/toast") as typeof import("../stores/toast")
    expect(mockPushTest).toHaveBeenCalledTimes(3)
    expect(useToastStore.getState().current?.message).toContain("notifications:testWait")
  })
})
