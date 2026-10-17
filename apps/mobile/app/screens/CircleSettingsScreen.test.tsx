import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { CircleSettingsScreen, retentionOptions } from "./CircleSettingsScreen"
import { useToastStore } from "../stores/toast"
import { ThemeProvider } from "../theme/context"

const mockMutate = jest.fn()
let mockCircle: Record<string, unknown>
let mockAuth: Record<string, unknown>
let mockUnits: "metric" | "imperial"
let mockPrompt: { onSubmit: (value: string) => void; title?: string } | null = null

jest.mock("../hooks/queries", () => ({
  useCircle: () => mockCircle,
  useUpdateCircle: () => ({ mutate: mockMutate }),
}))
jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector(mockAuth),
}))
jest.mock("../stores/settings", () => {
  const useSettingsStore = (selector: (s: unknown) => unknown) =>
    selector({ units: mockUnits, hapticsEnabled: false })
  useSettingsStore.getState = () => ({ units: mockUnits, hapticsEnabled: false })
  return { useSettingsStore }
})
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../components/PromptDialog", () => ({
  PromptDialog: (props: { onSubmit: (value: string) => void; title?: string }) => {
    mockPrompt = props
    return null
  },
}))
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))

const navigation = { goBack: jest.fn(), navigate: jest.fn() }

function circle(settings: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Family",
    settings: {
      historyRetentionDays: 30,
      minUpdateIntervalSeconds: 60,
      distanceFilterMeters: 80,
      lowBatteryThreshold: 0.15,
      allowSharingPause: true,
      allowHistory: true,
      speedAlertKmh: 0,
      incidentDetection: false,
      ...settings,
    },
  }
}

async function renderScreen() {
  const screen = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <CircleSettingsScreen
          navigation={navigation as never}
          route={{ key: "settings", name: "CircleSettings", params: { circleId: "c1" } } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // Row icons load their font asynchronously.
  await act(async () => {})
  return screen
}

/** The custom chips come in the order the sections are drawn. */
const CUSTOM_CHIP = { speed: 0, battery: 1, interval: 2, retention: 3 }

beforeEach(() => {
  jest.clearAllMocks()
  mockPrompt = null
  mockUnits = "metric"
  mockCircle = circle()
  mockAuth = { serverInfo: { maxHistoryRetentionDays: 90 } }
  useToastStore.setState({ current: null } as never)
})

describe("speed alerts", () => {
  it("offers km/h to someone who uses kilometres", async () => {
    const { getByText } = await renderScreen()
    fireEvent.press(getByText("80 km/h"))
    expect(mockMutate).toHaveBeenCalledWith({ settings: { speedAlertKmh: 80 } }, expect.anything())
  })

  it("offers mph to someone who uses miles and stores km/h", async () => {
    mockUnits = "imperial"
    const { getByText, queryByText } = await renderScreen()
    expect(queryByText(/km\/h/)).toBeNull()
    fireEvent.press(getByText("50 mph"))
    expect(mockMutate).toHaveBeenCalledWith({ settings: { speedAlertKmh: 80 } }, expect.anything())
  })

  // Set by somebody in kilometres, the threshold has to land on a preset in
  // miles, or the row grows a second chip with the same label.
  it("shows a threshold set in km/h as the matching mph preset", async () => {
    mockUnits = "imperial"
    mockCircle = circle({ speedAlertKmh: 120 })
    const { getAllByText } = await renderScreen()
    expect(getAllByText("75 mph")).toHaveLength(1)
  })

  it("takes a custom speed in mph", async () => {
    mockUnits = "imperial"
    const { getAllByText } = await renderScreen()
    fireEvent.press(getAllByText("circle:custom")[CUSTOM_CHIP.speed]!)
    expect(mockPrompt).not.toBeNull()
    act(() => mockPrompt!.onSubmit("70"))
    expect(mockMutate).toHaveBeenCalledWith({ settings: { speedAlertKmh: 113 } }, expect.anything())
  })

  it("refuses a custom mph the server could not store", async () => {
    mockUnits = "imperial"
    const { getAllByText } = await renderScreen()
    fireEvent.press(getAllByText("circle:custom")[CUSTOM_CHIP.speed]!)
    act(() => mockPrompt!.onSubmit("187"))
    expect(mockMutate).not.toHaveBeenCalled()
    act(() => mockPrompt!.onSubmit("186"))
    expect(mockMutate).toHaveBeenCalledWith({ settings: { speedAlertKmh: 299 } }, expect.anything())
  })
})

describe("history retention", () => {
  it("offers nothing longer than the server keeps", () => {
    expect(retentionOptions(undefined)).toEqual([0, 1, 7, 30, 90])
    expect(retentionOptions(90)).toEqual([0, 1, 7, 30, 90])
    expect(retentionOptions(14)).toEqual([0, 1, 7, 14])
    expect(retentionOptions(30)).toEqual([0, 1, 7, 30])
    expect(retentionOptions(365)).toEqual([0, 1, 7, 30, 90])
  })

  it("says why, and refuses a custom value above the ceiling", async () => {
    mockAuth = { serverInfo: { maxHistoryRetentionDays: 14 } }
    const { getAllByText, getByText } = await renderScreen()
    expect(getByText("circle:retentionCeiling")).toBeTruthy()

    fireEvent.press(getAllByText("circle:custom")[CUSTOM_CHIP.retention]!)
    act(() => mockPrompt!.onSubmit("30"))
    expect(mockMutate).not.toHaveBeenCalled()
    expect(useToastStore.getState().current?.message).toContain("circle:customInvalid")

    act(() => mockPrompt!.onSubmit("14"))
    expect(mockMutate).toHaveBeenCalledWith(
      { settings: { historyRetentionDays: 14 } },
      expect.anything(),
    )
  })

  it("keeps the old range on a server that does not say its ceiling", async () => {
    mockAuth = { serverInfo: {} }
    const { getAllByText, queryByText } = await renderScreen()
    expect(queryByText("circle:retentionCeiling")).toBeNull()

    fireEvent.press(getAllByText("circle:custom")[CUSTOM_CHIP.retention]!)
    act(() => mockPrompt!.onSubmit("365"))
    expect(mockMutate).toHaveBeenCalledWith(
      { settings: { historyRetentionDays: 365 } },
      expect.anything(),
    )
  })
})
