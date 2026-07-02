import type { SessionSummary } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { DevicesScreen } from "./DevicesScreen"
import { useAlertStore } from "@/stores/alert"
import en from "../i18n/en"
import { ThemeProvider } from "../theme/context"

let mockSessions: SessionSummary[] = []

jest.mock("../hooks/queries", () => ({
  useSessions: () => ({ data: mockSessions }),
  useRevokeSession: () => ({ mutate: jest.fn() }),
}))
// The real one scrolls with react-native-keyboard-controller, which has no
// native half here and nothing to do with what is under test.
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
// The screen is not inside a navigator here, and its header is chrome.
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "session-1",
    deviceName: null,
    platform: "ios",
    appVersion: null,
    osVersion: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-09-13T09:00:00.000Z",
    current: false,
    pushEnabled: false,
    ...overrides,
  }
}

async function renderScreen() {
  const view = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <DevicesScreen
          navigation={navigation as never}
          route={{ key: "devices", name: "Devices" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Row icons load their font asynchronously, and settling that here keeps the
  // update inside act.
  await act(async () => {})
  return view
}

describe("DevicesScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSessions = []
  })

  it("names an unnamed session after its platform, never the raw enum", async () => {
    mockSessions = [session({ id: "foreign", deviceName: null, platform: "other" })]

    const { getByText, queryByText } = await renderScreen()

    expect(getByText("settings:platformOther")).toBeTruthy()
    expect(en.settings.platformOther).toBe("Other device")
    expect(queryByText(/(^|\s)other(\s|$)/)).toBeNull()
  })

  it("puts the platform label, not the enum, in the sign-out confirmation", async () => {
    mockSessions = [session({ id: "foreign", deviceName: null, platform: "other" })]

    const { getByText } = await renderScreen()
    fireEvent.press(getByText("settings:platformOther"))

    expect(useAlertStore.getState().current).toMatchObject({
      title: "settings:signOutDevice",
      message: "settings:platformOther",
    })
  })

  it("marks the current session and says when each one signed in", async () => {
    mockSessions = [
      session({ id: "mine", deviceName: "Sarah's iPhone", platform: "ios", current: true }),
      session({ id: "tablet", deviceName: null, platform: "android" }),
    ]

    const { getByText, getAllByText } = await renderScreen()

    expect(getByText("settings:thisDevice")).toBeTruthy()
    expect(getByText("Sarah's iPhone")).toBeTruthy()
    // The platform leads the subtitle only under a device name. The unnamed
    // row is titled by it and would otherwise say it twice.
    expect(getByText(/^settings:platformIos/)).toBeTruthy()
    expect(getAllByText(/settings:platformAndroid/)).toHaveLength(1)
    expect(getAllByText(/settings:lastUsed/)).toHaveLength(2)
    expect(getAllByText(/settings:signedIn/)).toHaveLength(2)
  })
})
