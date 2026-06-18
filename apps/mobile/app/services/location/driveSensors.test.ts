import { IMPACT } from "@hearth/shared"

import appConfig from "../../../app.json"
import {
  contemporaneousSpeed,
  driveSensorsRunning,
  startDriveSensors,
  stopDriveSensors,
} from "./driveSensors"

/** Held outside the factory so the test can drive the sensor by hand. */
type Vector = { x: number; y: number; z: number }
const mockState: {
  accel?: (r: Vector) => void
  gyro?: (r: Vector) => void
  baro?: (r: { pressure: number }) => void
  /** Off unless a test asks for it, which is a real and common Android phone. */
  hasBarometer?: boolean
} = {}

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
    Barometer: {
      isAvailableAsync: jest.fn(async () => mockState.hasBarometer === true),
      setUpdateInterval: jest.fn(),
      addListener: jest.fn((cb: (reading: { pressure: number }) => void) => {
        mockState.baro = cb
        return { remove: jest.fn() }
      }),
    },
  }
})

const STEP_MS = 20

/** The accelerometer reports a vector. The detector only reads its magnitude. */
const push = (g: number) => mockState.accel?.({ x: 0, y: 0, z: g })
const spin = (rps: number) => mockState.gyro?.({ x: 0, y: 0, z: rps })
const baro = (hPa: number) => mockState.baro?.({ pressure: hPa })

/** Feeds `seconds` of samples, advancing the clock as it goes. */
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

  // Each test gets its own hour. The detector keeps a sixty second cooldown in
  // module state, so tests sharing a clock silently suppress each other's
  // verdicts depending on the order they happen to run in.
  let hour = 0

  beforeEach(() => {
    jest.useFakeTimers()
    hour += 1
    jest.setSystemTime(Date.parse("2026-01-01T00:00:00.000Z") + hour * 3_600_000)
    seed = 1
    mockState.hasBarometer = false
  })

  afterEach(() => {
    stopDriveSensors()
    jest.useRealTimers()
  })

  it("delivers a verdict for the samples it holds even after it has been stopped", async () => {
    // A crashed car reads as "still" to the OS classifier, which stops the
    // sensors inside the very window the verdict is waiting on.
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

  it("judges an impact after the window has been rolling for minutes", async () => {
    // Clear of the cooldown left behind by the verdict above, which is module
    // state that outlives the test that set it.
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    // Several windows worth of driving, so the samples the verdict is read from
    // have been through the compaction the buffer does as it rolls.
    drive(90, road)
    spin(7)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)
    drive(7, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
  })

  it("does not come back believing it is sampling when a stop landed mid-start", async () => {
    // stopTracking and a motion reclassification both reach here, and the start
    // is fire and forget, so a stop can land while it is still awaiting. If the
    // start then published its subscription anyway, every later start would
    // early-return on it and the detector would be dead for the rest of the
    // journey with nothing to say so.
    const pending = startDriveSensors(() => {})
    stopDriveSensors()
    await pending

    expect(driveSensorsRunning()).toBe(false)
    expect(await startDriveSensors(() => {})).toBe(true)
    expect(driveSensorsRunning()).toBe(true)
  })

  it("keeps sampling when the classifier flips back inside the verdict window", async () => {
    // A hard stop can read as "still" for a moment and then as "automotive"
    // again. The stop that arrives in between is held until the verdict lands,
    // and it must not then tear down sensors the app has since re-asked for.
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    drive(6, road)
    spin(7)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)

    stopDriveSensors()
    expect(await startDriveSensors((event) => events.push(event.kind))).toBe(true)

    drive(7, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
    expect(driveSensorsRunning()).toBe(true)
  })

  it("keeps quiet when nothing violent happened", async () => {
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    spin(0.3)
    drive(10, road)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual([])
  })

  it("judges a collision whose worst impact lands after the jolt that started the clock", async () => {
    // Clear of the cooldown left behind by the verdicts above, which is module
    // state that outlives the test that set it.
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    drive(6, road)
    // First contact. Hard enough to start the verdict clock, and not the impact
    // that matters: the car carries on into a barrier a second and a half later.
    spin(2)
    push(1 + 3.5)
    jest.advanceTimersByTime(STEP_MS)
    drive(1.5, road)
    spin(7)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)
    drive(7, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
  })

  it("judges a collision that follows an earlier jolt still inside the window", async () => {
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    drive(2, road)
    // A phone thrown off the seat. Violent, but the car drives on, so the
    // verdict it schedules rightly finds nothing.
    spin(0.4)
    push(1 + 8)
    jest.advanceTimersByTime(STEP_MS)
    drive(10, road)

    // Ten seconds later, a real collision. Smaller at the sensor than the phone
    // that was thrown, because the phone was in free fall and the car was not.
    spin(7)
    push(1 + 5)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)
    drive(7, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
  })

  it("keeps sampling through a stop that lands mid-aftermath, then releases", async () => {
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    drive(6, road)
    spin(7)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    spin(0.05)
    // The stop arrives from the same reclassification the crash caused, so it
    // lands seconds into the aftermath rather than after it.
    drive(2.5, parked)
    stopDriveSensors()

    // Letting go here would discard the stillness the verdict is waiting on,
    // which is the one thing that separates a crash from a dropped phone.
    expect(driveSensorsRunning()).toBe(true)

    drive(5, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
    expect(driveSensorsRunning()).toBe(false)
  })

  it("counts an airbag pressure rise the barometer reports a second after the impact", async () => {
    // iOS discards the requested interval and delivers roughly once a second,
    // so the reading that carries the rise arrives well after the impact.
    mockState.hasBarometer = true
    const events: string[] = []
    await startDriveSensors((event) => events.push(event.kind))

    baro(1013)
    // A frontal impact into something solid. Nothing spins, so the pressure the
    // airbag puts into the cabin is the only thing that can corroborate it.
    spin(0.4)
    drive(6, road)
    push(1 + 9.2)
    jest.advanceTimersByTime(STEP_MS)
    drive(0.9, parked)
    baro(1013.8)
    drive(7, parked)
    jest.advanceTimersByTime(IMPACT.aftermathMs + IMPACT.stillnessMs + 1000)

    expect(events).toEqual(["possibleImpact"])
  })
})

describe("android sampling rate", () => {
  it("asks Android for the permission the requested accelerometer rate needs", () => {
    // Below the 200 ms default Android only speeds a sensor up for an app that
    // declares this, so without it the accelerometer runs at 5 Hz however short
    // an interval driveSensors asks for, and a collision falls between samples.
    expect(appConfig.android.permissions).toContain("android.permission.HIGH_SAMPLING_RATE_SENSORS")
  })
})
