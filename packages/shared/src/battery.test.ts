import { describe, expect, it } from "vitest"

import { batteryRanOut, issuesBatteryExplains } from "./battery"

describe("batteryRanOut", () => {
  it("reads a reading of five percent or less off the charger as a phone that ran out", () => {
    expect(batteryRanOut(0.05, false)).toBe(true)
    expect(batteryRanOut(0, null)).toBe(true)
  })

  it("does not blame a battery with charge left, one on the charger, or one never read", () => {
    expect(batteryRanOut(0.06, false)).toBe(false)
    expect(batteryRanOut(0.02, true)).toBe(false)
    expect(batteryRanOut(null, false)).toBe(false)
    expect(batteryRanOut(undefined, undefined)).toBe(false)
  })
})

describe("issuesBatteryExplains", () => {
  // A switch somebody turned off is what a parent can put right, so it still
  // outranks the battery. What a dying phone does to itself does not.
  it("covers what a dying phone does to itself and none of the switches", () => {
    expect(issuesBatteryExplains).toEqual([
      "battery_optimisation",
      "low_power_mode",
      "background_restricted",
      "service_stopped",
    ])
  })
})
