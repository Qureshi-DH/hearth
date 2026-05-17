import { Accelerometer, Barometer, Gyroscope } from "expo-sensors"
import { detectDriveEvent, IMPACT, type DriveEvent, type DriveSample } from "@hearth/shared"

import { useTrackingStore } from "@/stores/tracking"

/**
 * Samples the sensors that can tell a crash from a pothole, and only while the
 * OS says the phone is in a vehicle. Parked or walking, none of this runs.
 *
 * 50Hz on the accelerometer is the cost of catching an impact at all, since a
 * collision is over in well under a tenth of a second. Everything else samples
 * far slower because pressure and rotation change on human timescales.
 */
const ACCEL_INTERVAL_MS = 20
const GYRO_INTERVAL_MS = 100
const BARO_INTERVAL_MS = 200

/** Long enough to hold the run up, the impact, and the stillness afterwards. */
const WINDOW_MS = 20_000
/** How long to wait after a spike before judging it, so the aftermath is in. */
const VERDICT_DELAY_MS = IMPACT.aftermathMs + IMPACT.stillnessMs + 1000
/** One verdict per incident. Without this a crash reports itself repeatedly. */
const COOLDOWN_MS = 60_000

type Subscription = { remove: () => void }

let accelSub: Subscription | null = null
let gyroSub: Subscription | null = null
let baroSub: Subscription | null = null

let window: DriveSample[] = []
let latestRotation = 0
let latestPressure: number | undefined
let verdictTimer: ReturnType<typeof setTimeout> | null = null
let lastVerdictAt = 0

let onEvent: ((event: DriveEvent) => void) | null = null

function trim(now: number): void {
  const cutoff = now - WINDOW_MS
  if (window.length > 0 && window[0]!.t >= cutoff) return
  window = window.filter((sample) => sample.t >= cutoff)
}

/**
 * Called once the aftermath has had time to arrive. Judging at the moment of
 * the spike would miss the only signal that reliably separates a crash from
 * everything else, which is that the car then stopped.
 */
function judge(): void {
  verdictTimer = null
  const event = detectDriveEvent(window)
  if (event.kind === "none") return
  if (event.kind === "possibleImpact") {
    if (Date.now() - lastVerdictAt < COOLDOWN_MS) return
    lastVerdictAt = Date.now()
  }
  onEvent?.(event)
}

function record(accelG: number): void {
  const now = Date.now()
  window.push({
    t: now,
    accelG,
    rotationRps: latestRotation,
    pressure: latestPressure,
    speedMps: useTrackingStore.getState().lastFix?.speedMps ?? null,
  })
  trim(now)

  // A spike starts the clock rather than deciding anything. Later spikes inside
  // the same incident must not keep pushing the verdict further out.
  if (Math.abs(accelG - 1) >= IMPACT.impactG && verdictTimer === null) {
    verdictTimer = setTimeout(judge, VERDICT_DELAY_MS)
  }
}

const magnitude = (v: { x: number; y: number; z: number }): number =>
  Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)

export function driveSensorsRunning(): boolean {
  return accelSub !== null
}

export async function startDriveSensors(handler: (event: DriveEvent) => void): Promise<boolean> {
  if (accelSub) return true
  if (!(await Accelerometer.isAvailableAsync().catch(() => false))) return false

  onEvent = handler
  window = []
  latestRotation = 0
  latestPressure = undefined

  Accelerometer.setUpdateInterval(ACCEL_INTERVAL_MS)
  accelSub = Accelerometer.addListener((reading) => record(magnitude(reading)))

  if (await Gyroscope.isAvailableAsync().catch(() => false)) {
    Gyroscope.setUpdateInterval(GYRO_INTERVAL_MS)
    gyroSub = Gyroscope.addListener((reading) => {
      latestRotation = magnitude(reading)
    })
  }

  // Plenty of Android devices have no barometer. Its absence costs one
  // corroborating signal rather than the whole feature.
  if (await Barometer.isAvailableAsync().catch(() => false)) {
    Barometer.setUpdateInterval(BARO_INTERVAL_MS)
    baroSub = Barometer.addListener((reading) => {
      latestPressure = reading.pressure
    })
  }

  return true
}

export function stopDriveSensors(): void {
  accelSub?.remove()
  gyroSub?.remove()
  baroSub?.remove()
  accelSub = null
  gyroSub = null
  baroSub = null
  if (verdictTimer) clearTimeout(verdictTimer)
  verdictTimer = null
  window = []
  onEvent = null
}
