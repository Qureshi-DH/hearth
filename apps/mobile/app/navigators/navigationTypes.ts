import type { ComponentProps } from "react"
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs"
import type {
  CompositeScreenProps,
  NavigationContainer,
  NavigatorScreenParams,
} from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"

export type MainTabParamList = {
  Map: undefined
  Places: undefined
  Activity: undefined
  You: undefined
}

export type AppStackParamList = {
  // Onboarding
  Server: undefined
  Login: undefined
  Register: { inviteCode?: string } | undefined
  Permissions: undefined
  KeepAlive: undefined
  // Main
  Main: NavigatorScreenParams<MainTabParamList> | undefined
  CreateCircle: undefined
  JoinCircle: { code?: string } | undefined
  MemberDetail: { circleId: string; userId: string }
  Live: { circleId: string; userId: string }
  PlaceEditor: { circleId: string; placeId?: string; lat?: number; lon?: number; name?: string }
  PlaceDetail: { circleId: string; placeId: string }
  Circle: { circleId: string }
  CircleSettings: { circleId: string }
  Invites: { circleId: string }
  Sharing: { circleId?: string } | undefined
  NotificationPrefs: { circleId: string }
  Devices: undefined
  TrackerLog: undefined
  PrivacyData: undefined
  ChangePassword: undefined
  Sos: { circleId: string }
  CheckIn: { circleId: string }
  Trips: { circleId: string; userId: string }
  TripDetail: { tripId: string }
  Admin: undefined
}

export type AppStackScreenProps<T extends keyof AppStackParamList> = NativeStackScreenProps<
  AppStackParamList,
  T
>

export type MainTabScreenProps<T extends keyof MainTabParamList> = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, T>,
  AppStackScreenProps<keyof AppStackParamList>
>

export interface NavigationProps extends Partial<
  ComponentProps<typeof NavigationContainer<AppStackParamList>>
> {}
