import type { MemberPresence } from "@hearth/shared"

jest.mock("react-native-reanimated", () => {
  const react = require("react")
  const rn = require("react-native")
  return {
    __esModule: true,
    default: { View: rn.View, createAnimatedComponent: (component: unknown) => component },
    Easing: { out: (fn: unknown) => fn, ease: (value: number) => value },
    cancelAnimation: () => {},
    useSharedValue: (initial: number) => react.useRef({ value: initial }).current,
    useAnimatedStyle: (worklet: () => object) => worklet(),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  }
})
// eslint-disable-next-line import/first
import { faceAtOffset, groupLabel, sameFaces, type MarkerFace } from "./MemberMarker"

const presence = (patch: Partial<MemberPresence> = {}): MemberPresence => ({
  userId: "ana",
  lat: 33.7,
  lon: 73.05,
  accuracyMeters: 10,
  recordedAt: new Date("2026-09-23T10:00:00Z").toISOString(),
  batteryLevel: 0.6,
  isCharging: false,
  activity: "walking",
  speedMps: 1.2,
  headingDegrees: null,
  approximate: false,
  sharingState: "precise",
  stale: false,
  atPlace: null,
  sosAlertId: null,
  issues: [],
  ...patch,
})

const face = (patch: Partial<MarkerFace> = {}): MarkerFace => ({
  userId: "ana",
  user: { displayName: "Ana", avatarColor: "#888", avatarUrl: null },
  label: "Ana",
  presence: presence(),
  ring: "none",
  ...patch,
})

/**
 * A marker on a watched phone is handed a new presence object every second,
 * and almost none of them change how the face looks. Re-rendering a view the
 * map holds on its own surface for each of them is churn the map does not
 * need, so the marker only redraws when something it draws has changed.
 */
describe("sameFaces", () => {
  it("is true for faces that differ only by object identity", () => {
    expect(sameFaces([face()], [face()])).toBe(true)
  })

  it("is true when only the position and the moment moved", () => {
    expect(
      sameFaces(
        [face()],
        [face({ presence: presence({ lat: 33.71, recordedAt: "2026-09-23T10:00:01Z" }) })],
      ),
    ).toBe(true)
  })

  it("is false when the face itself changes", () => {
    expect(sameFaces([face()], [face({ selected: true })])).toBe(false)
    expect(sameFaces([face()], [face({ label: "Ana B" })])).toBe(false)
    expect(sameFaces([face()], [face({ ring: "sos" })])).toBe(false)
    expect(sameFaces([face()], [face({ user: { ...face().user, avatarUrl: "u" } })])).toBe(false)
  })

  it("is false when the phone goes stale or raises an SOS, which the face shows", () => {
    expect(sameFaces([face()], [face({ presence: presence({ stale: true }) })])).toBe(false)
    expect(sameFaces([face()], [face({ presence: presence({ sosAlertId: "s1" }) })])).toBe(false)
  })

  it("is false when the marker gains or loses a face", () => {
    expect(sameFaces([face()], [face(), face({ userId: "ben", label: "Ben" })])).toBe(false)
    expect(sameFaces([], [face()])).toBe(false)
  })
})

describe("groupLabel", () => {
  it("names one, two, three, then counts the rest", () => {
    expect(groupLabel(["Ana"])).toBe("Ana")
    expect(groupLabel([])).toBe("")
    expect(groupLabel(["Ana", "Ben"])).toContain("map:pair")
    expect(groupLabel(["Ana", "Ben", "Cat"])).toContain("map:trio")
    expect(groupLabel(["Ana", "Ben", "Cat", "Dee"])).toContain("map:more")
  })
})

describe("faceAtOffset", () => {
  it("reads the middle of a stack from where the touch landed", () => {
    expect(faceAtOffset(1, 0)).toBe(0)
    expect(faceAtOffset(3, -40)).toBe(0)
    expect(faceAtOffset(3, 40)).toBe(2)
  })
})
