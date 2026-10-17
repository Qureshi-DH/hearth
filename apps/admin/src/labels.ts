import type {
  AdminPhoneState,
  Platform,
  PresenceIssue,
  PushProvider,
  RegistrationMode,
} from "@hearth/shared"

export const PUSH_PROVIDER_LABEL: Record<PushProvider, string> = {
  none: "None set up",
  expo: "Expo",
  ntfy: "ntfy",
  webpush: "Web Push",
}

/** What choosing each provider means for the family, for the settings page. */
export const PUSH_PROVIDER_DETAIL: Record<PushProvider, string> = {
  none: "Alerts only show while the app is open.",
  expo: "For builds made with this server's own keys.",
  ntfy: "Alerts only.",
  webpush: "No Hearth client uses it yet.",
}

export const SIGN_UP_LABEL: Record<RegistrationMode, string> = {
  open: "Anyone",
  invite: "Invite only",
  closed: "Nobody",
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  ios: "iPhone",
  android: "Android",
  web: "Browser",
  other: "Other device",
}

export const PHONE_STATE_LABEL: Record<AdminPhoneState, string> = {
  reporting: "Reporting",
  quiet: "Quiet",
  parked: "Parked",
  offline: "Stopped reporting",
  never: "Never reported",
  none: "No phone",
}

/** Shown under the person's name, so the operator can tell them which switch to flip. */
export const ISSUE_LABEL: Record<PresenceIssue, string> = {
  sharing_off: "Location sharing is switched off on the phone",
  location_permission: "Location access is not allowed all the time",
  precise_location: "Precise location is off",
  location_services: "Location services are off",
  motion_permission: "Motion and activity access is off",
  background_refresh: "Background App Refresh is off",
  battery_optimisation: "Battery optimisation is on",
  low_power_mode: "Power saving mode is on",
  background_restricted: "Background activity is restricted",
  service_stopped: "The location service was stopped",
}

/** Under the name of a phone that went quiet on a nearly flat battery. */
export const BATTERY_RAN_OUT_LABEL = "The battery has most likely run out"
