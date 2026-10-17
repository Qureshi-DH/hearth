import { describe, expect, it } from "vitest"

import { clockTime, wordPlaceNews, type Wording } from "../../services/place-news"

/**
 * How place news reads. The same parts are worded once when the row is queued
 * and again when it goes out, for the person it goes to.
 */

const at = "2026-10-17T03:02:00.000Z"
const now = new Date(Date.parse(at) + 30_000)
const lateNow = new Date(Date.parse(at) + 25 * 60_000)
const lateAfter = new Date(Date.parse(at) + 2 * 60_000).toISOString()

const arrival: Wording = {
  who: "Aisha",
  kind: "arrive",
  place: "School",
  journey: { from: "Home", meters: 4200, seconds: 14 * 60 },
  at,
  lateAfter,
}

describe("what place news says", () => {
  it("carries the journey on an arrival", () => {
    expect(wordPlaceNews(arrival, undefined, now)).toEqual({
      body: "Aisha arrived at School, 4.2 km from Home in 14 min",
      line: "Arrived at School, 4.2 km from Home in 14 min",
    })
  })

  it("says when, once the news is late, on the reader's own clock", () => {
    const reader = { units: "metric" as const, timeZone: "Asia/Karachi", clock: "24h" as const }
    expect(wordPlaceNews(arrival, reader, lateNow).body).toBe(
      "Aisha arrived at School at 8:02, 4.2 km from Home in 14 min",
    )
    expect(
      wordPlaceNews({ ...arrival, kind: "leave", place: "Home", journey: null }, reader, lateNow),
    ).toEqual({ body: "Aisha left Home at 8:02", line: "Left Home at 8:02" })
  })

  it("says how long ago to a phone that never gave its time zone", () => {
    expect(wordPlaceNews({ ...arrival, journey: null }, undefined, lateNow).body).toBe(
      "Aisha arrived at School 25 min ago",
    )
  })

  it("leaves the time out of an arrival when nothing says when they set off", () => {
    const parked = { ...arrival, journey: { from: "Home", meters: 3000, seconds: null } }
    expect(wordPlaceNews(parked, undefined, now).body).toBe(
      "Aisha arrived at School, 3.0 km from Home",
    )
  })

  it("words a journey that ended nowhere the family named", () => {
    const stop: Wording = { ...arrival, kind: "stop", place: null }
    expect(wordPlaceNews(stop, undefined, now).body).toBe("Aisha stopped 4.2 km from Home")
    const nowhere = { ...stop, journey: { from: null, meters: 900, seconds: 300 } }
    expect(wordPlaceNews(nowhere, undefined, now).line).toBe("Stopped after 900 m")
  })

  it("uses the reader's units", () => {
    const reader = { units: "imperial" as const, timeZone: null, clock: null }
    expect(wordPlaceNews(arrival, reader, now).line).toBe(
      "Arrived at School, 2.6 mi from Home in 14 min",
    )
  })

  it("reads a twelve hour clock the way the phone shows it", () => {
    expect(clockTime(new Date(at), "America/New_York", "12h")).toBe("11:02 PM")
  })
})
