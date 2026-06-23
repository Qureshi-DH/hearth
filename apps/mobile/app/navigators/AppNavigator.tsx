/**
 * Root navigator.
 *
 * Three states, decided by the auth store:
 *   no_server  -> Server (enter your self-hosted URL)
 *   signed_out -> Login / Register
 *   signed_in  -> Main tabs plus every detail screen
 */
import { useEffect, useRef } from "react"
import { NavigationContainer } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"

import Config from "@/config"
import { AdminScreen } from "@/screens/AdminScreen"
import { ChangePasswordScreen } from "@/screens/ChangePasswordScreen"
import { CheckInScreen } from "@/screens/CheckInScreen"
import { CircleScreen } from "@/screens/CircleScreen"
import { CircleSettingsScreen } from "@/screens/CircleSettingsScreen"
import { CreateCircleScreen } from "@/screens/CreateCircleScreen"
import { DevicesScreen } from "@/screens/DevicesScreen"
import { ErrorBoundary } from "@/screens/ErrorScreen/ErrorBoundary"
import { InvitesScreen } from "@/screens/InvitesScreen"
import { JoinCircleScreen } from "@/screens/JoinCircleScreen"
import { LoginScreen } from "@/screens/LoginScreen"
import { MemberDetailScreen } from "@/screens/MemberDetailScreen"
import { NotificationPrefsScreen } from "@/screens/NotificationPrefsScreen"
import { PermissionsScreen } from "@/screens/PermissionsScreen"
import { PlaceDetailScreen } from "@/screens/PlaceDetailScreen"
import { PlaceEditorScreen } from "@/screens/PlaceEditorScreen"
import { PrivacyDataScreen } from "@/screens/PrivacyDataScreen"
import { RegisterScreen } from "@/screens/RegisterScreen"
import { ServerScreen } from "@/screens/ServerScreen"
import { SharingScreen } from "@/screens/SharingScreen"
import { SosScreen } from "@/screens/SosScreen"
import { TripDetailScreen } from "@/screens/TripDetailScreen"
import { TripsScreen } from "@/screens/TripsScreen"
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
          <Stack.Screen name="Permissions" component={PermissionsScreen} />
          <Stack.Screen name="CreateCircle" component={CreateCircleScreen} options={sheet} />
          <Stack.Screen name="JoinCircle" component={JoinCircleScreen} options={sheet} />
          <Stack.Screen name="MemberDetail" component={MemberDetailScreen} />
          <Stack.Screen name="PlaceEditor" component={PlaceEditorScreen} />
          <Stack.Screen name="PlaceDetail" component={PlaceDetailScreen} />
          <Stack.Screen name="Circle" component={CircleScreen} />
          <Stack.Screen name="CircleSettings" component={CircleSettingsScreen} />
          <Stack.Screen name="Invites" component={InvitesScreen} />
          <Stack.Screen name="Sharing" component={SharingScreen} />
          <Stack.Screen name="NotificationPrefs" component={NotificationPrefsScreen} />
          <Stack.Screen name="Devices" component={DevicesScreen} />
          <Stack.Screen name="PrivacyData" component={PrivacyDataScreen} />
          <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} options={sheet} />
          <Stack.Screen
            name="Sos"
            component={SosScreen}
            options={{ presentation: "fullScreenModal", headerShown: false }}
          />
          <Stack.Screen name="CheckIn" component={CheckInScreen} options={sheet} />
          <Stack.Screen name="Trips" component={TripsScreen} />
          <Stack.Screen name="TripDetail" component={TripDetailScreen} />
          <Stack.Screen name="Admin" component={AdminScreen} />
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
