import * as Localization from "expo-localization"

import { phoneClock } from "./phoneClock"

jest.mock("expo-localization", () => ({ getCalendars: jest.fn() }))

const calendars = Localization.getCalendars as jest.Mock

describe("the phone's clock", () => {
  it("is the time zone and the twelve or twenty-four hour clock the phone shows", () => {
    calendars.mockReturnValue([{ timeZone: "Europe/London", uses24hourClock: false }])
    expect(phoneClock()).toEqual({ timeZone: "Europe/London", clock: "12h" })
  })

  it("leaves out what the phone does not say", () => {
    calendars.mockReturnValue([{ timeZone: null, uses24hourClock: null }])
    const clock = phoneClock()
    expect(clock.clock).toBeUndefined()
    expect(clock.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
