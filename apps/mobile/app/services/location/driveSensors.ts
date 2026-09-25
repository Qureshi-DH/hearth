import { Accelerometer, Barometer, Gyroscope } from "expo-sensors"
import { detectDriveEvent, IMPACT, type DriveEvent, type DriveSample } from "@hearth/shared"

import { useTrackingStore } from "@/stores/tracking"

import { startSensorBatches, stopSensorBatches, type SensorSample } from "./motion"

/**
 * Samples the sensors that can tell a crash from a pothole, and only while the
 * OS says the phone is in a vehicle. Parked or walking, none of this runs.
 *
 * The accelerometer has to sample fast enough to catch an impact at all, since
 * a collision is over in well under a tenth of a second. Everything else
 * samples far slower because pressure and rotation change on human timescales.
 *
 * Samples arrive from the native module wherever it exists, batched, because
 * expo-sensors on Android unregisters the moment the Activity pauses and a
 * phone spends the whole of a drive with its screen off. expo-sensors is still
 * the fallback: an install built without the module has to keep working, and
 * on iOS both paths read the same Core Motion. Only the source changes here.
 * What a sample means, and everything that judges one, is the same either way.
 */

/** What the fallback asks for. The native sampler sets its own rates. */
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
 * How far a later, larger jolt may push the verdict past the first one. Long
 * enough for a multi-stage collision to finish, short enough that somebody
 * hurt is not waiting on a timer.
 */
const MAX_VERDICT_DEFER_MS = 10_000
/**
 * How much of the buffer a verdict looks at, measured back from the jolt that
 * armed it. The detector reads the largest jolt in whatever it is given, so
 * handing it the whole 20 seconds lets an earlier, unrelated one mask a real
 * collision: a phone thrown off the seat reads bigger at the sensor than the
 * crash ten seconds later, because the phone was in free fall and the car was
 * not. This leaves room for the run up the detector needs to decide the
 * vehicle was moving beforehand.
 */
const VERDICT_CONTEXT_MS = 8000
/**
 * Beyond this a fix describes where the phone was, not how fast it is going
 * now. Location arrives in deferred batches that can be a minute apart, so most
 * samples have no speed at all, which is the honest answer. Carrying the last
 * one forward would stamp a confident 27 m/s across the seconds after a crash
 * and a confident 0 across the seconds before one.
 */
const FIX_FRESH_MS = 3000

type Subscription = { remove: () => void }

let accelSub: Subscription | null = null
let gyroSub: Subscription | null = null
let baroSub: Subscription | null = null
let nativeSub: Subscription | null = null
let starting = false

let window: DriveSample[] = []
/** Where the samples still inside the window start. */
let windowStart = 0
let latestRotation = 0
let latestPressure: number | undefined
let verdictTimer: ReturnType<typeof setTimeout> | null = null
let lastVerdictAt = 0
let firstSpikeAt = 0
let peakSinceSpike = 0
let stopRequested = false
/**
 * Bumped by every stop. A start that was already awaiting the native module
 * when a stop arrived compares this on the way back: without it the stop
 * unregisters the sensors, the start then assigns its subscription anyway, and
 * the app is left believing it is sampling when nothing is.
 */
let startEpoch = 0

let onEvent: ((event: DriveEvent) => void) | null = null

/**
 * Expired samples are skipped past rather than filtered out. Once the window is
 * full, filtering rebuilds the whole thing on every sample for the length of a
 * drive, so the array is compacted a window at a time instead.
 */
function trim(now: number): void {
  const cutoff = now - WINDOW_MS
  while (windowStart < window.length && window[windowStart]!.t < cutoff) windowStart++
  if (windowStart >= WINDOW_MS / ACCEL_INTERVAL_MS) {
    window = window.slice(windowStart)
    windowStart = 0
  }
}

/** The live part of the window, which is what the detector is asked about. */
const liveSamples = (): DriveSample[] => (windowStart === 0 ? window : window.slice(windowStart))

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

/** Whichever source is live. Never both, and usually neither. */
const sampling = (): boolean => accelSub !== null || nativeSub !== null

/** Everything sensor related released. The window and the handler are separate. */
function unsubscribe(): void {
  accelSub?.remove()
  gyroSub?.remove()
  baroSub?.remove()
  accelSub = null
  gyroSub = null
  baroSub = null
  void stopSensorBatches(nativeSub)
  nativeSub = null
}

function forget(): void {
  stopRequested = false
  firstSpikeAt = 0
  peakSinceSpike = 0
  window = []
  windowStart = 0
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
  const since = firstSpikeAt - VERDICT_CONTEXT_MS
  const event = detectDriveEvent(liveSamples().filter((sample) => sample.t >= since))
  const suppressed = event.kind === "possibleImpact" && Date.now() - lastVerdictAt < COOLDOWN_MS
  if (event.kind !== "none" && !suppressed) {
    if (event.kind === "possibleImpact") lastVerdictAt = Date.now()
    onEvent?.(event)
  }
  // A stop that arrived mid-aftermath was held back so the samples it needed
  // could keep arriving. Now that it has decided, let go.
  if (stopRequested) {
    stopRequested = false
    unsubscribe()
    forget()
  } else if (!sampling()) {
    forget()
  }
}

function record(sample: SensorSample): void {
  const now = sample.t
  window.push({
    t: now,
    accelG: sample.accelG,
    rotationRps: sample.rotationRps,
    pressure: sample.pressure,
    speedMps: freshSpeed(now),
  })
  trim(now)

  // A spike starts the clock rather than deciding anything. The detector reads
  // the aftermath from the LARGEST jolt, so if a bigger one lands later, the
  // clock has to follow it: a kerb then a tree, a spin then a barrier. Judging
  // on the first one leaves the tail too short and the crash is dropped.
  //
  // The cap is what stops a rolling incident deferring the verdict for ever.
  const delta = Math.abs(sample.accelG - 1)
  if (delta < IMPACT.impactG) return

  if (verdictTimer === null) {
    firstSpikeAt = now
    peakSinceSpike = delta
    verdictTimer = setTimeout(judge, VERDICT_DELAY_MS)
    return
  }

  if (delta <= peakSinceSpike) return
  peakSinceSpike = delta
  const deadline = Math.min(now + VERDICT_DELAY_MS, firstSpikeAt + MAX_VERDICT_DEFER_MS)
  const wait = deadline - now
  if (wait <= 0) return
  clearTimeout(verdictTimer)
  verdictTimer = setTimeout(judge, wait)
}

const magnitude = (v: { x: number; y: number; z: number }): number =>
  Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)

export function driveSensorsRunning(): boolean {
  return sampling() || starting
}

export async function startDriveSensors(handler: (event: DriveEvent) => void): Promise<boolean> {
  // Motion callbacks can land on top of each other, and each await below is a
  // chance for a second start to walk past an idle sampler and subscribe twice.
  if (sampling() || starting) {
    // A stop that arrived while a verdict was pending left this set. The app
    // has asked for sampling again since, so the teardown that stop scheduled
    // must not run when the verdict lands.
    stopRequested = false
    return true
  }
  starting = true
  const epoch = startEpoch
  try {
    // Asked first, because it is the one that keeps sampling with the screen off.
    const native = await startSensorBatches((samples) => {
      for (const sample of samples) record(sample)
    })
    // A stop landed while that was in flight, so this start is stale. Release
    // what it opened rather than publishing a subscription nothing will stop.
    if (epoch !== startEpoch) {
      await stopSensorBatches(native)
      return false
    }
    nativeSub = native
    if (!nativeSub && !(await Accelerometer.isAvailableAsync().catch(() => false))) return false

    onEvent = handler
    // A verdict still outstanding is holding the only copy of the evidence. The
    // first native batch is a whole cadence away, so this still lands ahead of
    // every sample either source has to offer.
    if (verdictTimer === null) {
      window = []
      windowStart = 0
      latestRotation = 0
      latestPressure = undefined
    }

    // The native sampler carries its own rotation and pressure, so the two
    // listeners below belong to the fallback alone.
    if (nativeSub) return true

    Accelerometer.setUpdateInterval(ACCEL_INTERVAL_MS)
    accelSub = Accelerometer.addListener((reading) =>
      record({
        t: Date.now(),
        accelG: magnitude(reading),
        rotationRps: latestRotation,
        pressure: latestPressure,
      }),
    )

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
 * reclassification that usually stops us (a crashed car reads as "still")
 * arrives inside the very window we are waiting on, and dropping it there would
 * throw away the incident at exactly the moment it happened.
 */
export function stopDriveSensors(): void {
  // Releasing the sensors now would cut off the aftermath a pending verdict is
  // waiting for, and the reclassification that stops us is usually the crashed
  // car reading as still. So keep sampling until it has decided.
  startEpoch += 1
  if (verdictTimer !== null) {
    stopRequested = true
    return
  }
  unsubscribe()
  forget()
}
