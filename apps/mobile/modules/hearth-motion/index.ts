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

/** One stretch of Core Motion's history, from when it began. */
export interface MotionRecord {
  activity: MotionActivity
  /** A car parked with the engine running reads automotive and stationary at once. */
  stationary: boolean
  confidence: number
  t: number
}

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
  /** iOS only, Android rejects. Core Motion's history between two moments; null without the permission. */
  queryActivityAsync(fromMs: number, toMs: number): Promise<MotionRecord[] | null>
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
   * Android only, iOS rejects. Whether the person let Hearth through Do Not
   * Disturb, which is what the SOS channel's bypass needs to mean anything.
   */
  isNotificationPolicyAccessGrantedAsync(): Promise<boolean>
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
  /** Forced, for signing out or sharing off, it ends a watch too. Otherwise a watch outlives the tier. */
  stopServiceAsync(force: boolean): Promise<void>
  /** Live for this long, answered natively. False when Android refused the start. */
  watchAsync(seconds: number): Promise<boolean>
  endWatchAsync(): Promise<void>
  /** The upload address and the session's key, so wakes and Live are answered without JavaScript. */
  setUploaderAsync(url: string, key: string): Promise<void>
  clearUploaderAsync(): Promise<void>
  /** Whether a wake or a watch is answered natively, so JavaScript need not take its own fix. */
  answersNativelyAsync(): Promise<boolean>
  /** Back on the first screen, as Home does it. The activity stays, and so does the process. */
  moveTaskToBackAsync(): Promise<boolean>
  /**
   * The brief service: foreground for one fix and its "Updating your
   * location", then gone on its own. True when Android accepted the start.
   */
  startBriefAsync(): Promise<boolean>
  /** Takes the brief service down with the fix it carried; a tracking service stays. */
  stopBriefAsync(): Promise<void>
  /** JavaScript no longer needs the headless task that holds its timers awake. */
  releaseAwakeAsync(): Promise<void>
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
  /** What a fix sent natively is labelled, the tracker's own verdict. */
  activity?: string
}

/** The shape expo-location gives a fix, so the tracker reads both alike. */
export interface NativeFix {
  timestamp: number
  mocked?: boolean
  /** The native uploader sent it, so it is learned from and not sent again. */
  sent?: boolean
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
  /** Play Services dropped the fences, with its GeofenceStatusCodes reason. */
  | { type: "fence_lost"; code: number; at: number }
  | {
      type: "service"
      status: "started" | "refused" | "stopped"
      reason: string
      error?: string
      at: number
    }
  | { type: "boot"; at: number }
  /** A wake or a watch as it arrived, and whether FCM still called it urgent. */
  | {
      type: "push"
      kind: string
      priority: string
      original: string
      lateMs: number | null
      at: number
    }
  /** Why the process last ended, from ApplicationExitInfo. */
  | { type: "exit"; reason: string; description: string | null; importance: number; at: number }
  | { type: "start"; reason: string; forceStopped: boolean; at: number }
  | {
      type: "power"
      exempt: boolean | null
      saver: boolean | null
      bucket?: string | null
      restricted?: boolean | null
      at: number
    }
  | {
      type: "uploaded"
      sent: number
      sentAt: number
      accepted?: number
      watchedUntil?: string | null
      serverTime?: string
      policy?: { minUpdateIntervalSeconds: number; distanceFilterMeters: number }
      at: number
    }
  | { type: "upload"; status: "failed" | "refused" | "rejected"; code: number; at: number }
  | { type: "wake"; native: boolean; fix?: boolean; service?: boolean; sent?: boolean; at: number }
  | { type: "watch"; until: number; reason: string; at: number }
  | { type: "watch over"; reason: string; at: number }

export default requireNativeModule<HearthMotionModule>("HearthMotion")
