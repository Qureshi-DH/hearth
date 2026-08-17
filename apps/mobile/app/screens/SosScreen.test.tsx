import { NavigationContainer } from "@react-navigation/native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { SosScreen } from "./SosScreen"
import { useAlertStore } from "@/stores/alert"
import { toast } from "../stores/toast"
import { ThemeProvider } from "../theme/context"

const mockResolveMutate = jest.fn()

// The note field scrolls above the keyboard; the library needs its own double here.
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest"),
)
jest.mock("../hooks/queries", () => ({
  useActiveSos: () => ({
    data: [{ id: "alert-1", user: { id: "me" }, startedAt: new Date().toISOString(), note: null }],
  }),
  useRaiseSos: () => ({ mutateAsync: jest.fn(), isPending: false }),
  // Called rather than passed, because the factory runs before the const above
  // is initialised.
  useResolveSos: () => ({
    mutateAsync: (id: string) => mockResolveMutate(id),
    isPending: false,
  }),
}))

jest.mock("../services/location/tracker", () => ({ reportNow: jest.fn() }))

// Reanimated has no native half under jest, and the hold button is not what is
// under test here.
jest.mock("../components/SosHoldButton", () => ({ SosHoldButton: () => null }))

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

async function openResolveConfirm() {
  const { getByText } = render(
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
  fireEvent.press(getByText(/sos:resolve/))
}

describe("SosScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useAlertStore.setState({ current: null, queue: [] })
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
})
