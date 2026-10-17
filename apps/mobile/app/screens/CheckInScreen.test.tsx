import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, render } from "@testing-library/react-native"

import { CheckInScreen } from "./CheckInScreen"
import { ThemeProvider } from "../theme/context"

const HOME = { lat: 51.4545, lon: -2.5879 }

jest.mock("../hooks/queries", () => ({
  // The big place first, the order a server may well hand them back in.
  usePlaces: () => ({
    data: [
      { id: "town", name: "Town", lat: 51.4545, lon: -2.5879, radiusMeters: 5000 },
      { id: "home", name: "Home", lat: 51.4545, lon: -2.5879, radiusMeters: 100 },
    ],
  }),
  useCheckIn: () => ({ mutateAsync: jest.fn(), isPending: false }),
}))
jest.mock("../services/location/tracker", () => ({
  reportNow: async () => ({ ...HOME, accuracyMeters: 8 }),
}))
jest.mock("../components/SheetScreen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    SheetScreen: ({ children }: { children?: unknown }) =>
      react.createElement(rn.View, null, children),
    SheetTextField: () => null,
  }
})

describe("checking in", () => {
  it("names the smallest place the phone is in, the one the server files it under", async () => {
    const { getByText, queryByText } = render(
      <ThemeProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <CheckInScreen
            navigation={{ goBack: jest.fn() } as never}
            route={{ key: "check-in", name: "CheckIn", params: { circleId: "c1" } } as never}
          />
        </SafeAreaProvider>
      </ThemeProvider>,
    )
    await act(async () => {})
    expect(getByText("Home")).toBeTruthy()
    expect(queryByText("Town")).toBeNull()
  })
})
