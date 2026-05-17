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
 * a pothole, a slammed door. So a spike alone is never enough. It has to be
 * corroborated by the things that follow a real impact and follow nothing else.
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
  /** Ground speed in metres per second from the last GPS fix, when there was one. */
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
      speedDropMps: number | null
      /** How many independent signals agreed. Two is the threshold. */
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
  /** Above this the phone is still moving, so nothing came to rest. */
  stillDeltaG: 0.18,
  /** A crash is followed by a car that has stopped. */
  stillnessMs: 4000,
  /** Walking pace. Smooth cruising reads as still to an accelerometer, so
   * stopping has to be confirmed by speed wherever speed is known. */
  restSpeedMps: 1.5,
  /** How long after the peak the corroborating signals are allowed to arrive. */
  aftermathMs: 2500,
  /** Two independent signals. One is a coincidence. */
  requiredCorroborations: 2,
} as const

const deltaG = (sample: DriveSample): number => Math.abs(sample.accelG - 1)

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

  const window = after.filter((sample) => sample.t - peak.t <= IMPACT.aftermathMs)
  const speedDropMps = speedDrop(before, window)
  const rotation = Math.max(0, ...ordered.map((sample) => sample.rotationRps ?? 0))
  const pressureJumpHpa = pressureJump(before, window)

  const corroborations = [
    speedDropMps !== null && speedDropMps >= IMPACT.speedDropMps,
    rotation >= IMPACT.rotationRps,
    pressureJumpHpa !== null && pressureJumpHpa >= IMPACT.pressureJumpHpa,
    cameToRest(after, peak.t),
  ].filter(Boolean).length

  if (corroborations < IMPACT.requiredCorroborations) return { kind: "none" }

  return {
    kind: "possibleImpact",
    at: peak.t,
    peakDeltaG,
    rotationRps: rotation,
    pressureJumpHpa,
    speedDropMps,
    corroborations,
  }
}

/**
 * GPS updates about once a second and lags a sudden stop, so this compares the
 * fastest reading before the peak with the slowest after it rather than trusting
 * any single sample.
 */
function speedDrop(before: DriveSample[], after: DriveSample[]): number | null {
  const priorSpeeds = before.map((s) => s.speedMps).filter((v): v is number => v != null)
  const laterSpeeds = after.map((s) => s.speedMps).filter((v): v is number => v != null)
  if (priorSpeeds.length === 0 || laterSpeeds.length === 0) return null
  return Math.max(...priorSpeeds) - Math.min(...laterSpeeds)
}

/** An airbag pressurises the cabin, so only a rise counts. */
function pressureJump(before: DriveSample[], after: DriveSample[]): number | null {
  const priorPressures = before.map((s) => s.pressure).filter((v): v is number => v != null)
  const laterPressures = after.map((s) => s.pressure).filter((v): v is number => v != null)
  if (priorPressures.length === 0 || laterPressures.length === 0) return null
  const baseline = priorPressures.reduce((sum, v) => sum + v, 0) / priorPressures.length
  return Math.max(...laterPressures) - baseline
}

/**
 * The single most useful signal, and the one a dropped phone never produces:
 * after a crash the vehicle is not moving. Requires the window to actually
 * cover the stillness period, otherwise it answers false rather than guessing.
 */
function cameToRest(after: DriveSample[], peakAt: number): boolean {
  const tail = after.filter((sample) => sample.t - peakAt >= IMPACT.aftermathMs)
  if (tail.length === 0) return false
  const covered = tail[tail.length - 1]!.t - tail[0]!.t
  if (covered < IMPACT.stillnessMs) return false
  if (!tail.every((sample) => deltaG(sample) < IMPACT.stillDeltaG)) return false

  // A car holding a steady speed produces almost no change in acceleration, so
  // on its own the accelerometer cannot tell cruising from parked. Without this
  // a phone thrown off the seat mid journey looks exactly like a crash.
  const speeds = tail.map((sample) => sample.speedMps).filter((v): v is number => v != null)
  if (speeds.length > 0 && Math.max(...speeds) > IMPACT.restSpeedMps) return false
  return true
}
