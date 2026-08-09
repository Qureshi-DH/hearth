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
})
