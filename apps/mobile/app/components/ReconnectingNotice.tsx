import { View, type StyleProp, type ViewStyle } from "react-native"

import { Pill } from "@/components/Pill"
import { useRealtimeDown } from "@/hooks/useRealtimeDown"
import { translate } from "@/i18n/translate"

/**
 * Said quietly over a map whose live connection to the server has been down
 * for a few seconds, so dots that stop moving read as the connection and not
 * as the people. Nothing is shown while it is up.
 */
export function ReconnectingNotice({ style }: { style?: StyleProp<ViewStyle> }) {
  const down = useRealtimeDown()
  if (!down) return null
  return (
    <View style={style} accessibilityLiveRegion="polite" pointerEvents="none">
      <Pill text={translate("map:reconnecting")} icon="cloud-offline-outline" tone="neutral" />
    </View>
  )
}
