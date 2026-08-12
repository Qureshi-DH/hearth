import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { KeepAliveScreen } from "./KeepAliveScreen"
import { ThemeProvider } from "../theme/context"

let mockManufacturer: string | null = "xiaomi"
let mockRestricted = false
let mockBattery: "exempt" | "optimized" | "n/a" = "optimized"

jest.mock("../services/permissions", () => ({
  getPermissionSnapshot: jest.fn(async () => ({
    location: "always",
    servicesEnabled: true,
    preciseLocation: true,
    notifications: "granted",
    batteryOptimization: mockBattery,
    backgroundRefresh: "n/a",
    backgroundRestricted: mockRestricted,
    lowPowerMode: false,
    manufacturer: mockManufacturer,
    serviceStopped: false,
  })),
  vendorFor: jest.requireActual("../services/permissions").vendorFor,
  openAppSettings: jest.fn(async () => {}),
  openVendorPowerManager: jest.fn(async () => "com.miui.securitycenter/AutoStart"),
  requestBatteryExemption: jest.fn(async () => {}),
}))
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
jest.mock("@react-navigation/native", () => {
  const react = require("react")
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      react.useEffect(effect, [effect])
    },
  }
})

const permissions = jest.requireMock("../services/permissions") as {
  openVendorPowerManager: jest.Mock
  openAppSettings: jest.Mock
  requestBatteryExemption: jest.Mock
}

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
        <KeepAliveScreen
          navigation={navigation as never}
          route={{ key: "keepAlive", name: "KeepAlive" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return view
}

describe("KeepAliveScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockManufacturer = "xiaomi"
    mockRestricted = false
    mockBattery = "optimized"
  })

  it("shows the maker's own steps and opens its power manager", async () => {
    const { getByText, queryByText } = await renderScreen()

    expect(getByText("keepAlive:xiaomiTitle")).toBeTruthy()
    expect(getByText("keepAlive:xiaomiSteps")).toBeTruthy()
    expect(queryByText("keepAlive:genericSteps")).toBeNull()

    await act(async () => {
      fireEvent.press(getByText("keepAlive:openVendor"))
    })
    expect(permissions.openVendorPowerManager).toHaveBeenCalledTimes(1)
  })

  it("falls back to the plain Android steps on a maker it does not know", async () => {
    mockManufacturer = "google"
    const { getByText, queryByText } = await renderScreen()

    expect(getByText("keepAlive:genericTitle")).toBeTruthy()
    expect(getByText("keepAlive:genericSteps")).toBeTruthy()
    expect(queryByText("keepAlive:xiaomiSteps")).toBeNull()
  })

  // The restriction is the one switch here the OS will read back, so it is
  // said plainly rather than left inside the list of steps.
  it("says when background usage is Restricted and sends the person to the app's page", async () => {
    mockRestricted = true
    const { getByText, queryByText } = await renderScreen()

    expect(getByText("keepAlive:restrictedNow")).toBeTruthy()
    await act(async () => {
      fireEvent.press(getByText("keepAlive:openAppSettings"))
    })
    expect(permissions.openAppSettings).toHaveBeenCalledTimes(1)
    expect(queryByText("keepAlive:restrictedClear")).toBeNull()

    mockRestricted = false
    const clear = await renderScreen()
    expect(clear.queryByText("keepAlive:restrictedNow")).toBeNull()
    expect(clear.getByText("keepAlive:restrictedClear")).toBeTruthy()
  })

  it("offers the exemption dialog only while the optimiser still applies", async () => {
    const { getByText } = await renderScreen()
    await act(async () => {
      fireEvent.press(getByText("keepAlive:exempt"))
    })
    expect(permissions.requestBatteryExemption).toHaveBeenCalledTimes(1)

    mockBattery = "exempt"
    const done = await renderScreen()
    expect(done.queryByText("keepAlive:exempt")).toBeNull()
    expect(done.getByText("keepAlive:exemptDone")).toBeTruthy()
  })
})
