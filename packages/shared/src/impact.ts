/**
 * Crash detection from the sensors a phone will actually give a third party.
 *
 * The honest limit worth stating up front: iOS caps third party accelerometers
 * near 16g and a real collision goes past that, so the sensor saturates. We can
 * tell that something violent happened. We cannot tell how bad it was. Every
 * name in here says "possible" for that reason.
 *
 * The value is not in spotting a spike, which is easy. It is in refusing to
 * shout about the many spikes that are not crashes: a phone sliding off a seat,
 * a pothole, a slammed door. So the shape of the whole incident has to fit:
 *
 *   1. the vehicle was travelling before it   (wasMoving)
 *   2. it is not travelling afterwards        (cameToRest)
 *   3. and something other than the spike itself agrees that it was a collision
 *
 * The first two are necessary, not corroborating. Both are read from the same
 * fact (whether the car is moving), so counting them separately is how a hard
 * stop at a junction with a jolt in it turns into an SOS. They are one signal,
 * and on their own they describe every ordinary arrival at a red light.
 *
 * The deliberate gap: a collision with neither rotation nor a pressure rise,
 * on a phone with no barometer, is not reported. That combination is rare (a
 * loose phone tumbles and most phones have a barometer), and the alternative
 * is promoting the spike itself to its own corroboration, which cannot tell a
 * crash from a phone hitting the footwell as the car pulls up.
 */

/** Sampling and units are the caller's problem. */
export interface DriveSample {
  /** Milliseconds since epoch. */
  t: number
  /** Resultant accelerometer magnitude in g, gravity included, so 1 at rest. */
  accelG: number
  /** Resultant rotation rate in radians per second. */
  rotationRps?: number
  /** Barometric pressure in hPa. Absent on devices without the sensor. */
  pressure?: number
  /**
   * Ground speed in metres per second, and only when the fix it came from was
   * contemporaneous with the sample. A GPS fix that arrived a minute ago says
   * nothing about this instant, and carrying it forward is worse than having
   * no speed at all: it reads as a confident answer.
   */
  speedMps?: number | null
}

export type DriveEvent =
  | { kind: "none" }
  | { kind: "harshBrake"; at: number; peakDeltaG: number }
  | {
      kind: "possibleImpact"
      at: number
      peakDeltaG: number
      rotationRps: number
      pressureJumpHpa: number | null
      /** Reported for the record. Never counted, see the note above. */
      speedDropMps: number | null
      /** Signals agreeing beyond "the vehicle stopped". */
      corroborations: number
    }

/**
 * Thresholds. Deliberately conservative, because the cost of crying wolf here
 * is that a family stops believing the one alert that matters.
 */
export const IMPACT = {
  /** Sustained deceleration worth noting on a driving report. */
  harshBrakeG: 0.35,
  /** Below this a spike is road noise, not a candidate for anything. */
  impactG: 3,
  /** A spin, not a swerve. */
  rotationRps: 3.5,
  /**
   * Below this, a spin at rotationRps would have the car turning faster than it
   * is travelling, which no car in traffic does. A phone tumbling through the
   * cabin does it every time, so under this speed the gyroscope is describing
   * the phone rather than the vehicle.
   */
  spinSpeedMps: 7,
  /** An airbag firing pressurises the cabin. */
  pressureJumpHpa: 0.25,
  /** Above this the phone is still being moved about, so nothing came to rest. */
  stillDeltaG: 0.18,
  /** A crash is followed by a car that has stopped. */
  stillnessMs: 4000,
  /** Walking pace. Wherever speed is known, stopping has to agree with it. */
  restSpeedMps: 1.5,
  /**
   * Vibration, as the spread of accelerometer magnitude (see jitterG). A
   * vehicle under way shakes even when its speed is steady, and that shaking is
   * what separates "stopped" from "cruising smoothly" on a phone whose GPS has
   * not reported for a minute. Below restNoiseG the surroundings are at rest.
   * Above it, something is running.
   */
  restNoiseG: 0.042,
  driveNoiseG: 0.02,
  /**
   * How much of the stillness afterwards may be disturbed and still count.
   * Demanding every sample made one knock enough to discard a real crash.
   */
  restDisturbedRatio: 0.05,
  /** How long after the peak the corroborating signals are allowed to arrive. */
  aftermathMs: 2500,
  /** Without a signal beyond the stop, the stop is counted twice. */
  requiredCorroborations: 1,
} as const

/** Rotation is read from here to just past the peak, never the whole buffer. */
const IMPACT_LEAD_MS = 500
/** An airbag pressurises the cabin in milliseconds. Climbing a hill does not. */
const PRESSURE_BASELINE_MS = 1000
// Wide enough for a barometer that reports about once a second, which is what
// iOS gives whatever interval is asked for. At 600ms the airbag rise landed
// between two samples and was never seen. The slope subtraction in
// pressureJump is what keeps a descent from filling a window this wide.
const PRESSURE_STEP_MS = 1800
/** The run up, less RUN_UP_GAP_MS, in which the impact is already happening. */
const RUN_UP_MS = 6000
const RUN_UP_GAP_MS = 500
/** How close to the impact a speed reading has to be to describe that moment. */
const SPEED_AT_IMPACT_MS = 2000

const deltaG = (sample: DriveSample): number => Math.abs(sample.accelG - 1)

const speeds = (samples: DriveSample[]): number[] =>
  samples.map((s) => s.speedMps).filter((v): v is number => v != null)

/**
 * Spread of magnitude, which is vibration with gravity and the phone's resting
 * orientation subtracted out by construction.
 */
function jitterG(samples: DriveSample[]): number {
  if (samples.length < 2) return 0
  // Median absolute deviation rather than standard deviation. One bag dropped
  // on the back seat is a single huge squared term, and it dragged the run up
  // of a parked car above the threshold that means "this vehicle was driving".
  // Scaled by 1.4826 so that on normal noise it reads the same as before.
  const values = samples.map((s) => s.accelG).sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]!
  const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
  return deviations[Math.floor(deviations.length / 2)]! * 1.4826
}

/**
 * Expects a window that already contains the aftermath, not just the moment.
 * Stillness is the strongest signal available and it can only be read after the
 * fact, so the caller has to hold the window open for a few seconds before
 * asking. That delay is not a cost: nobody should be alerted before we know
 * whether the car carried on driving.
 */
export function detectDriveEvent(samples: DriveSample[]): DriveEvent {
  if (samples.length < 3) return { kind: "none" }

  const ordered = [...samples].sort((a, b) => a.t - b.t)
  let peak = ordered[0]!
  for (const sample of ordered) {
    if (deltaG(sample) > deltaG(peak)) peak = sample
  }

  const peakDeltaG = deltaG(peak)
  if (peakDeltaG < IMPACT.harshBrakeG) return { kind: "none" }

  const before = ordered.filter((sample) => sample.t < peak.t)
  const after = ordered.filter((sample) => sample.t > peak.t)

  if (peakDeltaG < IMPACT.impactG) {
    // Not violent enough to be an impact. It is only worth reporting if the car
    // actually shed speed, which separates braking from a bump in the road.
    const drop = speedDrop(before, after)
    return drop !== null && drop > 0
      ? { kind: "harshBrake", at: peak.t, peakDeltaG }
      : { kind: "none" }
  }

  // The vibration of the vehicle before the impact, measured clear of the
  // impact itself, is the yardstick everything about the aftermath is read
  // against.
  const runUp = before.filter(
    (s) => peak.t - s.t >= RUN_UP_GAP_MS && peak.t - s.t <= RUN_UP_MS + RUN_UP_GAP_MS,
  )
  const baselineJitter = jitterG(runUp.length >= 2 ? runUp : before)

  const priorSpeeds = speeds(before)
  const wasMoving =
    (priorSpeeds.length > 0 && Math.max(...priorSpeeds) > IMPACT.restSpeedMps) ||
    baselineJitter >= IMPACT.driveNoiseG
  if (!wasMoving) return { kind: "none" }

  // Moving when it was hit, not merely at some point beforehand. A phone that
  // slides into the footwell as the car settles at a red light spikes hard and
  // spins, and its spin says nothing the spike did not already say. What
  // separates that from a collision is that the vehicle had already stopped.
  const atImpact = [...before, peak]
    .reverse()
    .find((s) => s.speedMps != null && peak.t - s.t <= SPEED_AT_IMPACT_MS)
  if (atImpact && atImpact.speedMps! <= IMPACT.restSpeedMps) return { kind: "none" }

  if (!cameToRest(after, peak.t, baselineJitter)) return { kind: "none" }

  const window = after.filter((sample) => sample.t - peak.t <= IMPACT.aftermathMs)
  const impactSlice = ordered.filter(
    (s) => s.t >= peak.t - IMPACT_LEAD_MS && s.t - peak.t <= IMPACT.aftermathMs,
  )
  const rotation = Math.max(0, ...impactSlice.map((sample) => sample.rotationRps ?? 0))
  const pressureJumpHpa = pressureJump(ordered, peak.t)

  // A phone loose enough to spike at impactG is loose enough to tumble, and a
  // tumble spins several times faster than any car, so on a slow vehicle the
  // rotation channel is the spike itself wearing a second hat. Where the speed
  // at the impact is unknown this still counts: with GPS silent, refusing it
  // would leave a barometer-less phone with no way to report a crash at all.
  const couldHaveSpun = !atImpact || atImpact.speedMps! >= IMPACT.spinSpeedMps

  const corroborations = [
    couldHaveSpun && rotation >= IMPACT.rotationRps,
    pressureJumpHpa !== null && pressureJumpHpa >= IMPACT.pressureJumpHpa,
  ].filter(Boolean).length

  if (corroborations < IMPACT.requiredCorroborations) return { kind: "none" }

  return {
    kind: "possibleImpact",
    at: peak.t,
    peakDeltaG,
    rotationRps: rotation,
    pressureJumpHpa,
    speedDropMps: speedDrop(before, window),
    corroborations,
  }
}

/**
 * GPS updates about once a second at best and lags a sudden stop, so this
 * compares the fastest reading before the peak with the slowest after it rather
 * than trusting any single sample. Reported, not decisive.
 */
function speedDrop(before: DriveSample[], after: DriveSample[]): number | null {
  const priorSpeeds = speeds(before)
  const laterSpeeds = speeds(after)
  if (priorSpeeds.length === 0 || laterSpeeds.length === 0) return null
  return Math.max(...priorSpeeds) - Math.min(...laterSpeeds)
}

/**
 * An airbag pressurises the cabin within milliseconds. Driving downhill also
 * raises the pressure, steadily, and a plain before-and-after difference cannot
 * tell the two apart: a long enough descent clears any fixed threshold on its
 * own. So the slope the cabin already had is measured first and subtracted,
 * and what is left is the part the descent does not explain.
 */
function pressureJump(ordered: DriveSample[], peakAt: number): number | null {
  const readings = ordered
    .filter((s) => s.pressure != null)
    .map((s) => ({ t: s.t, p: s.pressure! }))
  const baseline = readings.filter((r) => peakAt - r.t > 0 && peakAt - r.t <= PRESSURE_BASELINE_MS)
  const step = readings.filter((r) => r.t >= peakAt && r.t - peakAt <= PRESSURE_STEP_MS)
  if (baseline.length === 0 || step.length === 0) return null

  const mean = baseline.reduce((sum, r) => sum + r.p, 0) / baseline.length
  const meanT = baseline.reduce((sum, r) => sum + r.t, 0) / baseline.length
  const raw = Math.max(...step.map((r) => r.p)) - mean

  // Slope over the run up, in hPa per millisecond, by least squares. Two
  // readings cannot establish a trend, so with fewer the raw rise stands.
  if (baseline.length < 3) return raw
  let num = 0
  let den = 0
  for (const r of baseline) {
    num += (r.t - meanT) * (r.p - mean)
    den += (r.t - meanT) ** 2
  }
  if (den === 0) return raw
  const slope = num / den
  const peakOfStep = step.reduce((best, r) => (r.p > best.p ? r : best), step[0]!)
  const expected = slope * (peakOfStep.t - meanT)
  return raw - expected
}

/**
 * The signal a dropped phone never produces: after a crash the vehicle is not
 * moving. Requires the window to actually cover the stillness period, otherwise
 * it answers false rather than guessing.
 */
function cameToRest(after: DriveSample[], peakAt: number, baselineJitter: number): boolean {
  const tail = after.filter((sample) => sample.t - peakAt >= IMPACT.aftermathMs)
  if (tail.length === 0) return false
  const covered = tail[tail.length - 1]!.t - tail[0]!.t
  if (covered < IMPACT.stillnessMs) return false
  // Not every sample: a single knock while somebody reaches for their phone,
  // or one dropped reading, should not undo an otherwise still tail. The
  // vibration test below is what actually decides whether the vehicle moved.
  const disturbed = tail.filter((sample) => deltaG(sample) >= IMPACT.stillDeltaG).length
  if (disturbed > Math.max(1, Math.floor(tail.length * IMPACT.restDisturbedRatio))) return false

  // A phone that has come to rest on the floor of a car that is still driving
  // reads as motionless to everything above, because it is: it is the vehicle
  // that is moving. What it cannot hide is the vehicle's vibration, which is
  // still coming through the floor.
  //
  // The test is absolute rather than relative to the run up. A stopped vehicle
  // shakes about the same amount whatever road it had been on, so comparing
  // the two let road roughness decide whether a crash was reported, and the
  // same impact was found on a smooth road and missed on a moderate one.
  const restJitter = jitterG(tail)
  if (restJitter > IMPACT.restNoiseG) return false

  const tailSpeeds = speeds(tail)
  if (tailSpeeds.length > 0 && Math.max(...tailSpeeds) > IMPACT.restSpeedMps) return false
  return true
}
