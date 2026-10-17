import type { MemberPresence } from "@hearth/shared"

import { mergePresence, withPresence } from "./presence"

const presence = (userId: string, recordedAt: string | null, extra: Partial<MemberPresence> = {}) =>
  ({
    userId,
    lat: 51.4545,
    lon: -2.5879,
    accuracyMeters: 8,
    recordedAt,
    batteryLevel: 0.5,
    isCharging: false,
    activity: "driving",
    speedMps: 12,
    headingDegrees: null,
    approximate: false,
    sharingState: "precise",
    stale: false,
    atPlace: null,
    sosAlertId: null,
    issues: [],
    ...extra,
  }) as MemberPresence

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 10, 0, seconds)).toISOString()

describe("a member's presence arriving", () => {
  it("replaces what was there when it is newer", () => {
    const next = withPresence([presence("sam", t(1))], presence("sam", t(2), { lat: 51.46 }))
    expect(next[0]!.lat).toBe(51.46)
  })

  // A poll that left before a socket frame and was answered after it.
  it("never steps the dot back to an older fix", () => {
    const next = withPresence([presence("sam", t(5), { lat: 51.46 })], presence("sam", t(2)))
    expect(next[0]!.lat).toBe(51.46)
  })

  it("takes a change of sharing whatever its time says", () => {
    const paused = presence("sam", null, { lat: null, lon: null, sharingState: "paused" })
    expect(withPresence([presence("sam", t(5))], paused)[0]!.sharingState).toBe("paused")
    const coarse = presence("sam", t(0), { approximate: true, sharingState: "approximate" })
    expect(withPresence([presence("sam", t(5))], coarse)[0]!.approximate).toBe(true)
  })

  it("adds somebody who was not there", () => {
    expect(withPresence([presence("sam", t(1))], presence("ana", t(1)))).toHaveLength(2)
  })
})

describe("a whole list arriving", () => {
  it("keeps each member's newer fix and takes the list's word on who is in it", () => {
    const merged = mergePresence(
      [presence("sam", t(5), { lat: 51.46 }), presence("gone", t(5))],
      [presence("sam", t(2)), presence("ana", t(3))],
    )
    expect(merged.map((entry) => entry.userId)).toEqual(["sam", "ana"])
    expect(merged[0]!.lat).toBe(51.46)
  })

  it("is the list itself when nothing was there before", () => {
    const list = [presence("sam", t(2))]
    expect(mergePresence(undefined, list)).toBe(list)
  })
})
