import { NavigationContainer } from "@react-navigation/native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { SosScreen } from "./SosScreen"
import { useAlertStore } from "@/stores/alert"
import { useTrackingStore } from "@/stores/tracking"
import { toast } from "../stores/toast"
import { ThemeProvider } from "../theme/context"

const mockResolveMutate = jest.fn()
const mockRaiseMutate = jest.fn()
const mockReportNow = jest.fn()
let mockActive: Array<{ id: string; user: { id: string }; startedAt: string; note: null }> = []

const MINE = { id: "alert-1", user: { id: "me" }, startedAt: new Date().toISOString(), note: null }

// The note field scrolls above the keyboard; the library needs its own double here.
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest"),
)
// Called rather than passed, because the factory runs before the consts above
// are initialised.
jest.mock("../hooks/queries", () => ({
  useMyOpenSos: () => mockActive.find((alert) => alert.user.id === "me") ?? null,
  useRaiseSos: () => ({
    mutateAsync: (note: string | null) => mockRaiseMutate(note),
    isPending: false,
  }),
  useResolveSos: () => ({
    mutateAsync: (id: string) => mockResolveMutate(id),
    isPending: false,
  }),
}))

jest.mock("../services/location/tracker", () => ({
  reportNow: (...args: unknown[]) => mockReportNow(...args),
}))

// Reanimated has no native half under jest, so the hold is a plain press here.
jest.mock("../components/SosHoldButton", () => {
  const { Pressable, Text } = require("react-native")
  return {
    SosHoldButton: (props: {
      onActivate: () => void
      active: boolean
      hint: string
      label: string
    }) => (
      <Pressable testID="sos-hold" onPress={props.onActivate}>
        <Text>{props.active ? props.hint : props.label}</Text>
      </Pressable>
    ),
  }
})

jest.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "me" } }),
}))

const navigation = { goBack: jest.fn(), navigate: jest.fn() }

/** The destructive button of the confirmation alert the Resolve row opens. */
function confirmResolve(): Promise<void> {
  const buttons = useAlertStore.getState().current?.buttons ?? []
  const confirm = buttons.find((button) => button.style !== "cancel")
  useAlertStore.getState().dismiss()
  return Promise.resolve(confirm?.onPress?.())
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
        <NavigationContainer>
          <SosScreen
            navigation={navigation as never}
            route={{ key: "sos", name: "Sos", params: { circleId: "circle-1" } } as never}
          />
        </NavigationContainer>
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  // The close icon loads its font asynchronously, and settling that here keeps
  // the update inside act.
  await act(async () => {})
  return screen
}

async function openResolveConfirm() {
  const { getByText } = await renderScreen()
  fireEvent.press(getByText(/sos:resolve/))
}

describe("SosScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockActive = [MINE]
    mockReportNow.mockResolvedValue(null)
    mockRaiseMutate.mockResolvedValue({})
    useAlertStore.setState({ current: null, queue: [] })
    useTrackingStore.getState().setWatchedUntil(null)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("stays on the alert and says so when resolving fails", async () => {
    mockResolveMutate.mockRejectedValue(new Error("Only the person who raised it can resolve it."))
    const error = jest.spyOn(toast, "error").mockImplementation(() => {})

    await openResolveConfirm()
    await confirmResolve()

    expect(error).toHaveBeenCalledWith("Only the person who raised it can resolve it.")
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it("leaves the screen once the alert is actually resolved", async () => {
    mockResolveMutate.mockResolvedValue(undefined)
    jest.spyOn(toast, "success").mockImplementation(() => {})

    await openResolveConfirm()
    await confirmResolve()

    expect(mockResolveMutate).toHaveBeenCalledWith("alert-1")
    expect(navigation.goBack).toHaveBeenCalled()
  })

  describe("raising it", () => {
    beforeEach(() => {
      mockActive = []
      jest.spyOn(toast, "success").mockImplementation(() => {})
      jest.spyOn(toast, "error").mockImplementation(() => {})
    })

    it("uploads a fresh fix before it raises the alert", async () => {
      const order: string[] = []
      mockReportNow.mockImplementation(async (source: string) => {
        order.push(`fix:${source}`)
        return null
      })
      mockRaiseMutate.mockImplementation(async () => {
        order.push("raise")
        return {}
      })

      const { getByTestId } = await renderScreen()
      await act(async () => {
        fireEvent.press(getByTestId("sos-hold"))
      })

      expect(order).toEqual(["fix:sos", "raise"])
    })

    it("raises at once, with no fix to wait for, when sharing is off on the phone", async () => {
      jest.useFakeTimers()
      useTrackingStore.getState().setEnabled(false)
      mockReportNow.mockReturnValue(new Promise(() => {}))

      const { getByTestId } = await renderScreen()
      await act(async () => {
        fireEvent.press(getByTestId("sos-hold"))
      })
      useTrackingStore.getState().setEnabled(true)

      // A fix taken now would sit in the queue and go up whenever sharing
      // came back on, long after anybody needed it.
      expect({
        raised: mockRaiseMutate.mock.calls.length,
        fixes: mockReportNow.mock.calls.length,
      }).toEqual({ raised: 1, fixes: 0 })
    })

    it("raises the alert even when the fix fails", async () => {
      mockReportNow.mockRejectedValue(new Error("Location request timed out"))

      const { getByTestId } = await renderScreen()
      await act(async () => {
        fireEvent.press(getByTestId("sos-hold"))
      })

      expect(mockRaiseMutate).toHaveBeenCalledTimes(1)
    })

    it("does not hold the alert back for a fix that is slow to come", async () => {
      jest.useFakeTimers()
      mockReportNow.mockReturnValue(new Promise(() => {}))

      const { getByTestId } = await renderScreen()
      await act(async () => {
        fireEvent.press(getByTestId("sos-hold"))
      })
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      expect(mockRaiseMutate).not.toHaveBeenCalled()

      await act(async () => {
        jest.advanceTimersByTime(10_000)
      })
      expect(mockRaiseMutate).toHaveBeenCalledTimes(1)
    })
  })

  describe("what it says", () => {
    // The hold button is a double here, so the hint is read off its props.
    it("says the circles follow her live while she is sharing", async () => {
      useTrackingStore.getState().setEnabled(true)
      const { queryByText } = await renderScreen()
      expect(queryByText("sos:sentBody")).not.toBeNull()
    })

    it("says the circles only see where she was when sharing is off on the phone", async () => {
      useTrackingStore.getState().setEnabled(false)
      const { queryByText } = await renderScreen()
      expect(queryByText("sos:sentBodySharingOff")).not.toBeNull()
      useTrackingStore.getState().setEnabled(true)
    })
  })

  describe("while it is open", () => {
    it("leaves the reporting to Live while the phone is on it", async () => {
      jest.useFakeTimers()
      useTrackingStore.getState().setWatchedUntil(new Date(Date.now() + 120_000).toISOString())

      await renderScreen()
      await act(async () => {
        jest.advanceTimersByTime(60_000)
      })

      expect(mockReportNow).not.toHaveBeenCalled()
    })

    it("takes no fixes of its own while sharing is off on the phone", async () => {
      jest.useFakeTimers()
      useTrackingStore.getState().setEnabled(false)

      await renderScreen()
      await act(async () => {
        jest.advanceTimersByTime(60_000)
      })
      useTrackingStore.getState().setEnabled(true)

      expect(mockReportNow).not.toHaveBeenCalled()
    })

    it("reports every twenty seconds itself while the phone is not on Live", async () => {
      jest.useFakeTimers()

      await renderScreen()
      expect(mockReportNow).toHaveBeenCalledTimes(1)
      await act(async () => {
        jest.advanceTimersByTime(20_000)
      })

      expect(mockReportNow).toHaveBeenCalledTimes(2)
      expect(mockReportNow).toHaveBeenLastCalledWith("sos")
    })
  })
})
