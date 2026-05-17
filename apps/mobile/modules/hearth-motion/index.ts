import { NativeModule, requireNativeModule } from "expo"

/** What the OS thinks the phone is doing. */
export type MotionActivity = "still" | "walking" | "running" | "cycling" | "automotive" | "unknown"

export interface MotionChangeEvent {
  activity: MotionActivity
  /** 0 to 100. Android reports a real number, iOS reports low/medium/high mapped onto it. */
  confidence: number
}

export type MotionPermission = "granted" | "denied" | "undetermined"

declare class HearthMotionModule extends NativeModule<{
  onMotionChange: (event: MotionChangeEvent) => void
}> {
  /** False on a simulator, an old device, or where Play Services is missing. */
  isAvailableAsync(): Promise<boolean>
  getPermissionAsync(): Promise<MotionPermission>
  requestPermissionAsync(): Promise<MotionPermission>
  startUpdatesAsync(): Promise<void>
  stopUpdatesAsync(): Promise<void>
}

export default requireNativeModule<HearthMotionModule>("HearthMotion")
