import { PLATFORMS, PRESENCE_ISSUES, PUSH_PROVIDERS, REGISTRATION_MODES } from "@hearth/shared"
import { describe, expect, it } from "vitest"

import {
  BATTERY_RAN_OUT_LABEL,
  ISSUE_LABEL,
  PHONE_STATE_LABEL,
  PLATFORM_LABEL,
  PUSH_PROVIDER_DETAIL,
  PUSH_PROVIDER_LABEL,
  SIGN_UP_LABEL,
} from "./labels"

/** Each label is shown as it is, so it must read as words. */
function readsAsWords(text: string | undefined) {
  expect(text).toBeTruthy()
  expect(text).not.toMatch(/[\u2014\u2013;_]/)
}

describe("the portal's labels", () => {
  it("name every value the server can send", () => {
    for (const value of PUSH_PROVIDERS) {
      readsAsWords(PUSH_PROVIDER_LABEL[value])
      readsAsWords(PUSH_PROVIDER_DETAIL[value])
    }
    for (const value of REGISTRATION_MODES) readsAsWords(SIGN_UP_LABEL[value])
    for (const value of PLATFORMS) readsAsWords(PLATFORM_LABEL[value])
    for (const value of PRESENCE_ISSUES) readsAsWords(ISSUE_LABEL[value])
  })

  it("say what each phone state means", () => {
    expect(PHONE_STATE_LABEL).toEqual({
      reporting: "Reporting",
      quiet: "Quiet",
      parked: "Parked",
      offline: "Stopped reporting",
      never: "Never reported",
      none: "No phone",
    })
  })

  it("say what a phone's issue is in a sentence", () => {
    expect(ISSUE_LABEL).toEqual({
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
    })
  })

  // The app says the same under the member's name, and the offline alert
  // says it too, so nobody reads "Power saving mode is on" for a dead phone.
  it("say a quiet phone's battery likely ran out", () => {
    expect(BATTERY_RAN_OUT_LABEL).toBe("The battery has most likely run out")
    readsAsWords(BATTERY_RAN_OUT_LABEL)
  })

  it("use one wording for sign-up, wherever it is shown", () => {
    expect(SIGN_UP_LABEL).toEqual({ open: "Anyone", invite: "Invite only", closed: "Nobody" })
  })
})
