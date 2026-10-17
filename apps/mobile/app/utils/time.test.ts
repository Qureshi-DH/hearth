import { translate } from "@/i18n/translate"

import { relativeTime } from "./time"

// babel-jest hoists these above the imports, so the real i18next and strings load.
jest.unmock("i18next")
jest.unmock("../i18n/index")

const NOW = Date.parse("2026-10-18T12:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("relativeTime", () => {
  it("says how long ago something happened", () => {
    expect(relativeTime(at(-10_000), NOW)).toBe("just now")
    expect(relativeTime(at(-5 * MINUTE), NOW)).toBe("5m ago")
    expect(relativeTime(at(-3 * HOUR), NOW)).toBe("3h ago")
    expect(relativeTime(at(-2 * DAY), NOW)).toBe("2d ago")
    expect(relativeTime(null, NOW)).toBe("never")
  })

  it("says how long until something happens", () => {
    expect(relativeTime(at(7 * DAY), NOW)).toBe("in 7 days")
    expect(relativeTime(at(DAY), NOW)).toBe("in 1 day")
    expect(relativeTime(at(5 * HOUR), NOW)).toBe("in 5 hours")
    expect(relativeTime(at(HOUR), NOW)).toBe("in 1 hour")
    expect(relativeTime(at(20 * MINUTE), NOW)).toBe("in 20 minutes")
  })

  it("reads a phone clock a little ahead of this one as now", () => {
    expect(relativeTime(at(2 * MINUTE), NOW)).toBe("just now")
  })

  it("gives an invite a week to run, not an expiry that has passed", () => {
    const expiry = relativeTime(at(7 * DAY - 1_000), NOW)
    expect(translate("circle:inviteExpires", { time: expiry })).toBe("Expires in 7 days")
  })
})
