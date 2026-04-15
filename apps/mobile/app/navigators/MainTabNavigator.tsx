import { Platform, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Text } from "@/components/Text"
import { useCircles } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import { ActivityScreen } from "@/screens/ActivityScreen"
import { MapScreen } from "@/screens/MapScreen"
import { PlacesScreen } from "@/screens/PlacesScreen"
import { YouScreen } from "@/screens/YouScreen"
import { useSettingsStore } from "@/stores/settings"
import { useAppTheme } from "@/theme/context"

import type { MainTabParamList } from "./navigationTypes"

const Tab = createBottomTabNavigator<MainTabParamList>()

export function MainTabNavigator() {
  const { theme } = useAppTheme()
  const insets = useSafeAreaInsets()
  const activeCircleId = useSettingsStore((state) => state.activeCircleId)
  const { data: circles } = useCircles()
  const unread = circles?.find((circle) => circle.id === activeCircleId)?.unreadEventCount ?? 0

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: theme.colors.tint,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.separator,
          borderTopWidth: Platform.OS === "android" ? 0.5 : 0,
          height: 58 + insets.bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontFamily: theme.typography.primary.medium,
          fontSize: 11,
          marginBottom: 2,
        },
      }}
    >
      <Tab.Screen
        name="Map"
        component={MapScreen}
        options={{
          tabBarLabel: translate("map:title"),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "map" : "map-outline"} size={22} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Places"
        component={PlacesScreen}
        options={{
          tabBarLabel: translate("places:title"),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "location" : "location-outline"} size={22} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Activity"
        component={ActivityScreen}
        options={{
          tabBarLabel: translate("activity:title"),
          tabBarIcon: ({ color, focused }) => (
            <View>
              <Ionicons name={focused ? "pulse" : "pulse-outline"} size={22} color={color} />
              {unread > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -10,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    borderRadius: 8,
                    backgroundColor: theme.colors.tint,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    size="xxs"
                    weight="bold"
                    style={{ color: theme.colors.onTint, lineHeight: 14, fontSize: 10 }}
                  >
                    {unread > 99 ? "99+" : String(unread)}
                  </Text>
                </View>
              ) : null}
            </View>
          ),
        }}
      />
      <Tab.Screen
        name="You"
        component={YouScreen}
        options={{
          tabBarLabel: translate("settings:title"),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "person-circle" : "person-circle-outline"}
              size={24}
              color={color}
            />
          ),
        }}
      />
    </Tab.Navigator>
  )
}
