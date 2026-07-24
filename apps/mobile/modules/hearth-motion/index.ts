import { NativeModule, requireNativeModule } from "expo"

/** What the OS thinks the phone is doing. */
export type MotionActivity = "still" | "walking" | "running" | "cycling" | "automotive" | "unknown"

export interface MotionChangeEvent {
  activity: MotionActivity
  /** 0 to 100. Android reports a real number, iOS reports low/medium/high mapped onto it. */
  confidence: number
}

export type MotionPermission = "granted" | "denied" | "undetermined"

/** iOS Background App Refresh, as UIApplication reports it. */
export type BackgroundRefreshStatus = "available" | "denied" | "restricted" | "unknown"

/** One accelerometer reading, carrying whatever the slower sensors last said. */
export interface SensorSample {
  /** Milliseconds since epoch, taken from the sensor's own clock rather than delivery. */
  t: number
  /** Resultant accelerometer magnitude in g, gravity included, so 1 at rest. */
  accelG: number
  /** Resultant rotation rate in radians per second. */
  rotationRps: number
  /** Barometric pressure in hPa. Absent on devices without the sensor. */
  pressure?: number
}

export interface SensorBatchEvent {
  /** In the order they were sampled, oldest first. */
  samples: SensorSample[]
}

declare class HearthMotionModule extends NativeModule<{
  onMotionChange: (event: MotionChangeEvent) => void
  onSensorBatch: (event: SensorBatchEvent) => void
}> {
  /** False on a simulator, an old device, or where Play Services is missing. */
  isAvailableAsync(): Promise<boolean>
  getPermissionAsync(): Promise<MotionPermission>
  requestPermissionAsync(): Promise<MotionPermission>
  startUpdatesAsync(): Promise<void>
  stopUpdatesAsync(): Promise<void>
  /**
   * Sampling that is not tied to the Activity, which is the only kind that
   * keeps running once the screen goes off mid drive. False where the device
   * has no accelerometer to offer, so the caller can sample for itself instead.
   */
  startSensorsAsync(): Promise<boolean>
  stopSensorsAsync(): Promise<void>
  /** iOS only. Android rejects. */
  getBackgroundRefreshStatusAsync(): Promise<BackgroundRefreshStatus>
}

export default requireNativeModule<HearthMotionModule>("HearthMotion")
