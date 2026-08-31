import { describe, expect, it } from "vitest"

import { agreedMaxSpeedMps, agreedSpeedMps } from "./speed"

const ORIGIN = { lat: 51.4545, lon: -2.5879 }
const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (metres: number) => ({
  lat: ORIGIN.lat + metres / METRES_PER_DEGREE_LAT,
  lon: ORIGIN.lon,
})

const T0 = Date.parse("2026-09-17T14:00:00.000Z")
const at = (seconds: number) => new Date(T0 + seconds * 1000)

/** A fix every `interval` seconds, each one exactly as far on as its speed says. */
function run(
  speeds: Array<number | null>,
  options: { interval?: number; accuracy?: number; metresPerStep?: number } = {},
) {
  const interval = options.interval ?? 30
  let metres = 0
  return speeds.map((speedMps, i) => {
    const fix = {
      ...northOf(metres),
      recordedAt: at(i * interval),
      speedMps,
      accuracyMeters: options.accuracy ?? 8,
    }
    metres += options.metresPerStep ?? (speedMps ?? 0) * interval
    return fix
  })
}

const GAP = 5 * 60 * 1000

describe("agreedSpeedMps", () => {
  it("takes the faster of two readings within a tenth of each other", () => {
    expect(agreedSpeedMps(23.6, 25.5)).toBe(25.5)
  })

  it("takes the slower when they disagree by more", () => {
    expect(agreedSpeedMps(12, 62)).toBe(12)
  })

  it("has nothing to say when either reading is missing", () => {
    expect(agreedSpeedMps(null, 12)).toBeNull()
    expect(agreedSpeedMps(12, undefined)).toBeNull()
  })
})

describe("agreedMaxSpeedMps", () => {
  it("is null for fixes that carry no speed and cannot be paced", () => {
    expect(agreedMaxSpeedMps([], GAP)).toBeNull()
    expect(agreedMaxSpeedMps(run([null, null, null], { accuracy: 59 }), GAP)).toBeNull()
  })

  it("does not report a speed only one fix ever saw", () => {
    const fixes = run([12, 12, 12, 62, 12, 12], { metresPerStep: 360 })
    expect(agreedMaxSpeedMps(fixes, GAP)).toBe(12)
  })

  it("pairs across a fix that measured nothing, so an alert and a trip agree", () => {
    // GPS at 85 km/h, a network fix with no speed, GPS at 92 km/h, then the
    // crawl into the car park. Pairing only adjacent fixes would file this
    // drive at 21 km/h while the alert said 92.
    const fixes = run([23.6, null, 25.5, 5.8], { metresPerStep: 600 })
    expect(agreedMaxSpeedMps(fixes, GAP)).toBeCloseTo(25.5, 5)
  })

  it("keeps two agreeing fixes together even when a slower one sits nearer", () => {
    const fixes = [
      { ...northOf(0), recordedAt: at(0), speedMps: 8, accuracyMeters: 8 },
      { ...northOf(50), recordedAt: at(3), speedMps: 25, accuracyMeters: 8 },
      { ...northOf(300), recordedAt: at(13), speedMps: 25, accuracyMeters: 8 },
      { ...northOf(320), recordedAt: at(15), speedMps: 6, accuracyMeters: 8 },
    ]
    expect(agreedMaxSpeedMps(fixes, GAP)).toBe(25)
  })

  it("does not pair fixes separated by more than the gap", () => {
    const fixes = run([30, 30], { interval: 6 * 60, accuracy: 40 })
    expect(agreedMaxSpeedMps(fixes, GAP)).toBeNull()
  })

  it("floors the answer at the ground two sharp fixes covered", () => {
    // 250 m in 10 s is 90 km/h whatever the Doppler reading claimed.
    const fixes = run([5, 5], { interval: 10, metresPerStep: 250 })
    expect(agreedMaxSpeedMps(fixes, GAP)).toBeCloseTo((250 - 16) / 10, 5)
  })

  it("paces a drive whose fixes carried no speed at all", () => {
    const fixes = run([null, null], { interval: 10, metresPerStep: 250 })
    expect(agreedMaxSpeedMps(fixes, GAP)).toBeCloseTo((250 - 16) / 10, 5)
  })

  it("does not pace on coarse fixes or on fixes too close in time", () => {
    const coarse = run([5, 5], { interval: 10, metresPerStep: 250, accuracy: 59 })
    expect(agreedMaxSpeedMps(coarse, GAP)).toBe(5)
    const quick = run([5, 5], { interval: 4, metresPerStep: 250 })
    expect(agreedMaxSpeedMps(quick, GAP)).toBe(5)
  })

  it("reads timestamps as strings too, in any order", () => {
    const fixes = run([10, 11, 10]).map((fix) => ({
      ...fix,
      recordedAt: fix.recordedAt.toISOString(),
    }))
    expect(agreedMaxSpeedMps([fixes[2]!, fixes[0]!, fixes[1]!], GAP)).toBe(11)
  })
})
