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
 * fact — whether the car is moving — so counting them separately is how a hard
 * stop at a junction with a jolt in it turns into an SOS. They are one signal,
 * and on their own they describe every ordinary arrival at a red light.
 *
 * The deliberate gap: a collision with neither rotation nor a pressure rise,
 * on a phone with no barometer, is not reported. That combination is rare — a
 * loose phone tumbles and most phones have a barometer — and the alternative is
 * promoting the spike itself to its own corroboration, which cannot tell a
 * crash from a phone hitting the footwell as the car pulls up.
 */

/** One moment of a drive. Sampling and units are the caller's problem. */
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
      /** Signals agreeing beyond "the vehicle stopped". One is the threshold. */
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
  /** Roughly 20 km/h lost, which no pothole causes. */
  speedDropMps: 5.5,
  /** About 200 degrees per second. A spin, not a swerve. */
  rotationRps: 3.5,
  /** An airbag firing pressurises the cabin. */
  pressureJumpHpa: 0.25,
  /** Above this the phone is still being moved about, so nothing came to rest. */
  stillDeltaG: 0.18,
  /** A crash is followed by a car that has stopped. */
  stillnessMs: 4000,
  /** Walking pace. Wherever speed is known, stopping has to agree with it. */
  restSpeedMps: 1.5,
  /**
   * Vibration, as the standard deviation of accelerometer magnitude. A vehicle
   * under way shakes even when its speed is steady, and that shaking is what
   * separates "stopped" from "cruising smoothly" on a phone whose GPS has not
   * reported for a minute. Below the first figure the surroundings are at rest;
   * above it something is running.
   */
  restNoiseG: 0.05,
  driveNoiseG: 0.02,
  /** And the shaking has to have collapsed, not merely be lowish. */
  restNoiseRatio: 0.35,
  /** How long after the peak the corroborating signals are allowed to arrive. */
  aftermathMs: 2500,
  /** One signal beyond the stop. Anything less is the stop counted twice. */
  requiredCorroborations: 1,
} as const

/** Rotation is read from here to just past the peak, never the whole buffer. */
const IMPACT_LEAD_MS = 500
/** An airbag pressurises the cabin in milliseconds. Climbing a hill does not. */
const PRESSURE_BASELINE_MS = 1000
const PRESSURE_STEP_MS = 600
/** The run up, less the half second in which the impact is already happening. */
const RUN_UP_MS = 6000
const RUN_UP_GAP_MS = 500

const deltaG = (sample: DriveSample): number => Math.abs(sample.accelG - 1)

const speeds = (samples: DriveSample[]): number[] =>
  samples.map((s) => s.speedMps).filter((v): v is number => v != null)

/**
 * Standard deviation of magnitude, which is vibration with gravity and the
 * phone's resting orientation subtracted out by construction.
 */
function jitterG(samples: DriveSample[]): number {
  if (samples.length < 2) return 0
  const mean = samples.reduce((sum, s) => sum + s.accelG, 0) / samples.length
  const variance = samples.reduce((sum, s) => sum + (s.accelG - mean) ** 2, 0) / samples.length
  return Math.sqrt(variance)
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
  if (!cameToRest(after, peak.t, baselineJitter)) return { kind: "none" }

  const window = after.filter((sample) => sample.t - peak.t <= IMPACT.aftermathMs)
  const impactSlice = ordered.filter(
    (s) => s.t >= peak.t - IMPACT_LEAD_MS && s.t - peak.t <= IMPACT.aftermathMs,
  )
  const rotation = Math.max(0, ...impactSlice.map((sample) => sample.rotationRps ?? 0))
  const pressureJumpHpa = pressureJump(ordered, peak.t)

  const corroborations = [
    rotation >= IMPACT.rotationRps,
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
 * An airbag pressurises the cabin within milliseconds, so the baseline is the
 * second before the peak and the rise has to land in the fraction of a second
 * after it. Measured against the whole buffer instead, a couple of metres of
 * elevation lost on a hill clears the threshold on its own.
 */
function pressureJump(ordered: DriveSample[], peakAt: number): number | null {
  const baselineWindow = ordered.filter(
    (s) => peakAt - s.t > 0 && peakAt - s.t <= PRESSURE_BASELINE_MS,
  )
  const stepWindow = ordered.filter((s) => s.t >= peakAt && s.t - peakAt <= PRESSURE_STEP_MS)
  const priorPressures = baselineWindow.map((s) => s.pressure).filter((v): v is number => v != null)
  const laterPressures = stepWindow.map((s) => s.pressure).filter((v): v is number => v != null)
  if (priorPressures.length === 0 || laterPressures.length === 0) return null
  const baseline = priorPressures.reduce((sum, v) => sum + v, 0) / priorPressures.length
  return Math.max(...laterPressures) - baseline
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
  if (!tail.every((sample) => deltaG(sample) < IMPACT.stillDeltaG)) return false

  // A phone that has come to rest on the floor of a car that is still driving
  // reads as motionless to everything above, because it is: it is the vehicle
  // that is moving. What it cannot hide is the vehicle's vibration, which is
  // still coming through the floor.
  const restJitter = jitterG(tail)
  if (restJitter > IMPACT.restNoiseG) return false
  if (baselineJitter >= IMPACT.driveNoiseG && restJitter > baselineJitter * IMPACT.restNoiseRatio) {
    return false
  }

  const tailSpeeds = speeds(tail)
  if (tailSpeeds.length > 0 && Math.max(...tailSpeeds) > IMPACT.restSpeedMps) return false
  return true
}
