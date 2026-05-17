import { describe, expect, it } from "vitest"

import { detectDriveEvent, IMPACT, type DriveSample } from "./impact"

const HZ = 50
const STEP = 1000 / HZ

/** Builds a trace at 50Hz so the shapes below read like the drive they describe. */
function trace(
  seconds: number,
  at: (secondsIn: number) => Omit<DriveSample, "t">,
  startAt = 0,
): DriveSample[] {
  const samples: DriveSample[] = []
  for (let ms = 0; ms < seconds * 1000; ms += STEP) {
    samples.push({ t: startAt + ms, ...at(ms / 1000) })
  }
  return samples
}

/** Engine and road noise around 1g. */
const cruising = (speedMps: number) => (): Omit<DriveSample, "t"> => ({
  accelG: 1 + 0.04,
  rotationRps: 0.2,
  pressure: 1013,
  speedMps,
})

const stopped = (): Omit<DriveSample, "t"> => ({
  accelG: 1 + 0.02,
  rotationRps: 0.05,
  pressure: 1013.4,
  speedMps: 0,
})

describe("detectDriveEvent", () => {
  it("says nothing about an ordinary drive", () => {
    expect(detectDriveEvent(trace(10, cruising(25))).kind).toBe("none")
  })

  it("ignores too short a window rather than guessing", () => {
    expect(detectDriveEvent([{ t: 0, accelG: 9 }]).kind).toBe("none")
    expect(detectDriveEvent([]).kind).toBe("none")
  })

  it("ignores a pothole, because the car drives on", () => {
    const samples = [
      ...trace(3, cruising(25)),
      { t: 3000, accelG: 1 + 4.2, rotationRps: 0.9, pressure: 1013, speedMps: 25 },
      ...trace(6, cruising(24.5), 3020),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  it("ignores a phone thrown off the seat, which spikes and rotates but changes nothing", () => {
    // Violent and spinning, so two of the four signals look bad. The car keeps
    // its speed and keeps moving, which is what saves it.
    const samples = [
      ...trace(3, cruising(25)),
      { t: 3000, accelG: 1 + 7.5, rotationRps: 9, pressure: 1013, speedMps: 25 },
      ...trace(8, cruising(24.8), 3020),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  it("reports harsh braking when speed is shed without violence", () => {
    const samples = [
      ...trace(3, cruising(22)),
      ...trace(
        1.5,
        () => ({ accelG: 1 + 0.55, rotationRps: 0.3, pressure: 1013, speedMps: 8 }),
        3000,
      ),
      ...trace(3, cruising(8), 4500),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("harshBrake")
    if (event.kind === "harshBrake") expect(event.peakDeltaG).toBeCloseTo(0.55, 2)
  })

  it("reports a possible impact when the violence is followed by a stopped car", () => {
    const samples = [
      ...trace(4, cruising(27)),
      { t: 4000, accelG: 1 + 8.4, rotationRps: 6.2, pressure: 1013.9, speedMps: 27 },
      ...trace(
        0.4,
        () => ({ accelG: 1 + 1.2, rotationRps: 2, pressure: 1013.8, speedMps: 4 }),
        4020,
      ),
      ...trace(8, stopped, 4500),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("possibleImpact")
    if (event.kind === "possibleImpact") {
      expect(event.corroborations).toBeGreaterThanOrEqual(IMPACT.requiredCorroborations)
      expect(event.speedDropMps).toBeGreaterThanOrEqual(IMPACT.speedDropMps)
      expect(event.rotationRps).toBeGreaterThanOrEqual(IMPACT.rotationRps)
    }
  })

  it("still catches a crash on a phone with no barometer", () => {
    const noBaro = (speedMps: number) => (): Omit<DriveSample, "t"> => ({
      accelG: 1.04,
      rotationRps: 0.2,
      speedMps,
    })
    const samples = [
      ...trace(4, noBaro(27)),
      { t: 4000, accelG: 1 + 9, rotationRps: 6.5, speedMps: 27 },
      ...trace(8, () => ({ accelG: 1.02, rotationRps: 0.04, speedMps: 0 }), 4500),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("possibleImpact")
  })

  it("does not fire on violence alone when the aftermath is unknown", () => {
    // The window is cut off right after the spike, so stillness cannot be read
    // and speed has not been sampled since. One signal is not enough.
    const samples = [
      ...trace(4, cruising(27)),
      { t: 4000, accelG: 1 + 8.4, rotationRps: 0.5, pressure: 1013, speedMps: 27 },
      { t: 4020, accelG: 1.1, rotationRps: 0.4, pressure: 1013, speedMps: 27 },
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  it("does not mistake a slow stop at a junction for an impact", () => {
    const samples = [
      ...trace(4, cruising(12)),
      ...trace(
        2,
        () => ({ accelG: 1 + 0.22, rotationRps: 0.2, pressure: 1013, speedMps: 4 }),
        4000,
      ),
      ...trace(8, stopped, 6000),
    ]
    expect(detectDriveEvent(samples).kind).not.toBe("possibleImpact")
  })
})
