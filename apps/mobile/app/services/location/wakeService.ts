import { Platform } from "react-native"

type WakeModule = {
  startWakeServiceAsync?: () => Promise<boolean>
  stopWakeServiceAsync?: () => Promise<void>
}

/**
 * The native wake service: a foreground service that carries one fix and
 * its "Updating your location" notification, then goes, the way a messaging
 * app checks for messages. A high priority push starts it natively, inside
 * the message handler, which is the moment Android allows the start; the
 * tracker starts it from here for a wake that came another way. The module
 * only exists in a build that included it.
 */
let native: WakeModule | null = null
try {
  native = (require("../../../modules/hearth-motion") as { default: WakeModule }).default
} catch {
  native = null
}

export async function startWakeService(): Promise<boolean> {
  if (Platform.OS !== "android") return false
  try {
    return (await native?.startWakeServiceAsync?.()) ?? false
  } catch {
    return false
  }
}

export async function stopWakeService(): Promise<void> {
  if (Platform.OS !== "android") return
  try {
    await native?.stopWakeServiceAsync?.()
  } catch {
    // Already gone, or never started.
  }
}
