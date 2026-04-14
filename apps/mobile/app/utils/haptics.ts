import { Platform } from "react-native"
import * as Haptics from "expo-haptics"

import { useSettingsStore } from "@/stores/settings"

const enabled = () => Platform.OS !== "web" && useSettingsStore.getState().hapticsEnabled

/** Wrappers so call sites read as intent and honour the user's toggle. */
export const haptics = {
  tap: () => enabled() && void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  select: () => enabled() && void Haptics.selectionAsync(),
  heavy: () => enabled() && void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
  success: () =>
    enabled() && void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warning: () =>
    enabled() && void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: () => enabled() && void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
}
