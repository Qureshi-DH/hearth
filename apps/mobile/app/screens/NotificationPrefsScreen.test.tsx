import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { NotificationPrefsScreen } from "./NotificationPrefsScreen"
import { ThemeProvider } from "../theme/context"
import { storage } from "../utils/storage"

const mockPushTest = jest.fn(async () => ({ ok: true, queued: true }))
const mockSetNotifications = jest.fn()
const mockUpdateSettings = jest.fn()
let mockMembers: unknown[] = []
let mockPlaces: unknown[] = []
let mockState: Record<string, unknown> = {}

jest.mock("../hooks/queries", () => ({
  useMembers: () => ({ data: mockMembers }),
  usePlaces: () => ({ data: mockPlaces }),
  useSetNotifications: () => ({ mutate: mockSetNotifications }),
  useUpdateNotificationSettings: () => ({ mutate: mockUpdateSettings }),
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
  useAuthStore: (selector: (state: unknown) => unknown) => selector(mockState),
}))
jest.mock("../services/phoneClock", () => ({
  phoneClock: () => ({ timeZone: "Asia/Karachi", clock: "12h" }),
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
jest.mock("../components/OptionSheet", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    OptionSheet: ({
      visible,
      options,
    }: {
      visible: boolean
      options: Array<{ key: string; label?: string; tx?: string; onPress: () => void }>
    }) =>
      visible
        ? react.createElement(
            rn.View,
            null,
            options.map((option) =>
              react.createElement(
                rn.Text,
                { key: option.key, onPress: option.onPress },
                `choose ${option.label ?? option.tx}`,
              ),
            ),
          )
        : null,
  }
})
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

const navigation = { goBack: jest.fn(), navigate: jest.fn() }

const settings = { timeZone: null, clock: null, quietHours: null, mutedPeople: [] }

beforeEach(() => {
  jest.clearAllMocks()
  storage.clearAll()
  mockMembers = []
  mockPlaces = []
  mockState = {
    user: { id: "ana", notificationSettings: settings },
    serverInfo: { pushProvider: "expo", features: { notificationControls: true } },
  }
})

const member = (userId: string, displayName: string, places: Record<string, string> = {}) => ({
  userId,
  circleId: "c1",
  user: { id: userId, displayName, avatarColor: "#000", avatarUrl: null },
  role: "member",
  nickname: null,
  sharingState: "precise",
  pausedUntil: null,
  joinedAt: "2026-10-01T00:00:00.000Z",
  notifications: { muted: [], mutedUntil: null, places },
})

function renderScreen() {
  return render(
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
}

describe("what to hear about each place", () => {
  it("shows each place's choice and changes it from a sheet", async () => {
    mockMembers = [member("ana", "Ana", { school: "leave" }), member("kid", "Kid")]
    mockPlaces = [
      { id: "home", name: "Home", icon: "home" },
      { id: "school", name: "School", icon: "school" },
    ]
    const { getByText, getAllByText } = renderScreen()
    await act(async () => {})

    expect(getAllByText("notifications:placeBoth")).toHaveLength(1)
    expect(getByText("notifications:placeLeaveOnly")).toBeTruthy()
    await act(async () => {
      fireEvent.press(getByText("School"))
    })
    await act(async () => {
      fireEvent.press(getByText("choose notifications:placeArriveOnly"))
    })
    expect(mockSetNotifications).toHaveBeenCalledWith(
      { places: { school: "arrive" } },
      expect.anything(),
    )
  })
})

describe("muting a person", () => {
  it("lists everyone else in the circle and stops hearing about the one switched off", async () => {
    mockMembers = [member("ana", "Ana"), member("kid", "Kid")]
    const { getByText, queryByText } = renderScreen()
    await act(async () => {})

    expect(queryByText("Ana")).toBeNull()
    await act(async () => {
      fireEvent.press(getByText("Kid"))
    })
    expect(mockUpdateSettings).toHaveBeenCalledWith({ mutedPeople: ["kid"] }, expect.anything())
  })
})

describe("quiet hours", () => {
  it("turns on from ten until seven, read on this phone's clock", async () => {
    const { getByText } = renderScreen()
    await act(async () => {})

    await act(async () => {
      fireEvent.press(getByText("notifications:quietHours"))
    })
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      {
        quietHours: { from: "22:00", until: "07:00", then: "hold" },
        timeZone: "Asia/Karachi",
        clock: "12h",
      },
      expect.anything(),
    )
  })

  it("changes what happens to news during them", async () => {
    mockState = {
      ...mockState,
      user: {
        id: "ana",
        notificationSettings: {
          ...settings,
          quietHours: { from: "22:00", until: "07:00", then: "hold" },
        },
      },
    }
    const { getByText } = renderScreen()
    await act(async () => {})

    await act(async () => {
      fireEvent.press(getByText("notifications:quietThen"))
    })
    await act(async () => {
      fireEvent.press(getByText("choose notifications:quietDrop"))
    })
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ quietHours: { from: "22:00", until: "07:00", then: "drop" } }),
      expect.anything(),
    )
  })
})

describe("a server older than these controls", () => {
  it("shows only the switches it understands", async () => {
    mockState = { ...mockState, serverInfo: { pushProvider: "expo", features: {} } }
    mockMembers = [member("ana", "Ana"), member("kid", "Kid")]
    mockPlaces = [{ id: "home", name: "Home", icon: "home" }]
    const { queryByText } = renderScreen()
    await act(async () => {})

    expect(queryByText("notifications:quietHours")).toBeNull()
    expect(queryByText("Kid")).toBeNull()
    expect(queryByText("Home")).toBeNull()
  })
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
