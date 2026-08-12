import { AppState } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { PermissionsScreen } from "./PermissionsScreen"
import { useSettingsStore } from "../stores/settings"
import { ThemeProvider } from "../theme/context"

/** Order of the calls that matter, across every mocked service. */
const mockCalls: string[] = []
let mockMotion: "granted" | "denied" | "undetermined" | "unavailable" = "undetermined"
/** Set by a test that wants the motion answer to arrive after the rest. */
let mockMotionGate: Promise<void> | null = null

let mockBattery: "exempt" | "optimized" | "n/a" = "n/a"
let mockRefresh: "available" | "restricted" | "denied" | "n/a" = "available"
let mockManufacturer: string | null = "google"
let mockRestricted = false
let mockLowPower = false

jest.mock("../services/permissions", () => ({
  getPermissionSnapshot: jest.fn(async () => ({
    location: "always",
    servicesEnabled: true,
    preciseLocation: true,
    notifications: "granted",
    batteryOptimization: mockBattery,
    backgroundRefresh: mockRefresh,
    backgroundRestricted: mockRestricted,
    lowPowerMode: mockLowPower,
    manufacturer: mockManufacturer,
    serviceStopped: false,
  })),
  // The real one, because a copy in a mock would be a second list of makes
  // to keep in step with the first.
  vendorFor: jest.requireActual("../services/permissions").vendorFor,
  openAppSettings: jest.fn(async () => {}),
  openBatterySaverSettings: jest.fn(async () => {}),
  openLocationSettings: jest.fn(async () => {}),
  requestBatteryExemption: jest.fn(async () => {}),
  requestNotifications: jest.fn(async () => "granted"),
}))
jest.mock("../services/location/motion", () => ({
  motionPermission: jest.fn(async () => {
    if (mockMotionGate) await mockMotionGate
    return mockMotion
  }),
  ensureMotionPermission: jest.fn(async () => {
    mockCalls.push("ensureMotionPermission")
    mockMotion = "granted"
    return true
  }),
}))
jest.mock("../services/location/tracker", () => ({
  refreshMotionWatch: jest.fn(async () => {
    mockCalls.push("refreshMotionWatch")
  }),
  requestPermissions: jest.fn(async () => "always"),
  startTracking: jest.fn(async () => true),
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
// Focused for as long as it is mounted, which is the case under test.
jest.mock("@react-navigation/native", () => {
  const react = require("react")
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      react.useEffect(effect, [effect])
    },
  }
})

const navigation = { goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }

async function renderScreen() {
  const view = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <PermissionsScreen
          navigation={navigation as never}
          route={{ key: "permissions", name: "Permissions" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // The first refresh and the icon fonts both resolve asynchronously, and
  // settling them here keeps the update inside act.
  await act(async () => {})
  return view
}

/** Hands the screen's own AppState listeners a state change, as the OS would. */
async function setAppState(state: "active" | "background") {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(
    ([, listener]) => listener as (next: string) => void,
  )
  await act(async () => {
    listeners.forEach((listener) => listener(state))
  })
}

describe("PermissionsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCalls.length = 0
    mockMotion = "undetermined"
    mockMotionGate = null
    mockBattery = "n/a"
    mockRefresh = "available"
    mockManufacturer = "google"
    mockRestricted = false
    mockLowPower = false
    useSettingsStore.setState({ incidentDetection: false })
  })

  /** Runs the body on one platform and puts the other back whatever happens. */
  async function on(platform: "android" | "ios", body: () => Promise<void>) {
    const { Platform } = require("react-native")
    const os = Platform.OS
    Platform.OS = platform
    try {
      await body()
    } finally {
      Platform.OS = os
    }
  }

  it("offers the keep-alive page on a phone whose maker kills background apps", async () => {
    await on("android", async () => {
      mockManufacturer = "xiaomi"
      const { getByText, getAllByText } = await renderScreen()

      expect(getByText("permissions:keepAliveTitle")).toBeTruthy()
      // Nothing can read the vendor's switches, so it is a Check like Wi-Fi,
      // and a Check does not keep the checklist from reading Done.
      expect(getAllByText("permissions:stateInfo")).toHaveLength(2)
      await act(async () => {
        fireEvent.press(getByText(/permissions:keepAliveOpen/))
      })
      expect(navigation.navigate).toHaveBeenCalledWith("KeepAlive")
    })
  })

  it("shows the keep-alive row as Off when background usage is Restricted, whatever the maker", async () => {
    await on("android", async () => {
      mockRestricted = true
      const { getByText, queryByText } = await renderScreen()

      expect(getByText("permissions:keepAliveTitle")).toBeTruthy()
      expect(getByText("permissions:restrictedBody")).toBeTruthy()
      expect(getByText("permissions:stateBlocked")).toBeTruthy()
      expect(queryByText("common:done")).toBeNull()
    })
  })

  it("leaves the keep-alive row out on a phone that leaves apps alone", async () => {
    await on("android", async () => {
      const { queryByText } = await renderScreen()
      expect(queryByText("permissions:keepAliveTitle")).toBeNull()
    })
  })

  it("names Battery Saver only while it is on", async () => {
    await on("android", async () => {
      const off = await renderScreen()
      expect(off.queryByText("permissions:batterySaverTitle")).toBeNull()
      off.unmount()

      mockLowPower = true
      const { getByText, queryByText } = await renderScreen()
      expect(getByText("permissions:batterySaverTitle")).toBeTruthy()
      expect(getByText("permissions:stateBlocked")).toBeTruthy()
      expect(queryByText("common:done")).toBeNull()
    })
  })

  it("calls it Low Power Mode on an iPhone", async () => {
    await on("ios", async () => {
      mockLowPower = true
      const { getByText, queryByText } = await renderScreen()
      expect(getByText("permissions:lowPowerTitle")).toBeTruthy()
      expect(queryByText("permissions:batterySaverTitle")).toBeNull()
      expect(queryByText("permissions:keepAliveTitle")).toBeNull()
    })
  })

  // The row used to read "On" with a Review link beside it once the exemption
  // dialog had merely been shown. Now it says what the OS says.
  it("shows the battery row as done, with nothing left to press, only once the OS agrees", async () => {
    const { Platform } = require("react-native")
    const os = Platform.OS
    Platform.OS = "android"
    try {
      mockBattery = "optimized"
      const first = await renderScreen()
      expect(first.getByText("permissions:batteryTitle")).toBeTruthy()
      expect(first.getAllByText(/permissions:allow/).length).toBeGreaterThan(0)
      first.unmount()

      mockBattery = "exempt"
      const second = await renderScreen()
      expect(second.getByText("permissions:batteryTitle")).toBeTruthy()
      expect(second.queryByText(/permissions:review/)).toBeNull()
      // Location and notifications are granted in the mock, so the only Allow
      // left belongs to the motion row.
      expect(second.getAllByText(/permissions:allow/)).toHaveLength(1)
    } finally {
      Platform.OS = os
    }
  })

  it("shows Background App Refresh as what the OS says, not always Check", async () => {
    const { Platform } = require("react-native")
    const os = Platform.OS
    Platform.OS = "ios"
    try {
      const on = await renderScreen()
      expect(on.getByText("permissions:refreshTitle")).toBeTruthy()
      // The one Check left is the Wi-Fi row, which nothing can read.
      expect(on.getAllByText("permissions:stateInfo")).toHaveLength(1)
      expect(on.queryByText("permissions:stateBlocked")).toBeNull()
      on.unmount()

      mockRefresh = "restricted"
      const off = await renderScreen()
      expect(off.getByText("permissions:stateBlocked")).toBeTruthy()
      expect(off.getAllByText(/permissions:openSettings/).length).toBeGreaterThan(0)
    } finally {
      Platform.OS = os
    }
  })

  it("asks for motion even with incident alerts off, and is not done until it has it", async () => {
    const { getByText, queryByText } = await renderScreen()

    // Everything else is granted, so this row alone is what keeps the
    // checklist open.
    expect(getByText("permissions:motionTitle")).toBeTruthy()
    expect(getByText("permissions:stateTodo")).toBeTruthy()
    expect(getByText("permissions:later")).toBeTruthy()
    expect(queryByText("common:done")).toBeNull()
  })

  it("draws nothing, rather than Done, while the motion answer is still on its way", async () => {
    let answer!: () => void
    mockMotionGate = new Promise<void>((resolve) => {
      answer = resolve
    })
    const { getByText, queryByText } = await renderScreen()

    // The snapshot is back and the motion state is not. A checklist drawn from
    // the snapshot alone has no motion row, and every other row is done.
    expect(queryByText("common:done")).toBeNull()
    expect(queryByText("permissions:locationTitle")).toBeNull()

    await act(async () => {
      answer()
    })

    expect(getByText("permissions:motionTitle")).toBeTruthy()
    expect(getByText("permissions:later")).toBeTruthy()
  })

  it("tells the running tracker about the grant, after the dialog and not before", async () => {
    const { getByText, queryByText } = await renderScreen()

    await act(async () => {
      fireEvent.press(getByText(/permissions:allow/))
    })

    expect(mockCalls.slice(0, 2)).toEqual(["ensureMotionPermission", "refreshMotionWatch"])
    expect(queryByText("permissions:stateTodo")).toBeNull()
    expect(getByText("common:done")).toBeTruthy()
  })

  it("re-reads a grant made in Settings when the app comes back to the foreground", async () => {
    const { getByText, queryByText } = await renderScreen()
    expect(mockCalls).toEqual([])

    // Off to Settings and back. The route never changed, so focus does not
    // fire again. Only the foreground transition says anything happened.
    await setAppState("background")
    mockMotion = "granted"
    await setAppState("active")

    expect(mockCalls).toEqual(["refreshMotionWatch"])
    expect(queryByText("permissions:stateTodo")).toBeNull()
    expect(getByText("common:done")).toBeTruthy()
  })
})
