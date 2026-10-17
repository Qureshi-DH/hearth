import type { Translations } from "./en"

/** Loads the strings as the given platform would, in a registry of their own. */
function stringsOn(platform: "android" | "ios"): Translations {
  let strings: Translations | undefined
  jest.isolateModules(() => {
    const { Platform } = require("react-native")
    Platform.OS = platform
    strings = (require("./en") as typeof import("./en")).default
  })
  return strings!
}

/**
 * Each system names the choice its own way, and somebody looking at the
 * permission dialog looks for the words this screen told them to tap.
 */
describe("the background location choice", () => {
  const asked = (strings: Translations) => [
    strings.permissions.subtitle,
    strings.permissions.locationTitle,
    strings.permissions.locationForegroundBody,
    strings.permissions.always,
    strings.permissions.whyTitle,
  ]

  it("uses Android's words on Android", () => {
    const strings = stringsOn("android")
    for (const text of asked(strings)) expect(text).not.toMatch(/Always|While Using/)
    expect(strings.permissions.always).toBe("Allow all the time")
    expect(strings.permissions.subtitle).toContain('"Allow all the time"')
    // The prominent disclosure Play reviewers look for before the system prompt.
    expect(strings.permissions.subtitle).toContain(
      "Hearth collects location data to enable family location sharing, arrival alerts and crash detection even when the app is closed or not in use.",
    )
  })

  it("keeps the iPhone's on iOS", () => {
    const strings = stringsOn("ios")
    expect(strings.permissions.always).toBe('Allow "Always"')
    expect(strings.permissions.subtitle).toContain('"Always"')
    expect(strings.permissions.locationForegroundBody).toContain('"While Using"')
  })

  it("names somebody else's phone in words that fit either", () => {
    for (const platform of ["android", "ios"] as const) {
      expect(stringsOn(platform).map.issue_location_permission).not.toMatch(/Always/)
    }
  })
})
