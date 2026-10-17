import { act, fireEvent, render } from "@testing-library/react-native"

import { IncidentPrompt } from "./IncidentPrompt"
import { useIncidentStore } from "../stores/incident"
import { ThemeProvider } from "../theme/context"

const mockCheck = jest.fn(async () => {})
const mockDismiss = jest.fn(async () => {})
const mockEscalate = jest.fn(async () => {})
// The decisions are the module's and are tested there. The prompt only shows
// them and passes the buttons on.
jest.mock("@/services/incidentAlarm", () => ({
  INCIDENT_COUNTDOWN_MS: 30_000,
  incidentPhase: jest.requireActual("@/services/incidentAlarm").incidentPhase,
  checkIncident: () => mockCheck(),
  dismissIncident: () => mockDismiss(),
  escalateIncident: () => mockEscalate(),
}))
jest.mock("@/services/api", () => ({ endpoints: {}, ApiError: class {} }))
jest.mock("@/utils/haptics", () => ({
  haptics: { error: jest.fn(), select: jest.fn(), tap: jest.fn() },
}))

const START = Date.parse("2026-03-01T08:00:00.000Z")

function mount() {
  return render(
    <ThemeProvider>
      <IncidentPrompt />
    </ThemeProvider>,
  )
}

describe("IncidentPrompt", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(START)
    jest.clearAllMocks()
  })

  afterEach(() => {
    useIncidentStore.setState({ pending: null })
    jest.useRealTimers()
  })

  it("counts down from the time of the jolt, and gives the module a moment on every tick", async () => {
    useIncidentStore.setState({
      pending: { detectedAt: START - 10_000, peakDeltaG: 9, corroborations: 2 },
    })
    const { getByText } = mount()
    await act(async () => {})
    expect(getByText("20")).toBeTruthy()

    const before = mockCheck.mock.calls.length
    await act(async () => {
      jest.advanceTimersByTime(1_000)
    })
    expect(getByText("19")).toBeTruthy()
    expect(mockCheck.mock.calls.length).toBeGreaterThan(before)
  })

  it("says it is sending while the first try is on its way", async () => {
    useIncidentStore.setState({
      pending: {
        detectedAt: START - 31_000,
        peakDeltaG: 9,
        corroborations: 2,
        escalatedAt: START - 1_000,
      },
    })
    const { getByText, queryByText } = mount()
    await act(async () => {})
    expect(getByText("incident:sending")).toBeTruthy()
    expect(queryByText("incident:waiting")).toBeNull()
  })

  it("says it is waiting for a connection once a try has failed", async () => {
    useIncidentStore.setState({
      pending: {
        detectedAt: START - 60_000,
        peakDeltaG: 9,
        corroborations: 2,
        escalatedAt: START - 30_000,
        triedAt: START - 30_000,
        attempts: 1,
        failure: "network",
      },
    })
    const { getByText } = mount()
    await act(async () => {})
    expect(getByText("incident:waiting")).toBeTruthy()
  })

  it("hands both buttons to the module", async () => {
    useIncidentStore.setState({
      pending: { detectedAt: START, peakDeltaG: 9, corroborations: 2 },
    })
    const { getByText } = mount()
    await act(async () => {})

    await act(async () => {
      fireEvent.press(getByText("incident:sendNow"))
    })
    expect(mockEscalate).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.press(getByText("incident:imOk"))
    })
    expect(mockDismiss).toHaveBeenCalledTimes(1)
  })

  it("draws nothing without an incident", () => {
    const { toJSON } = mount()
    expect(toJSON()).toBeNull()
  })
})
