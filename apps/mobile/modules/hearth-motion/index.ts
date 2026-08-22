import { NativeModule, requireNativeModule } from "expo"

/** What the OS thinks the phone is doing. */
export type MotionActivity = "still" | "walking" | "running" | "cycling" | "automotive" | "unknown"

/**
 * "transition" is the OS saying the activity changed, debounced and worth
 * acting on; "sample" is its periodic best guess, with the confidence to
 * match. iOS only samples, and repeats its last verdict on a schedule.
 */
export type MotionSource = "sample" | "transition"

export interface MotionChangeEvent {
  activity: MotionActivity
  /** 0 to 100. Android reports a real number, iOS reports low/medium/high mapped onto it. */
  confidence: number
  source?: MotionSource
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

/** iOS Low Power Mode or Android Battery Saver, whichever the phone just flipped. */
export interface PowerStateEvent {
  lowPowerMode: boolean
}

declare class HearthMotionModule extends NativeModule<{
  onMotionChange: (event: MotionChangeEvent) => void
  onSensorBatch: (event: SensorBatchEvent) => void
  onPowerStateChange: (event: PowerStateEvent) => void
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
  /** iOS only. Android rejects. */
  isLowPowerModeAsync(): Promise<boolean>
  /**
   * Android only, iOS rejects. True when the person set Hearth's background
   * usage to Restricted, which stops the location service outright. Always
   * false below Android 9, where the switch does not exist.
   */
  getBackgroundRestrictedAsync(): Promise<boolean>
  /** Android only, iOS rejects. Battery Saver. */
  isPowerSaveModeAsync(): Promise<boolean>
  /**
   * Android only, iOS rejects. Raises the system's own "let this app ignore
   * battery optimisation" dialog for this package. Resolves whether the
   * dialog could be launched at all, not what the person chose; the OS
   * answers that through the battery optimisation read.
   */
  requestIgnoreBatteryOptimizationsAsync(): Promise<boolean>
  /**
   * Android only, iOS rejects. Opens the vendor's own autostart or power
   * manager screen for this make of phone, falling back to Hearth's app
   * settings page. Resolves "package/class" of the screen that opened,
   * "app_settings" for the fallback, or null when nothing would open.
   */
  openVendorPowerManagerAsync(): Promise<string | null>
  /**
   * Android only. Brings up the wake service, a foreground service that
   * carries one fix and its "Updating your location" notification, then
   * goes. True when Android accepted the start.
   */
  startWakeServiceAsync(): Promise<boolean>
  /** Android only. Takes the wake service down with the fix it carried. */
  stopWakeServiceAsync(): Promise<void>
}

export default requireNativeModule<HearthMotionModule>("HearthMotion")
