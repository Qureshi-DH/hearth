/**
 * Root navigator.
 *
 * Three states, decided by the auth store:
 *   no_server  -> Server (enter your self-hosted URL)
 *   signed_out -> Login / Register
 *   signed_in  -> Main tabs plus every detail screen
 *
 * The detail screens are registered with getComponent rather than component.
 * Metro's inlineRequires rewrites a top level import into a require at the
 * identifier's use site, and for a screen list that site is this render, so
 * `component` evaluates all twenty screen module graphs (react-native-svg and
 * expo-camera among them) in the same commit that paints the first frame.
 * getComponent defers each graph to the first time its route is shown.
 */
import { useEffect, useRef } from "react"
import { NavigationContainer } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"

import Config from "@/config"
import { ErrorBoundary } from "@/screens/ErrorScreen/ErrorBoundary"
import { LoginScreen } from "@/screens/LoginScreen"
import { RegisterScreen } from "@/screens/RegisterScreen"
import { ServerScreen } from "@/screens/ServerScreen"
import { endpoints } from "@/services/api"
import { attachNotificationListeners, setupPush } from "@/services/notifications"
import { useRealtimeConnection } from "@/services/realtime"
import { usePushStore } from "@/stores/push"
import { useAuthStore } from "@/stores/auth"
import { useTrackingStore } from "@/stores/tracking"
import { useAppTheme } from "@/theme/context"

import { MainTabNavigator } from "./MainTabNavigator"
import type { AppStackParamList, NavigationProps } from "./navigationTypes"
import { navigationRef, useBackButtonHandler } from "./navigationUtilities"

const exitRoutes = Config.exitRoutes

const Stack = createNativeStackNavigator<AppStackParamList>()

const AppStack = () => {
  const status = useAuthStore((state) => state.status)
  const serverInfo = useAuthStore((state) => state.serverInfo)
  const pendingInviteCode = useAuthStore((state) => state.pendingInviteCode)
  const {
    theme: { colors },
  } = useAppTheme()

  useRealtimeConnection()

  /**
   * serverInfo is persisted so the app can render before the network answers.
   * A cached copy goes stale the moment the operator changes the push
   * transport, the registration mode or the map style, so refresh on launch.
   */
  useEffect(() => {
    if (status === "no_server" || status === "booting") return
    endpoints.system
      .info()
      .then((info) => useAuthStore.getState().setServerInfo(info))
      .catch(() => {
        // Offline: the cached copy is still the best we have.
      })
  }, [status])

  // Register for push on every new session. The server treats it as idempotent
  // and the transport may have changed since the last launch.
  useEffect(() => {
    if (status !== "signed_in" || !serverInfo) return
    setupPush(serverInfo)
      .then(usePushStore.getState().setSetup)
      .catch(() => {
        // Push is optional. The map and feed work without it.
      })
  }, [status, serverInfo])

  /**
   * The conditional-children pattern only resets the stack for routes that
   * disappear from the new screen list. "Server" is registered in both the
   * no_server and signed_out branches so people can change servers from the
   * login screen, which left a successful first connect staring at the same
   * Connect form. Reset explicitly instead.
   */
  const previousStatus = useRef(status)
  useEffect(() => {
    if (previousStatus.current === status) return
    previousStatus.current = status
    if (!navigationRef.isReady()) return
    const root = status === "signed_in" ? "Main" : status === "signed_out" ? "Login" : "Server"
    navigationRef.reset({ index: 0, routes: [{ name: root }] })
  }, [status])

  // First sign-in on this phone walks through the permissions checklist once.
  // Notifications are requested there as well as by push, because the SOS
  // banners shown while the app is open are local notifications.
  const onboarded = useTrackingStore((state) => state.onboardedPermissions)
  useEffect(() => {
    if (status !== "signed_in" || onboarded) return
    const timer = setTimeout(() => {
      if (navigationRef.isReady()) navigationRef.navigate("Permissions")
    }, 600)
    return () => clearTimeout(timer)
  }, [status, onboarded])

  // An invite link opened while signed out is parked in the store. Honour it
  // once there is a session to attach it to.
  useEffect(() => {
    if (status !== "signed_in" || !pendingInviteCode) return
    const timer = setTimeout(() => {
      if (navigationRef.isReady()) {
        navigationRef.navigate("JoinCircle", { code: pendingInviteCode })
        useAuthStore.getState().setPendingInvite(null)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [status, pendingInviteCode])

  useEffect(() => {
    return attachNotificationListeners((target) => {
      if (!navigationRef.isReady()) return
      if (target.type === "sos_started" && target.circleId) {
        navigationRef.navigate("Main", { screen: "Map" })
      } else if (
        (target.type === "place_arrive" || target.type === "place_leave") &&
        target.circleId &&
        target.userId
      ) {
        navigationRef.navigate("MemberDetail", { circleId: target.circleId, userId: target.userId })
      } else if (target.type === "nudge_requested") {
        // A nudge is played over the map, so send the tap there rather than to
        // the feed's after-the-fact record of it.
        navigationRef.navigate("Main", { screen: "Map" })
      } else {
        navigationRef.navigate("Main", { screen: "Activity" })
      }
    })
  }, [])

  /**
   * A route drawn as a bottom sheet. Transparent so the screen underneath stays
   * visible, and un-animated because the sheet does its own entrance.
   */
  const sheet = {
    presentation: "transparentModal" as const,
    headerShown: false,
    animation: "none" as const,
    contentStyle: { backgroundColor: "transparent" },
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        navigationBarColor: colors.background,
        contentStyle: { backgroundColor: colors.background },
        animation: "slide_from_right",
      }}
    >
      {status === "no_server" || status === "booting" ? (
        // navigationKey ties the route's identity to the auth phase, so the
        // shared "Server" name cannot survive the transition.
        <Stack.Screen name="Server" navigationKey={status} component={ServerScreen} />
      ) : status === "signed_out" ? (
        <>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
          <Stack.Screen name="Server" navigationKey={status} component={ServerScreen} />
        </>
      ) : (
        <>
          <Stack.Screen name="Main" component={MainTabNavigator} />
          <Stack.Screen
            name="Permissions"
            getComponent={() => require("@/screens/PermissionsScreen").PermissionsScreen}
          />
          <Stack.Screen
            name="CreateCircle"
            getComponent={() => require("@/screens/CreateCircleScreen").CreateCircleScreen}
            options={sheet}
          />
          <Stack.Screen
            name="JoinCircle"
            getComponent={() => require("@/screens/JoinCircleScreen").JoinCircleScreen}
            options={sheet}
          />
          <Stack.Screen
            name="MemberDetail"
            getComponent={() => require("@/screens/MemberDetailScreen").MemberDetailScreen}
          />
          <Stack.Screen
            name="PlaceEditor"
            getComponent={() => require("@/screens/PlaceEditorScreen").PlaceEditorScreen}
          />
          <Stack.Screen
            name="PlaceDetail"
            getComponent={() => require("@/screens/PlaceDetailScreen").PlaceDetailScreen}
          />
          <Stack.Screen
            name="Circle"
            getComponent={() => require("@/screens/CircleScreen").CircleScreen}
          />
          <Stack.Screen
            name="CircleSettings"
            getComponent={() => require("@/screens/CircleSettingsScreen").CircleSettingsScreen}
          />
          <Stack.Screen
            name="Invites"
            getComponent={() => require("@/screens/InvitesScreen").InvitesScreen}
          />
          <Stack.Screen
            name="Sharing"
            getComponent={() => require("@/screens/SharingScreen").SharingScreen}
          />
          <Stack.Screen
            name="NotificationPrefs"
            getComponent={() =>
              require("@/screens/NotificationPrefsScreen").NotificationPrefsScreen
            }
          />
          <Stack.Screen
            name="Devices"
            getComponent={() => require("@/screens/DevicesScreen").DevicesScreen}
          />
          <Stack.Screen
            name="PrivacyData"
            getComponent={() => require("@/screens/PrivacyDataScreen").PrivacyDataScreen}
          />
          <Stack.Screen
            name="TrackerLog"
            getComponent={() => require("@/screens/TrackerLogScreen").TrackerLogScreen}
          />
          <Stack.Screen
            name="ChangePassword"
            getComponent={() => require("@/screens/ChangePasswordScreen").ChangePasswordScreen}
            options={sheet}
          />
          <Stack.Screen
            name="Sos"
            getComponent={() => require("@/screens/SosScreen").SosScreen}
            options={{ presentation: "fullScreenModal", headerShown: false }}
          />
          <Stack.Screen
            name="CheckIn"
            getComponent={() => require("@/screens/CheckInScreen").CheckInScreen}
            options={sheet}
          />
          <Stack.Screen
            name="Trips"
            getComponent={() => require("@/screens/TripsScreen").TripsScreen}
          />
          <Stack.Screen
            name="TripDetail"
            getComponent={() => require("@/screens/TripDetailScreen").TripDetailScreen}
          />
          <Stack.Screen
            name="Live"
            getComponent={() => require("@/screens/LiveScreen").LiveScreen}
          />
          <Stack.Screen
            name="Admin"
            getComponent={() => require("@/screens/AdminScreen").AdminScreen}
          />
        </>
      )}
    </Stack.Navigator>
  )
}

export const AppNavigator = (props: NavigationProps) => {
  const { navigationTheme } = useAppTheme()

  useBackButtonHandler((routeName) => exitRoutes.includes(routeName))

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme} {...props}>
      <ErrorBoundary catchErrors={Config.catchErrors}>
        <AppStack />
      </ErrorBoundary>
    </NavigationContainer>
  )
}
