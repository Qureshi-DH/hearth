import { IMPACT } from "@hearth/shared"

import { contemporaneousSpeed, startDriveSensors, stopDriveSensors } from "./driveSensors"

/** Held outside the factory so the test can drive the sensor by hand. */
type Vector = { x: number; y: number; z: number }
const mockState: { accel?: (r: Vector) => void; gyro?: (r: Vector) => void } = {}

jest.mock("expo-sensors", () => {
  const sensor = (slot: "accel" | "gyro") => ({
    isAvailableAsync: jest.fn(async () => true),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn((cb: (reading: Vector) => void) => {
      mockState[slot] = cb
      return { remove: jest.fn() }
    }),
  })
  return {
    Accelerometer: sensor("accel"),
    Gyroscope: sensor("gyro"),
    // No barometer, which is a real and common Android phone.
    Barometer: {
      isAvailableAsync: jest.fn(async () => false),
      setUpdateInterval: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    },
  }
})

const STEP_MS = 20

/** The accelerometer reports a vector; the detector only reads its magnitude. */
const push = (g: number) => mockState.accel?.({ x: 0, y: 0, z: g })
const spin = (rps: number) => mockState.gyro?.({ x: 0, y: 0, z: rps })

/** Feeds `seconds` of samples at 50Hz, advancing the clock as it goes. */
function drive(seconds: number, g: () => number) {
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += STEP_MS) {
    push(g())
    jest.advanceTimersByTime(STEP_MS)
  }
}

describe("contemporaneousSpeed", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z")
  const fix = (secondsAgo: number, speedMps: number | null) => ({
    recordedAt: new Date(now - secondsAgo * 1000).toISOString(),
    speedMps,
  })

  it("uses a fix that describes this instant", () => {
    expect(contemporaneousSpeed(fix(1, 24), now)).toBe(24)
  })

  it("refuses a fix from a minute ago rather than repeating it", () => {
    // Deferred location batches are a minute apart. Carrying the last speed
    // forward stamps a confident 24 m/s across the seconds after a crash.
    expect(contemporaneousSpeed(fix(60, 24), now)).toBeUndefined()
  })

  it("says nothing when the fix carried no speed, and when there is no fix", () => {
    expect(contemporaneousSpeed(fix(1, null), now)).toBeUndefined()
    expect(contemporaneousSpeed(null, now)).toBeUndefined()
  })
})

describe("drive sensor lifecycle", () => {
  let seed = 1

  /** Deterministic road vibration, which is what says the vehicle was moving. */
  const road = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return 1 + 0.2 * (seed / 0xffffffff - 0.5)
  }
  const parked = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return 1 + 0.017 * (seed / 0xffffffff - 0.5)
  }

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(Date.parse("2026-01-01T12:00:00.000Z"))
    seed = 1
  })

  afterEach(() => {
    stopDriveSensors()
    jest.useRealTimers()
  })

  it("delivers a verdict for the samples it holds even after it has been stopped", async () => {
    // A crashed car reads as "still" to the OS classifier, which stops the
    // sensors — inside the very window the verdict is waiting on.
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    drive(6, road)
    // The car yaws and the phone tumbles: the signal that says collision
    // rather than something heavy landing in the footwell.
    spin(7)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)
    drive(7, parked)

    expect(events).toEqual([])
    stopDriveSensors()
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
  })

  it("keeps quiet when nothing violent happened", async () => {
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    spin(0.3)
    drive(10, road)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual([])
  })
})
