import { describe, expect, it } from "vitest"

import { detectDriveEvent, IMPACT, type DriveSample } from "./impact"

const HZ = 50
const STEP = 1000 / HZ

/** Builds a trace so the shapes below read like the drive they describe. */
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

/**
 * Deterministic noise, so a trace is identical on every run. Several of the
 * tests below turn on vibration rather than on any single reading, and a real
 * accelerometer never returns the same number twice.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff - 0.5
  }
}

/** Road and engine vibration, which is a car under way. */
const ROAD_G = 0.2
const PARKED_G = 0.017

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
    // Violent and spinning, so the loudest signals look bad. The car keeps its
    // speed and keeps moving, which is what saves it.
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
    expect(detectDriveEvent(samples).kind).toBe("possibleImpact")
  })

  it("does not fire on violence alone when the aftermath is unknown", () => {
    // The window is cut off right after the spike, so stillness cannot be read
    // and speed has not been sampled since.
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

  /* ---------------------------------------------------------------- */
  /* The stop is one signal, not two                                   */
  /* ---------------------------------------------------------------- */

  it("does not escalate a junction stop that happens to contain a jolt", () => {
    // Everything an ordinary arrival at a red light produces, plus something
    // heavy shifting in the boot as the car settles. Speed dropping and the car
    // coming to rest are the same fact, so this must not reach the threshold on
    // the strength of both.
    const samples = [
      ...trace(4, cruising(12)),
      { t: 4000, accelG: 1 + 3.5, rotationRps: 0.4, pressure: 1013, speedMps: 4 },
      ...trace(
        2,
        () => ({ accelG: 1 + 0.22, rotationRps: 0.2, pressure: 1013, speedMps: 4 }),
        4020,
      ),
      ...trace(8, stopped, 6020),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("none")
  })

  it("needs a signal beyond the stop even when the stop is unmistakable", () => {
    // A documented gap rather than an oversight: with neither rotation nor a
    // barometer there is nothing here that a phone hitting the footwell as the
    // car pulls up would not also produce.
    const samples = [
      ...trace(4, () => ({ accelG: 1.04, rotationRps: 0.1, speedMps: 27 })),
      { t: 4000, accelG: 1 + 9, rotationRps: 0.3, speedMps: 27 },
      ...trace(8, () => ({ accelG: 1.02, rotationRps: 0.02, speedMps: 0 }), 4500),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  /* ---------------------------------------------------------------- */
  /* Corroboration has to belong to the impact                         */
  /* ---------------------------------------------------------------- */

  it("does not let a roundabout and a hill corroborate a pothole", () => {
    // A descent raises pressure steadily, a roundabout spins the phone, and a
    // pothole eight seconds later provides the spike. Read across the whole
    // buffer all three agree. Read across the impact itself, none of them do.
    const rng = noise(11)
    const descending = (secondsIn: number, speedMps: number, rotationRps: number) => ({
      accelG: 1 + ROAD_G * rng(),
      rotationRps,
      pressure: 1010 + (3 * secondsIn) / 20,
      speedMps,
    })
    const samples = [
      ...trace(3, (s) => descending(s, 15, 0.3)),
      // The roundabout, well before the spike.
      ...trace(2, (s) => descending(3 + s, 9, 4.0), 3000),
      ...trace(5, (s) => descending(5 + s, 15, 0.3), 5000),
      { t: 10000, accelG: 1 + 4.6, rotationRps: 0.5, pressure: 1011.5, speedMps: 15 },
      // Then it pulls up at a light, so the stop is genuinely there.
      ...trace(2, (s) => descending(10 + s, 3, 0.2), 10020),
      ...trace(
        8,
        () => ({ accelG: 1 + PARKED_G * rng(), rotationRps: 0.05, pressure: 1013, speedMps: 0 }),
        12020,
      ),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("none")
  })

  it("does not let a phone tumbling off the seat corroborate its own spike", () => {
    // A hard stop at a red light, and the phone slides off the passenger seat
    // into the footwell as the car settles. The spike and the spin are one
    // event: a phone loose enough to land at 7.5 g is loose enough to tumble on
    // the way down, so its rotation carries nothing the spike did not already
    // carry. The same stop with the phone in a cradle is the control.
    const atTheLight = (): Omit<DriveSample, "t"> => ({
      accelG: 1 + 0.02,
      rotationRps: 0.05,
      pressure: 1013,
      speedMps: 0,
    })
    const pullingUp = (rotationRps: number): DriveSample[] => [
      ...trace(4, cruising(12)),
      ...trace(
        1.5,
        () => ({ accelG: 1 + 0.3, rotationRps: 0.2, pressure: 1013, speedMps: 5 }),
        4000,
      ),
      { t: 5500, accelG: 1 + 7.5, rotationRps, pressure: 1013, speedMps: 0 },
      ...trace(9, atTheLight, 5520),
    ]
    expect(detectDriveEvent(pullingUp(0.4)).kind).toBe("none")
    expect(detectDriveEvent(pullingUp(9)).kind).toBe("none")
  })

  it("does not let a phone tumbling while the car is still rolling corroborate its own spike", () => {
    // The same slide off the seat, but a moment earlier, while the car is still
    // creeping towards the line. The check above cannot help here because the
    // vehicle genuinely was moving. What rules it out is that a car doing 5 m/s
    // cannot be spun at 9 rad/s: only the phone can rotate that fast down there.
    const rollingUp = (rotationRps: number): DriveSample[] => [
      ...trace(4, cruising(12)),
      ...trace(
        1.5,
        () => ({ accelG: 1 + 0.3, rotationRps: 0.2, pressure: 1013, speedMps: 5 }),
        4000,
      ),
      { t: 5500, accelG: 1 + 7.5, rotationRps, pressure: 1013, speedMps: 5 },
      // Flat pressure throughout, so rotation is the only thing on offer.
      ...trace(
        9,
        () => ({ accelG: 1 + 0.02, rotationRps: 0.05, pressure: 1013, speedMps: 0 }),
        5520,
      ),
    ]
    expect(detectDriveEvent(rollingUp(0.4)).kind).toBe("none")
    expect(detectDriveEvent(rollingUp(9)).kind).toBe("none")
  })

  it("does not let a hill supply the pressure rise an airbag is meant to", () => {
    // A steep descent at 38 km/h, a cattle grid for the spike, and a hairpin at
    // the bottom for the stop. The cabin never pressurises. The pressure climbs
    // at a steady 0.25 hPa per second the whole way down, before the spike and
    // through it, and a steady climb is what a descent looks like rather than
    // what an airbag looks like.
    const rng = noise(23)
    const RATE_HPA_PER_S = 0.25
    const descending = (secondsIn: number, speedMps: number) => ({
      accelG: 1 + ROAD_G * rng(),
      rotationRps: 0.3,
      pressure: 1010 + RATE_HPA_PER_S * secondsIn,
      speedMps,
    })
    const samples = [
      ...trace(6, (s) => descending(s, 10.6)),
      {
        t: 6000,
        accelG: 1 + 3.5,
        rotationRps: 0.5,
        pressure: 1010 + RATE_HPA_PER_S * 6,
        speedMps: 10.6,
      },
      ...trace(0.62, (s) => descending(6 + s, 10.6), 6020),
      // Braking to a halt at the hairpin, still losing height as it slows.
      ...trace(
        1.86,
        (s) => ({
          accelG: 1 + 0.59,
          rotationRps: 0.3,
          pressure: 1011.66 + 0.12 * s,
          speedMps: Math.max(0, 10.6 - 5.76 * s),
        }),
        6640,
      ),
      ...trace(
        8,
        () => ({ accelG: 1 + PARKED_G * rng(), rotationRps: 0.05, pressure: 1011.88, speedMps: 0 }),
        8500,
      ),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  /* ---------------------------------------------------------------- */
  /* Vibration, for the many seconds when GPS has nothing to say       */
  /* ---------------------------------------------------------------- */

  it("catches a crash with no GPS speed at all, on vibration alone", () => {
    // Between deferred location batches every sample carries no speed. The car
    // shaking beforehand and not shaking afterwards is the whole signal.
    const rng = noise(3)
    const samples = [
      ...trace(6, () => ({ accelG: 1 + ROAD_G * rng(), rotationRps: 0.3, pressure: 1013 })),
      { t: 6000, accelG: 1 + 9.2, rotationRps: 7, pressure: 1014.3 },
      ...trace(0.4, () => ({ accelG: 1 + 1.1, rotationRps: 2.2, pressure: 1014.1 }), 6020),
      ...trace(
        8,
        () => ({ accelG: 1 + PARKED_G * rng(), rotationRps: 0.03, pressure: 1014 }),
        6500,
      ),
    ]
    const event = detectDriveEvent(samples)
    expect(event.kind).toBe("possibleImpact")
    if (event.kind === "possibleImpact") expect(event.speedDropMps).toBeNull()
  })

  it("ignores a phone landing in the footwell of a car that is still driving", () => {
    // The phone is motionless, so every stillness test above passes. What it
    // cannot escape is the road coming up through the floor.
    const rng = noise(7)
    const samples = [
      ...trace(6, () => ({ accelG: 1 + ROAD_G * rng(), rotationRps: 0.3, pressure: 1013 })),
      { t: 6000, accelG: 1 + 8, rotationRps: 9, pressure: 1013 },
      // Lying still on the mat, but the car has not stopped.
      ...trace(8, () => ({ accelG: 1 + 0.13 * rng(), rotationRps: 0.1, pressure: 1013 }), 6100),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  it("ignores a door slammed on a parked car, pressure rise and all", () => {
    // Nothing was moving before it, so nothing came to rest after it. Without
    // that check the cabin pressurising is a free corroboration.
    const rng = noise(5)
    const parked = (pressure: number) => () => ({
      accelG: 1 + PARKED_G * rng(),
      rotationRps: 0.02,
      pressure,
    })
    const samples = [
      ...trace(6, parked(1013)),
      { t: 6000, accelG: 1 + 4, rotationRps: 1.1, pressure: 1013.7 },
      ...trace(8, parked(1013.6), 6020),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  it("detects the same crash whatever the road before it was like", () => {
    // Identical impact, identical aftermath, and only the roughness of the run
    // up changes. How rough the road was says nothing about what disturbs a
    // wreck once it has stopped, so it must not decide whether the crash is
    // reported at all.
    const outcomes = [0.05, 0.1, 0.2, 0.3, 0.5].map((roadG) => {
      const rng = noise(29)
      const samples = [
        ...trace(6, () => ({
          accelG: 1 + roadG * rng(),
          rotationRps: 0.3,
          pressure: 1013,
          speedMps: 27,
        })),
        { t: 6000, accelG: 1 + 15, rotationRps: 8, pressure: 1013.9, speedMps: 27 },
        ...trace(
          8,
          () => ({ accelG: 1 + 0.1 * rng(), rotationRps: 0.03, pressure: 1013.9, speedMps: 0 }),
          6500,
        ),
      ]
      return `road ${roadG} g: ${detectDriveEvent(samples).kind}`
    })
    expect(outcomes).toEqual([
      "road 0.05 g: possibleImpact",
      "road 0.1 g: possibleImpact",
      "road 0.2 g: possibleImpact",
      "road 0.3 g: possibleImpact",
      "road 0.5 g: possibleImpact",
    ])
  })

  it("ignores a door slammed on a parked car that was jostled a moment before", () => {
    // The same parked car, with a bag dropped onto the back seat two seconds
    // before the door goes. Nothing was moving for either event, and the proof
    // of that is the same in both cases. But one 0.5 g sample lands inside the
    // run up window, and a standard deviation cannot tell one shove from six
    // seconds of road, so the handbrake reads as a motorway.
    const rng = noise(31)
    const parked = (pressure: number) => () => ({
      accelG: 1 + PARKED_G * rng(),
      rotationRps: 0.02,
      pressure,
    })
    const samples = [
      ...trace(6, parked(1013)),
      { t: 6000, accelG: 1 + 0.5, rotationRps: 0.06, pressure: 1013 },
      ...trace(2, parked(1013), 6020),
      { t: 8000, accelG: 1 + 4, rotationRps: 1.1, pressure: 1013.7 },
      ...trace(8, parked(1013.6), 8020),
    ]
    expect(detectDriveEvent(samples).kind).toBe("none")
  })

  /* ---------------------------------------------------------------- */
  /* A wreck is not a clean room                                       */
  /* ---------------------------------------------------------------- */

  it("still reports a crash when one sample of the aftermath is disturbed", () => {
    // Everything the stillness test asks for is there: six seconds of tail and
    // resting vibration far below IMPACT.restNoiseG. The only difference from
    // the crash the suite already reports is one 0.25 g sample four seconds
    // after the impact, which is a door being forced or somebody reaching for
    // the phone.
    const crash = (): DriveSample[] => {
      const rng = noise(17)
      return [
        ...trace(6, () => ({
          accelG: 1 + ROAD_G * rng(),
          rotationRps: 0.3,
          pressure: 1013,
          speedMps: 27,
        })),
        { t: 6000, accelG: 1 + 9.2, rotationRps: 7, pressure: 1014.3, speedMps: 27 },
        ...trace(
          8,
          () => ({ accelG: 1 + PARKED_G * rng(), rotationRps: 0.03, pressure: 1014, speedMps: 0 }),
          6500,
        ),
      ]
    }
    expect(detectDriveEvent(crash()).kind).toBe("possibleImpact")
    const disturbed = crash().map((s) => (s.t === 10000 ? { ...s, accelG: 1 + 0.25 } : s))
    expect(detectDriveEvent(disturbed).kind).toBe("possibleImpact")
  })
})
