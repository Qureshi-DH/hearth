import { Platform } from "react-native"
import * as Notifications from "expo-notifications"

/**
 * Its own module rather than a function in notifications.ts, which imports the
 * tracker to answer a nudge. The tracker is what raises an incident, and a
 * cycle between the two is the kind of thing that resolves to undefined at
 * exactly the moment it is needed.
 *
 * The phone has just been through something violent and is probably face down
 * in a footwell. A modal nobody is looking at is not an alarm, so this goes out
 * on the same channel as an SOS: maximum importance, and it makes a noise.
 */
export async function presentIncidentAlarm(title: string, body: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: "default",
      data: { type: "incident" },
      interruptionLevel: "timeSensitive",
      ...(Platform.OS === "android" ? { channelId: "sos" } : {}),
    },
    trigger: null,
  })
}
