import type { AdminPhone } from "@hearth/shared"
import { describe, expect, it } from "vitest"

import { changeOnYesterday, phonesSummary, sortPhones, statusOf } from "./dashboard"

const phone = (overrides: Partial<AdminPhone>): AdminPhone => ({
  userId: overrides.displayName ?? "u",
  displayName: "Sabeen",
  avatarColor: "#f5643a",
  deviceName: "Pixel 9",
  platform: "android",
  appVersion: "1.1.0",
  lastHeardAt: "2026-10-01T11:57:00Z",
  state: "reporting",
  issues: [],
  ...overrides,
})

describe("the phones tile", () => {
  it("counts reporting, quiet and parked phones as heard from, and leaves out accounts with no phone", () => {
    const summary = phonesSummary([
      phone({ state: "reporting" }),
      phone({ state: "quiet" }),
      phone({ state: "parked" }),
      phone({ state: "never" }),
      phone({ state: "none", platform: null }),
    ])
    expect(summary.heard).toBe(3)
    expect(summary.total).toBe(4)
  })

  it("puts a phone that stopped reporting first", () => {
    expect(
      phonesSummary([
        phone({ state: "offline" }),
        phone({ state: "offline" }),
        phone({ state: "never" }),
        phone({ state: "reporting", issues: ["low_power_mode"] }),
      ]),
    ).toMatchObject({ foot: "2 stopped reporting", tone: "danger" })
  })

  it("then a phone with a setting off", () => {
    expect(
      phonesSummary([
        phone({ state: "never" }),
        phone({ state: "parked", issues: ["location_permission"] }),
      ]),
    ).toMatchObject({ foot: "1 phone has a setting off", tone: "warning" })
    expect(
      phonesSummary([
        phone({ state: "quiet", issues: ["background_refresh"] }),
        phone({ state: "reporting", issues: ["low_power_mode", "location_services"] }),
      ]),
    ).toMatchObject({ foot: "2 phones have a setting off", tone: "warning" })
  })

  it("then a phone that never reported", () => {
    expect(phonesSummary([phone({ state: "never" }), phone({ state: "reporting" })])).toMatchObject(
      { foot: "1 never reported", tone: "warning" },
    )
  })

  it("says all is well when every phone is heard from", () => {
    expect(
      phonesSummary([
        phone({ state: "reporting" }),
        phone({ state: "quiet" }),
        phone({ state: "parked" }),
        phone({ state: "none", platform: null }),
      ]),
    ).toMatchObject({ foot: "All phones are reporting", tone: "good" })
  })

  it("says so when no phone has signed in yet", () => {
    expect(phonesSummary([phone({ state: "none", platform: null })])).toMatchObject({
      foot: "No phones signed in yet",
      total: 0,
    })
  })
})

describe("the phones table", () => {
  it("puts the phones that need a hand first, those with a setting off first within each, then by name", () => {
    const sorted = sortPhones([
      phone({ displayName: "Zara", state: "reporting" }),
      phone({ displayName: "Ali", state: "none", platform: null }),
      phone({ displayName: "Bilal", state: "parked" }),
      phone({ displayName: "Hina", state: "quiet" }),
      phone({ displayName: "Omar", state: "never" }),
      phone({ displayName: "Sara", state: "offline" }),
      phone({ displayName: "Adam", state: "reporting" }),
      phone({ displayName: "Yusuf", state: "reporting", issues: ["low_power_mode"] }),
      phone({ displayName: "Imran", state: "offline", issues: ["service_stopped"] }),
    ])
    expect(sorted.map((p) => p.displayName)).toEqual([
      "Imran",
      "Sara",
      "Omar",
      "Hina",
      "Bilal",
      "Yusuf",
      "Adam",
      "Zara",
      "Ali",
    ])
  })

  it("leaves the list it was given alone", () => {
    const phones = [phone({ displayName: "B" }), phone({ displayName: "A" })]
    sortPhones(phones)
    expect(phones.map((p) => p.displayName)).toEqual(["B", "A"])
  })
})

describe("where a piece of the dashboard stands", () => {
  const loading = { data: undefined, isError: false }
  const failed = { data: undefined, isError: true }
  const ready = { data: 1, isError: false }
  const stale = { data: 1, isError: true }

  it("is ready once every request it needs has an answer, even an older one", () => {
    expect(statusOf(ready)).toBe("ready")
    expect(statusOf(ready, stale)).toBe("ready")
  })

  it("has failed when a request it needs failed with nothing to show", () => {
    expect(statusOf(failed)).toBe("failed")
    expect(statusOf(ready, failed)).toBe("failed")
    expect(statusOf(loading, failed)).toBe("failed")
  })

  it("is loading while a request is still on its way", () => {
    expect(statusOf(loading)).toBe("loading")
    expect(statusOf(ready, loading)).toBe("loading")
  })
})

describe("the change on yesterday", () => {
  it("says how much more or fewer, in whole percent", () => {
    expect(changeOnYesterday(120, 100)).toEqual({ text: "20% more than yesterday", tone: "up" })
    expect(changeOnYesterday(75, 100)).toEqual({ text: "25% fewer than yesterday", tone: "down" })
  })

  it("says the same when nothing moved, and nothing to compare with an empty yesterday", () => {
    expect(changeOnYesterday(100, 100)).toEqual({ text: "Same as yesterday", tone: "flat" })
    expect(changeOnYesterday(40, 0)).toEqual({ text: "None yesterday", tone: "flat" })
  })
})
