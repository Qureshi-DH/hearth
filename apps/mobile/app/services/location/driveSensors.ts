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
/**
 * Beyond this a fix describes where the phone was, not how fast it is going
 * now. Location arrives in deferred batches that can be a minute apart, so most
 * samples have no speed at all — which is the honest answer. Carrying the last
 * one forward would stamp a confident 27 m/s across the seconds after a crash
 * and a confident 0 across the seconds before one.
 */
const FIX_FRESH_MS = 3000

type Subscription = { remove: () => void }

let accelSub: Subscription | null = null
let gyroSub: Subscription | null = null
let baroSub: Subscription | null = null
let starting = false

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

/** The last fix, but only while it still describes this instant. */
export function contemporaneousSpeed(
  fix: { recordedAt: string; speedMps?: number | null } | null | undefined,
  now: number,
): number | undefined {
  if (!fix || fix.speedMps == null) return undefined
  const age = Math.abs(now - Date.parse(fix.recordedAt))
  if (!Number.isFinite(age) || age > FIX_FRESH_MS) return undefined
  return fix.speedMps
}

const freshSpeed = (now: number): number | undefined =>
  contemporaneousSpeed(useTrackingStore.getState().lastFix, now)

/** Everything sensor related released; the window and handler are separate. */
function unsubscribe(): void {
  accelSub?.remove()
  gyroSub?.remove()
  baroSub?.remove()
  accelSub = null
  gyroSub = null
  baroSub = null
}

function forget(): void {
  window = []
  latestRotation = 0
  latestPressure = undefined
  onEvent = null
}

/**
 * Called once the aftermath has had time to arrive. Judging at the moment of
 * the spike would miss the only signal that reliably separates a crash from
 * everything else, which is that the car then stopped.
 */
function judge(): void {
  verdictTimer = null
  const event = detectDriveEvent(window)
  const suppressed = event.kind === "possibleImpact" && Date.now() - lastVerdictAt < COOLDOWN_MS
  if (event.kind !== "none" && !suppressed) {
    if (event.kind === "possibleImpact") lastVerdictAt = Date.now()
    onEvent?.(event)
  }
  // Sensors were released while this verdict was outstanding, so nothing else
  // is going to clean up after it.
  if (accelSub === null) forget()
}

function record(accelG: number): void {
  const now = Date.now()
  window.push({
    t: now,
    accelG,
    rotationRps: latestRotation,
    pressure: latestPressure,
    speedMps: freshSpeed(now),
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
  return accelSub !== null || starting
}

export async function startDriveSensors(handler: (event: DriveEvent) => void): Promise<boolean> {
  // Motion callbacks can land on top of each other, and each await below is a
  // chance for a second start to walk past a null accelSub and subscribe twice.
  if (accelSub || starting) return true
  starting = true
  try {
    if (!(await Accelerometer.isAvailableAsync().catch(() => false))) return false

    onEvent = handler
    // A verdict still outstanding is holding the only copy of the evidence.
    if (verdictTimer === null) {
      window = []
      latestRotation = 0
      latestPressure = undefined
    }

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
  } finally {
    starting = false
  }
}

/**
 * Stops sampling, but never abandons a verdict that is already scheduled. The
 * reclassification that usually stops us — a crashed car reads as "still" —
 * arrives inside the very window we are waiting on, and dropping it there would
 * throw away the incident at exactly the moment it happened.
 */
export function stopDriveSensors(): void {
  unsubscribe()
  if (verdictTimer === null) forget()
}
