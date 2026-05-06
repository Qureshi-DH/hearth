import { stillnessDecision, thin } from "./tracker"

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString()

describe("stillnessDecision", () => {
  const anchor = { lat: 51.4545, lon: -2.5879, since: at(0) }

  it("anchors on the first fix of a stretch", () => {
    expect(stillnessDecision(null, { lat: 51.4545, lon: -2.5879, recordedAt: at(0) })).toBe(
      "reanchor",
    )
  })

  it("waits while the phone has been still for less than the threshold", () => {
    expect(stillnessDecision(anchor, { lat: 51.4545, lon: -2.5879, recordedAt: at(4) })).toBe(
      "wait",
    )
  })

  it("settles once it has been still long enough", () => {
    expect(stillnessDecision(anchor, { lat: 51.4545, lon: -2.5879, recordedAt: at(5) })).toBe(
      "settle",
    )
  })

  it("treats GPS jitter inside the radius as still", () => {
    // ~20 m north of the anchor, which a parked phone drifts by routinely.
    expect(stillnessDecision(anchor, { lat: 51.45468, lon: -2.5879, recordedAt: at(6) })).toBe(
      "settle",
    )
  })

  it("re-anchors when the phone actually moves, however long it sat before", () => {
    // ~300 m away, so the still window has to start over rather than settle.
    expect(stillnessDecision(anchor, { lat: 51.4572, lon: -2.5879, recordedAt: at(30) })).toBe(
      "reanchor",
    )
  })
})

describe("thin", () => {
  const policy = { minUpdateIntervalSeconds: 30, distanceFilterMeters: 60 }

  it("drops a burst of near-identical samples", () => {
    const fixes = [0, 1, 2].map((i) => ({
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      lat: 51.4545,
      lon: -2.5879,
      accuracyMeters: 10,
      altitudeMeters: null,
      altitudeAccuracyMeters: null,
      speedMps: null,
      headingDegrees: null,
      batteryLevel: null,
      isCharging: null,
      source: "background" as const,
    }))
    expect(thin(fixes, null, policy)).toHaveLength(1)
  })
})
