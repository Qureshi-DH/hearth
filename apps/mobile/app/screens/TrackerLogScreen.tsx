import { useCallback, useState, type FC } from "react"
import { ScrollView, Share, View, type ViewStyle } from "react-native"
import { useFocusEffect } from "@react-navigation/native"

import { ListGroup, ListRow } from "@/components/ListRow"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import {
  clearTrackerLog,
  formatTrackerLog,
  readTrackerLog,
  type TrackerLogEntry,
} from "@/services/location/log"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatClock } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

/**
 * What the tracker did and why, newest first, so a report like "it never
 * noticed I left" comes with the page to screenshot or share.
 */
export const TrackerLogScreen: FC<AppStackScreenProps<"TrackerLog">> = ({ navigation }) => {
  const { themed, theme } = useAppTheme()
  const [entries, setEntries] = useState<TrackerLogEntry[]>([])
  const mode = useTrackingStore((state) => state.mode)
  const lastFix = useTrackingStore((state) => state.lastFix)

  useHeader(
    { titleTx: "settings:trackerLog", leftIcon: "back", onLeftPress: () => navigation.goBack() },
    [navigation],
  )

  useFocusEffect(
    useCallback(() => {
      setEntries(readTrackerLog().reverse())
    }, []),
  )

  return (
    <Screen preset="fixed" contentContainerStyle={themed($container)}>
      <ListGroup>
        <ListRow text={translate("settings:trackerMode", { mode })} icon="navigate-outline" />
        <ListRow
          text={translate("settings:trackerLastFix", {
            when: lastFix ? formatClock(lastFix.recordedAt) : translate("common:never"),
          })}
          icon="time-outline"
        />
        <ListRow
          tx="settings:trackerShare"
          icon="share-outline"
          iconTone="tint"
          onPress={() => {
            void Share.share({ message: formatTrackerLog() })
          }}
        />
        <ListRow
          tx="settings:trackerClear"
          icon="trash-outline"
          destructive
          onPress={() => {
            clearTrackerLog()
            setEntries([])
          }}
        />
      </ListGroup>
      <ScrollView style={themed($log)} contentContainerStyle={{ padding: theme.spacing.md }}>
        {entries.length === 0 ? (
          <Text size="xs" style={{ color: theme.colors.textDim }} tx="settings:trackerEmpty" />
        ) : (
          entries.map((entry, index) => (
            <View key={`${entry.at}-${index}`} style={{ marginBottom: 6 }}>
              <Text size="xxs" style={{ color: theme.colors.textFaint }}>
                {formatClock(entry.at)}
              </Text>
              <Text size="xs" weight="semiBold">
                {entry.what}
                {entry.detail ? (
                  <Text size="xs" style={{ color: theme.colors.textDim }}>
                    {" "}
                    {JSON.stringify(entry.detail)}
                  </Text>
                ) : null}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  gap: spacing.md,
  paddingHorizontal: spacing.md,
})

const $log: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  borderRadius: 16,
  backgroundColor: colors.surface,
})
