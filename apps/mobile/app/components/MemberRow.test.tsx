import type { MemberPresence, PresenceIssue } from "@hearth/shared"

import { statusLine } from "./MemberRow"

function quietWith(issues: PresenceIssue[]): MemberPresence {
  return {
    userId: "omar",
    lat: 33.7,
    lon: 73.05,
    accuracyMeters: 59,
    recordedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
    batteryLevel: 0.4,
    isCharging: false,
    activity: "unknown",
    speedMps: null,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: true,
    atPlace: null,
    sosAlertId: null,
    issues,
  }
}

describe("statusLine", () => {
  it("names a phone whose background activity is restricted", () => {
    expect(statusLine(quietWith(["background_restricted"]))).toMatch(
      /map:issue_background_restricted/,
    )
  })

  it("names a phone that stopped Hearth in the background", () => {
    expect(statusLine(quietWith(["service_stopped"]))).toMatch(/map:issue_service_stopped/)
  })

  it("puts the phone's own complaint before where it last was", () => {
    const presence = { ...quietWith(["service_stopped"]), atPlace: null }
    expect(statusLine(presence, "F-8")).toMatch(/map:issue_service_stopped/)
    expect(statusLine(presence, "F-8")).not.toMatch(/map:near/)
  })

  // "At Home since" read as fine for a phone that had died at home.
  it("says a phone has gone quiet before it says where it last was", () => {
    const presence = {
      ...quietWith([]),
      atPlace: { id: "home", name: "Home", icon: null, since: new Date().toISOString() },
    }
    expect(statusLine(presence)).toMatch(/^map:stale/)
    expect(statusLine({ ...presence, stale: false })).toMatch(/map:atPlace/)
  })

  // A phone running out turns power saving on by itself, so the battery is
  // the better reason, and an older server that still sends the issue is
  // read the same way.
  it("says the battery likely ran out for a quiet phone last read nearly flat", () => {
    const flat = { ...quietWith(["low_power_mode"]), batteryLevel: 0.04 }
    expect(statusLine(flat)).toMatch(/^map:batteryRanOut · /)
    expect(statusLine({ ...flat, issues: [] })).toMatch(/^map:batteryRanOut · /)
  })

  it("still names a switch somebody turned off before the battery", () => {
    const flat = { ...quietWith(["location_permission"]), batteryLevel: 0.04 }
    expect(statusLine(flat)).toMatch(/map:issue_location_permission/)
  })

  it("does not blame the battery of a phone on the charger or still reporting", () => {
    const flat = { ...quietWith([]), batteryLevel: 0.04 }
    expect(statusLine({ ...flat, isCharging: true })).toMatch(/^map:stale/)
    expect(statusLine({ ...flat, stale: false })).not.toMatch(/batteryRanOut/)
  })

  it("says sharing was switched off even while the last fix is fresh", () => {
    const presence = {
      ...quietWith(["sharing_off", "precise_location"]),
      stale: false,
      recordedAt: new Date().toISOString(),
    }
    expect(statusLine(presence, "F-8")).toMatch(/map:issue_sharing_off/)
    expect(statusLine({ ...presence, issues: ["precise_location"] }, "F-8")).toMatch(/map:near/)
  })
})
