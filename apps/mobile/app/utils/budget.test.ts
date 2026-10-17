import { DEFAULTS } from "@hearth/shared"

import { load, remove } from "@/utils/storage"

import { minutesToWait, takeExport, takeMapRefresh, takeNudge, takePushTest } from "./budget"

const MINUTE = 60_000
const start = Date.UTC(2026, 9, 17, 9, 0)

beforeEach(() => remove("nudge-budget"))

describe("takeNudge", () => {
  it("lets the phone's budget through and stops the next one well short of the server's cap", () => {
    const answers = Array.from({ length: DEFAULTS.phoneNudgesPerTenMinutes + 1 }, (_, i) =>
      takeNudge(start + i * 1000),
    )
    expect(answers.slice(0, -1).every((wait) => wait === 0)).toBe(true)
    expect(answers[answers.length - 1]).toBeGreaterThan(0)
    expect(DEFAULTS.phoneNudgesPerTenMinutes).toBeLessThan(DEFAULTS.maxNudgesPerTenMinutes)
  })

  it("says how long until the oldest one leaves the window", () => {
    for (let i = 0; i < DEFAULTS.phoneNudgesPerTenMinutes; i += 1) takeNudge(start + i * MINUTE)
    expect(takeNudge(start + 7 * MINUTE)).toBe(3 * MINUTE)
  })

  it("does not count a refused tap against the budget", () => {
    for (let i = 0; i < DEFAULTS.phoneNudgesPerTenMinutes; i += 1) takeNudge(start)
    takeNudge(start + MINUTE)
    takeNudge(start + 2 * MINUTE)
    expect(takeNudge(start + 10 * MINUTE + 1)).toBe(0)
  })

  it("keeps what was spent in storage, so reopening the app does not reset it", () => {
    for (let i = 0; i < DEFAULTS.phoneNudgesPerTenMinutes; i += 1) takeNudge(start)
    expect(load<number[]>("nudge-budget")).toHaveLength(DEFAULTS.phoneNudgesPerTenMinutes)
  })
})

describe("the other budgets", () => {
  beforeEach(() => {
    remove("export-budget")
    remove("push-test-budget")
  })

  // The server takes three exports in ten minutes and five tests in five.
  it("stop an export and a test notification short of what the server allows", () => {
    const exports = [0, 1, 2].map((i) => takeExport(start + i * MINUTE))
    const tests = [0, 1, 2, 3].map((i) => takePushTest(start + i * 1000))
    expect(exports.map((wait) => wait > 0)).toEqual([false, false, true])
    expect(tests.map((wait) => wait > 0)).toEqual([false, false, false, true])
  })

  it("are counted apart from each other and from nudges", () => {
    for (let i = 0; i < 3; i += 1) takePushTest(start)
    expect(takeExport(start)).toBe(0)
    expect(takeNudge(start)).toBe(0)
  })

  it("say a wait of under a minute as one minute", () => {
    expect([minutesToWait(1), minutesToWait(60_000), minutesToWait(61_000)]).toEqual([1, 1, 2])
  })
})

describe("the map's asks for fresh fixes", () => {
  beforeEach(() => {
    const { storage } = require("@/utils/storage") as typeof import("@/utils/storage")
    storage.clearAll()
  })

  it("asks for a circle once in half a minute, and for another circle meanwhile", () => {
    expect([
      takeMapRefresh("home", start),
      takeMapRefresh("home", start + 10_000),
      takeMapRefresh("school", start + 10_000),
      takeMapRefresh("home", start + 31_000),
    ]).toEqual([true, false, true, true])
  })

  // The server's route takes 120 in ten minutes from one account.
  it("stops well short of the server's limit however many circles there are", () => {
    let asked = 0
    for (let i = 0; i < 200; i += 1) if (takeMapRefresh(`circle-${i}`, start + i)) asked += 1
    expect(asked).toBe(60)
  })
})
