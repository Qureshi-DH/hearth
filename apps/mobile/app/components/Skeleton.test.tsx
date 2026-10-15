import { View } from "react-native"
import { render } from "@testing-library/react-native"

import { Skeleton } from "./Skeleton"
import { ThemeProvider } from "../theme/context"

let mockReduceMotion = false
const mockRepeats: unknown[] = []

jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    __esModule: true,
    default: { View: rn.View },
    Easing: { inOut: (fn: unknown) => fn, quad: (value: number) => value },
    useReducedMotion: () => mockReduceMotion,
    useSharedValue: (initial: number) => react.useRef({ value: initial }).current,
    useAnimatedStyle: (worklet: () => object) => worklet(),
    withRepeat: (value: unknown) => {
      mockRepeats.push(value)
      return value
    },
    withTiming: (value: unknown) => value,
  }
})

function renderSkeleton() {
  return render(
    <ThemeProvider>
      <Skeleton accessibilityLabel="Loading activity">
        <View />
      </Skeleton>
    </ThemeProvider>,
  )
}

describe("Skeleton", () => {
  beforeEach(() => {
    mockReduceMotion = false
    mockRepeats.length = 0
  })

  it("reads as one busy element rather than as its shapes", () => {
    const { getByRole } = renderSkeleton()

    const skeleton = getByRole("progressbar", { name: "Loading activity" })
    expect(skeleton.props.accessibilityState).toMatchObject({ busy: true })
  })

  it("pulses", () => {
    renderSkeleton()

    expect(mockRepeats).toHaveLength(1)
  })

  it("holds still for someone who has asked for less motion", () => {
    mockReduceMotion = true

    renderSkeleton()

    expect(mockRepeats).toHaveLength(0)
  })
})
