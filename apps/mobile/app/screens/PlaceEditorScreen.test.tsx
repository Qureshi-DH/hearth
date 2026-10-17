import type { Place } from "@hearth/shared"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { act, fireEvent, render } from "@testing-library/react-native"

import { PlaceEditorScreen } from "./PlaceEditorScreen"
import { ThemeProvider } from "../theme/context"

const home: Place = {
  id: "p1",
  circleId: "c1",
  name: "Home",
  icon: "home",
  color: null,
  lat: 51.45,
  lon: -2.58,
  radiusMeters: 150,
  address: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: null,
  membersInside: [],
}

let mockPlaces: Place[] | undefined = [home]
let mockSaveAnswer: unknown = home
const mockSave = jest.fn(async (..._args: unknown[]) => mockSaveAnswer)
let mockDeleteAnswer: unknown = { ok: true }
const mockDelete = jest.fn(async (..._args: unknown[]) => mockDeleteAnswer)
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock("../hooks/queries", () => ({
  usePlaces: () => ({ data: mockPlaces }),
  useSavePlace: () => ({ mutateAsync: mockSave, isPending: false }),
  useDeletePlace: () => ({ mutateAsync: mockDelete }),
}))
jest.mock("../services/location/tracker", () => ({ reportNow: jest.fn() }))
jest.mock("../stores/tracking", () => ({
  useTrackingStore: (selector: (state: unknown) => unknown) => selector({ lastFix: null }),
}))
jest.mock("../stores/settings", () => {
  const state = { units: "metric", hapticsEnabled: false }
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state)
  // A press reads the haptics setting outside React.
  useSettingsStore.getState = () => state
  return { useSettingsStore }
})
jest.mock("../components/HearthMap", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    HearthMap: react.forwardRef(function HearthMap(
      { children }: { children?: unknown },
      _ref: unknown,
    ) {
      return react.createElement(rn.View, null, children)
    }),
  }
})
jest.mock("@maplibre/maplibre-react-native", () => ({
  GeoJSONSource: () => null,
  Layer: () => null,
}))
jest.mock("../components/Screen", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    Screen: ({ children }: { children?: unknown }) => react.createElement(rn.View, null, children),
  }
})
jest.mock("../utils/useHeader", () => ({ useHeader: () => {} }))
// The confirmation is a dialog of its own. Pressing delete here is
// answering it.
jest.mock("../stores/alert", () => ({
  alert: (
    _title: string,
    _body: string,
    buttons: Array<{ style?: string; onPress?: () => void }>,
  ) => buttons.find((button) => button.style === "destructive")?.onPress?.(),
}))

async function renderEditor(params: Record<string, unknown>) {
  const utils = render(
    <ThemeProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <PlaceEditorScreen
          navigation={mockNavigation as never}
          route={{ name: "PlaceEditor", params: { circleId: "c1", ...params } } as never}
        />
      </SafeAreaProvider>
    </ThemeProvider>,
  )
  await act(async () => {})
  return utils
}

const lastToast = () =>
  (require("../stores/toast") as typeof import("../stores/toast")).useToastStore.getState().current

beforeEach(() => {
  jest.clearAllMocks()
  mockPlaces = [home]
  mockSaveAnswer = home
  mockDeleteAnswer = { ok: true }
})

describe("editing a place somebody else has deleted", () => {
  it("says so and does not offer to save it", async () => {
    mockPlaces = []
    const screen = await renderEditor({ placeId: "p1" })
    expect(screen.getByText("places:gone")).toBeTruthy()
    fireEvent.press(screen.getByText("common:save"))
    await act(async () => {})
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("says so when the server reports it gone on saving", async () => {
    mockSaveAnswer = { id: "p1", gone: true }
    const screen = await renderEditor({ placeId: "p1" })
    fireEvent.press(screen.getByText("common:save"))
    await act(async () => {})
    expect(lastToast()?.message).toContain("places:gone")
  })

  it("saves a place that is still there", async () => {
    const screen = await renderEditor({ placeId: "p1" })
    fireEvent.press(screen.getByText("common:save"))
    await act(async () => {})
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(lastToast()?.tone).toBe("success")
  })
})

describe("deleting a place somebody else has deleted", () => {
  it("says it was already gone rather than going back without a word", async () => {
    mockDeleteAnswer = { ok: true, gone: true }
    const screen = await renderEditor({ placeId: "p1" })
    await act(async () => {
      fireEvent.press(screen.getByText("common:delete"))
    })
    expect(mockDelete).toHaveBeenCalledWith("p1")
    expect(lastToast()?.message).toContain("places:gone")
    expect(mockNavigation.navigate).toHaveBeenCalledWith("Main", { screen: "Places" })
  })
})

describe("a name suggested for a new place", () => {
  // A street and a town from the geocoder can run past what the server keeps,
  // and the field's limit does not shorten a value it was handed.
  it("is cut to what the server accepts", async () => {
    const screen = await renderEditor({ lat: 51.45, lon: -2.58, name: "Ä".repeat(120) })
    fireEvent.press(screen.getByText("common:save"))
    await act(async () => {})
    const [sent] = mockSave.mock.calls[0]! as [{ name: string }]
    expect([...sent.name]).toHaveLength(80)
  })
})
