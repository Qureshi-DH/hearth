import type { ComponentProps } from "react"
import type { Ionicons } from "@expo/vector-icons"
import type { EventType, PlaceIcon } from "@hearth/shared"

export type IoniconName = ComponentProps<typeof Ionicons>["name"]
export type Tone = "neutral" | "tint" | "success" | "warning" | "error" | "info"

export function eventVisual(type: EventType): { icon: IoniconName; tone: Tone } {
  switch (type) {
    case "place_arrive":
      return { icon: "enter-outline", tone: "success" }
    case "place_leave":
      return { icon: "exit-outline", tone: "info" }
    case "check_in":
      return { icon: "checkmark-circle", tone: "success" }
    case "sos_started":
      return { icon: "alert-circle", tone: "error" }
    case "sos_resolved":
      return { icon: "shield-checkmark", tone: "success" }
    case "low_battery":
      return { icon: "battery-dead", tone: "warning" }
    case "device_offline":
      return { icon: "cloud-offline-outline", tone: "warning" }
    case "device_online":
      return { icon: "cloud-done-outline", tone: "success" }
    case "sharing_paused":
      return { icon: "eye-off-outline", tone: "neutral" }
    case "sharing_resumed":
      return { icon: "eye-outline", tone: "neutral" }
    case "member_joined":
      return { icon: "person-add-outline", tone: "tint" }
    case "member_left":
    case "member_removed":
      return { icon: "person-remove-outline", tone: "neutral" }
    case "role_changed":
      return { icon: "ribbon-outline", tone: "tint" }
    case "place_created":
    case "place_updated":
    case "place_deleted":
      return { icon: "location-outline", tone: "neutral" }
    case "nudge_requested":
      return { icon: "hand-left-outline", tone: "info" }
    case "trip_completed":
      return { icon: "car-outline", tone: "info" }
    case "speed_alert":
      return { icon: "speedometer", tone: "warning" }
    case "possible_incident":
      return { icon: "warning", tone: "error" }
    default:
      return { icon: "ellipse-outline", tone: "neutral" }
  }
}

export function placeIconName(icon: PlaceIcon | null | undefined): IoniconName {
  switch (icon) {
    case "home":
      return "home"
    case "work":
      return "briefcase"
    case "school":
      return "school"
    case "gym":
      return "barbell"
    case "store":
      return "cart"
    case "restaurant":
      return "restaurant"
    case "hospital":
      return "medkit"
    case "park":
      return "leaf"
    case "airport":
      return "airplane"
    case "mosque":
      return "moon"
    case "church":
      return "business"
    case "friend":
      return "people"
    case "pin":
    default:
      return "location"
  }
}

export function activityIconName(activity: string | null | undefined): IoniconName | null {
  switch (activity) {
    case "driving":
      return "car"
    case "cycling":
      return "bicycle"
    case "running":
      return "fitness"
    case "walking":
      return "walk"
    default:
      return null
  }
}

/**
 * How recently a phone has to have spoken for Live to be worth offering.
 * A travelling phone uploads every half minute; one that has said nothing
 * for this long is out of signal, asleep, or has stopped reporting, and
 * the page would sit on "asking" until the window lapsed. The button is a
 * promise that pressing it works, so it is shown only when it will.
 */
export const LIVE_OFFER_MAX_AGE_MS = 3 * 60 * 1000

/**
 * Whether a member is travelling right now, as their phone last said. Live
 * is offered for them and nobody else: a parked phone has nothing to show
 * live, and asking it would only cost battery.
 */
export function onTheMove(
  presence:
    | { activity: string | null; stale: boolean; sharingState: string; recordedAt?: string | null }
    | null
    | undefined,
  now: number = Date.now(),
): boolean {
  if (!presence || presence.stale || presence.sharingState !== "precise") return false
  const heardAt = presence.recordedAt ? Date.parse(presence.recordedAt) : NaN
  if (!Number.isFinite(heardAt) || now - heardAt > LIVE_OFFER_MAX_AGE_MS) return false
  return (
    presence.activity === "driving" ||
    presence.activity === "cycling" ||
    presence.activity === "running" ||
    presence.activity === "walking"
  )
}

/**
 * Whether they have settled somewhere the family has not named. Their phone
 * says where it is and calls itself still, and no place contains it: the
 * moment to offer to name it.
 */
export function atUnnamedSpot(
  presence:
    | {
        lat: number | null
        lon: number | null
        activity: string | null
        approximate: boolean
        sharingState: string
        atPlace: unknown | null
      }
    | null
    | undefined,
): presence is { lat: number; lon: number } & typeof presence & object {
  if (!presence || presence.atPlace) return false
  if (presence.lat == null || presence.lon == null) return false
  if (presence.approximate || presence.sharingState !== "precise") return false
  // Travelling is not being anywhere yet, and the spot would be the road.
  return !(
    presence.activity === "driving" ||
    presence.activity === "cycling" ||
    presence.activity === "running" ||
    presence.activity === "walking"
  )
}
