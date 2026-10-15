import type { SessionSummary } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { DevicesScreen } from "./DevicesScreen"
import { useAlertStore } from "@/stores/alert"
import en from "../i18n/en"
import { ThemeProvider } from "../theme/context"

let mockSessions: SessionSummary[] | undefined = []
/** What TanStack Query reports beside the data. */
let mockStatus: { isPending: boolean; isError: boolean; error: Error | null } = {
  isPending: false,
  isError: false,
  error: null,
}
const mockRefetch = jest.fn()

jest.mock("../hooks/queries", () => ({
  useSessions: () => ({ data: mockSessions, ...mockStatus, refetch: mockRefetch }),
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
// Reanimated has no native half here. The placeholder is still found by its label.
jest.mock("../components/Skeleton", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Skeleton: ({
      accessibilityLabel,
      children,
    }: {
      accessibilityLabel: string
      children?: unknown
    }) => react.createElement(rn.View, { accessible: true, accessibilityLabel }, children),
    Bone: () => null,
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
    mockStatus = { isPending: false, isError: false, error: null }
  })

  // The list used to render nothing at all until it arrived, and nothing for
  // good when it did not, which read as "no devices" rather than "not yet".
  it("shows the list is on its way rather than an empty card", async () => {
    mockSessions = undefined
    mockStatus = { isPending: true, isError: false, error: null }

    const { getByLabelText } = await renderScreen()

    expect(getByLabelText("settings:devicesLoading")).toBeTruthy()
  })

  it("says the list could not load, and why, with a way to try again", async () => {
    mockSessions = undefined
    mockStatus = {
      isPending: false,
      isError: true,
      error: new Error("Request failed with status 429."),
    }

    const { getByText } = await renderScreen()

    expect(getByText("settings:devicesFailed")).toBeTruthy()
    expect(getByText("Request failed with status 429.")).toBeTruthy()
    fireEvent.press(getByText("common:retry"))
    expect(mockRefetch).toHaveBeenCalledTimes(1)
  })

  it("says so when the server lists no devices, rather than drawing an empty card", async () => {
    mockSessions = []

    const { getByText } = await renderScreen()

    expect(getByText("settings:devicesEmpty")).toBeTruthy()
  })

  it("keeps the devices on screen when a later refresh fails", async () => {
    mockSessions = [session({ id: "mine", deviceName: "Sarah's iPhone", current: true })]
    mockStatus = {
      isPending: false,
      isError: true,
      error: new Error("Could not reach the server."),
    }

    const { getByText, queryByText } = await renderScreen()

    expect(getByText("Sarah's iPhone")).toBeTruthy()
    expect(queryByText("settings:devicesFailed")).toBeNull()
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
