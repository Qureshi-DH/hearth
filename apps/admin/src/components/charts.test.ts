import { describe, expect, it } from "vitest"

import { dayOfMonth, longDay, niceMax } from "./charts"

describe("a chart's top line", () => {
  it("rounds up to a number gridlines can sit on", () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(1247)).toBe(2000)
    expect(niceMax(230)).toBe(250)
    expect(niceMax(500)).toBe(500)
  })
})

describe("a chart's days", () => {
  it("reads the server's YYYY-MM-DD as that calendar day", () => {
    expect(longDay("2026-10-01")).toBe("Thu 1 Oct")
    expect(dayOfMonth("2026-10-01")).toBe("1")
    expect(dayOfMonth("2026-02-28")).toBe("28")
  })

  it("shows a day it cannot read as it came, rather than Invalid Date", () => {
    expect(longDay("yesterday")).toBe("yesterday")
    expect(dayOfMonth("2026-13-45")).toBe("2026-13-45")
    expect(dayOfMonth("2026-10")).toBe("2026-10")
  })
})
