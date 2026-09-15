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
  /** Android only: the native queue has fixes or events in it. */
  onNativeQueue: () => void
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

  // The tracking transport, Android only. iOS rejects every one of these:
  // its tracker runs on expo-location, which Core Location relaunches.

  /**
   * Runs the tracking service with this request, or swaps the request on a
   * running one. "refused" is Android declining a start from the
   * background outside its allowed moments.
   */
  startServiceAsync(request: ServiceRequest): Promise<ServiceStatus>
  stopServiceAsync(): Promise<void>
  /**
   * The brief service: foreground for one fix and its "Updating your
   * location", then gone on its own. True when Android accepted the start.
   */
  startBriefAsync(): Promise<boolean>
  /** Takes the brief service down with the fix it carried; a tracking service stays. */
  stopBriefAsync(): Promise<void>
  getServiceStatusAsync(): Promise<ServiceStatus>
  /** The fence around the parking spot, armed with Play Services. True when it took. */
  armFenceAsync(lat: number, lon: number, radius: number): Promise<boolean>
  disarmFenceAsync(): Promise<void>
  isFenceArmedAsync(): Promise<boolean>
  /** What the receivers need to know to act alone: whether sharing is on, the tier, the request to run. */
  setTrackerStateAsync(state: TrackerState): Promise<void>
  /** The fixes the service buffered, oldest first, and no longer held once read. */
  drainFixesAsync(): Promise<NativeFix[]>
  /** The events the receivers took, oldest first, and no longer held once read. */
  drainEventsAsync(): Promise<NativeEvent[]>
  /** Both queues emptied without being read. */
  clearQueueAsync(): Promise<void>
}

export type ServiceStatus = "none" | "brief" | "starting" | "running" | "refused"

export interface ServiceRequest {
  priority: "high" | "balanced" | "low"
  intervalMs: number
  distanceMeters: number
}

export interface TrackerState {
  enabled: boolean
  mode: "off" | "moving" | "stationary"
  movingRequest?: ServiceRequest
}

/** The shape expo-location gives a fix, so the tracker reads both alike. */
export interface NativeFix {
  timestamp: number
  mocked?: boolean
  coords: {
    latitude: number
    longitude: number
    accuracy: number | null
    altitude: number | null
    altitudeAccuracy: number | null
    speed: number | null
    heading: number | null
  }
}

export type NativeEvent =
  | { type: "transition"; activity: MotionActivity; at: number }
  | { type: "fence"; id: string; transition: "enter" | "exit"; at: number }
  | { type: "service"; status: "started" | "refused" | "stopped"; reason: string; at: number }
  | { type: "boot"; at: number }

export default requireNativeModule<HearthMotionModule>("HearthMotion")
