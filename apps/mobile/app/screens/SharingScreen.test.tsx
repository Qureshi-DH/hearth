import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { useTrackingStore } from "@/stores/tracking"

import { SharingScreen } from "./SharingScreen"
import { ThemeProvider } from "../theme/context"

const mockReportHealth = jest.fn(async () => {})
jest.mock("../services/health", () => ({ reportHealth: () => mockReportHealth() }))
const mockStart = jest.fn(async () => true)
const mockStop = jest.fn(async () => {})
jest.mock("../services/location/tracker", () => ({
  startTracking: () => mockStart(),
  stopTracking: () => mockStop(),
}))
jest.mock("../hooks/queries", () => ({
  useCircles: () => ({ data: [] }),
  useMembers: () => ({ data: [] }),
  useSetSharing: () => ({ mutate: jest.fn() }),
}))
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
jest.mock("../components/OptionSheet", () => ({ OptionSheet: () => null }))

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
        <SharingScreen
          navigation={navigation as never}
          route={{ key: "sharing", name: "Sharing" } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return view
}

describe("the Share my location switch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useTrackingStore.getState().setEnabled(true)
  })

  // Off on the phone, it reached the family as a dot fading on the map.
  it("tells the server when it goes off, and again when it comes back on", async () => {
    const { getAllByRole } = await renderScreen()
    await act(async () => {
      fireEvent.press(getAllByRole("switch")[0]!)
    })
    expect(mockStop).toHaveBeenCalled()
    expect(useTrackingStore.getState().enabled).toBe(false)
    expect(mockReportHealth).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.press(getAllByRole("switch")[0]!)
    })
    expect(mockStart).toHaveBeenCalled()
    expect(mockReportHealth).toHaveBeenCalledTimes(2)
  })
})
