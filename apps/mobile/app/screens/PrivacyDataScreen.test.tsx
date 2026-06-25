import type { LocationFixInput } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { PrivacyDataScreen } from "./PrivacyDataScreen"
import { useTrackingStore } from "../stores/tracking"
import { ThemeProvider } from "../theme/context"
import { storage } from "../utils/storage"

const mockDeleteAccount = jest.fn(async (_password: string) => ({ ok: true as const }))
const mockSignedOut = jest.fn()

jest.mock("../hooks/queries", () => ({
  useMyStats: () => ({ data: { locationPoints: 0, oldestPointAt: null }, refetch: jest.fn() }),
}))
jest.mock("../services/api", () => ({
  endpoints: {
    auth: {
      deleteAccount: (password: string) => mockDeleteAccount(password),
      exportData: jest.fn(),
    },
    locations: { eraseMine: jest.fn() },
  },
}))
jest.mock("../services/location/tracker", () => ({ stopTracking: jest.fn(async () => {}) }))
// The real one scrolls with react-native-keyboard-controller, which has no
// native half here and nothing to do with what is under test.
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../services/queryClient", () => ({ queryClient: { clear: jest.fn() } }))
// The screen is not inside a navigator here, and its header is chrome.
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
jest.mock("../stores/tokenVault", () => ({ tokenVault: { set: jest.fn(async () => {}) } }))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ signedOut: mockSignedOut }),
}))

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

function fixAt(recordedAt: string): LocationFixInput {
  return { recordedAt, lat: 51.5, lon: -0.12, accuracyMeters: 8 }
}

/** Every MMKV key the location queue writes, index and chunks alike. */
function queueKeys(): string[] {
  return storage.getAllKeys().filter((key) => key.startsWith("hearth.tracking.queue.v1"))
}

async function deleteAccount() {
  const { getAllByText, getByPlaceholderText } = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <PrivacyDataScreen
          navigation={navigation as never}
          route={{ key: "privacy", name: "PrivacyData" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Row icons load their font asynchronously, and settling that here keeps the
  // update inside act.
  await act(async () => {})
  // The section header carries the same string, and the confirm button only
  // exists once the row below it has been opened.
  const labels = () => getAllByText("settings:deleteAccount")
  fireEvent.press(labels()[1]!)
  fireEvent.changeText(getByPlaceholderText("login:password"), "hunter2")
  await act(async () => {
    fireEvent.press(labels().at(-1)!)
  })
}

describe("PrivacyDataScreen delete account", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    storage.clearAll()
    useTrackingStore.getState().reset()
  })

  it("leaves nothing of the deleted account's queue on the phone", async () => {
    useTrackingStore.getState().enqueue([fixAt("2026-09-08T10:00:00.000Z")])
    useTrackingStore.getState().enqueue([fixAt("2026-09-08T10:01:00.000Z")])
    expect(queueKeys().length).toBeGreaterThan(0)

    await deleteAccount()

    expect(mockDeleteAccount).toHaveBeenCalledWith("hunter2")
    expect(mockSignedOut).toHaveBeenCalled()
    expect(useTrackingStore.getState().queue).toEqual([])
    expect(useTrackingStore.getState().lastFix).toBeNull()
    expect(queueKeys()).toEqual([])
  })

  it("keeps the queue when the server refuses the deletion", async () => {
    mockDeleteAccount.mockRejectedValueOnce(new Error("Wrong password"))
    useTrackingStore.getState().enqueue([fixAt("2026-09-08T10:00:00.000Z")])

    await deleteAccount()

    expect(mockSignedOut).not.toHaveBeenCalled()
    expect(useTrackingStore.getState().queue).toHaveLength(1)
    expect(queueKeys().length).toBeGreaterThan(0)
  })
})
