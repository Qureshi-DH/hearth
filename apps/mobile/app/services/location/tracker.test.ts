import type { LocationObject } from "expo-location"

import { stillnessDecision, stillRadiusMeters, thin, toFix } from "./tracker"

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

  it("settles on fixes spaced at the OS distance filter", () => {
    // ~100 m north, which on a circle asking for a 100 m filter is the nearest
    // fix the OS will ever deliver. Judged against the bare floor it reads as
    // movement, so the phone re-anchors on every fix it can see and the stop is
    // never called from the location path at all.
    const radius = stillRadiusMeters({ minUpdateIntervalSeconds: 30, distanceFilterMeters: 100 })
    expect(
      stillnessDecision(anchor, { lat: 51.45539, lon: -2.5879, recordedAt: at(6) }, radius),
    ).toBe("settle")
  })
})

describe("stillRadiusMeters", () => {
  it("clears the distance filter anywhere in the range a circle may set", () => {
    for (const distanceFilterMeters of [0, 30, 60, 100, 500, 5000]) {
      expect(
        stillRadiusMeters({ minUpdateIntervalSeconds: 30, distanceFilterMeters }),
      ).toBeGreaterThan(distanceFilterMeters)
    }
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

  it("measures an east-west step in metres rather than in degrees", () => {
    // A degree of longitude is 111 km only at the equator. Scaling the raw
    // degree gap by that constant reads this 25 m step as 40 m at Bristol's
    // latitude and keeps a sample the burst rule exists to drop, and the error
    // grows towards the poles until the thinning is off entirely.
    const sample = (seconds: number, lon: number) => ({
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
      lat: 51.4545,
      lon,
      accuracyMeters: 10,
      altitudeMeters: null,
      altitudeAccuracyMeters: null,
      speedMps: null,
      headingDegrees: null,
      batteryLevel: null,
      isCharging: null,
      source: "background" as const,
    })
    expect(thin([sample(0, -2.5879), sample(5, -2.58754)], null, policy)).toHaveLength(1)
  })
})

describe("toFix", () => {
  const battery = { batteryLevel: 0.62, isCharging: false }
  const location = (coords: Partial<LocationObject["coords"]>): LocationObject => ({
    timestamp: Date.UTC(2026, 0, 1, 18, 2),
    coords: {
      latitude: 51.4545,
      longitude: -2.5879,
      altitude: 0,
      accuracy: 65,
      altitudeAccuracy: 10,
      heading: -1,
      speed: -1,
      ...coords,
    },
  })

  it("keeps a reading the phone actually made", () => {
    const fix = toFix(location({}), "background", battery)
    expect(fix.accuracyMeters).toBe(65)
    expect(fix.altitudeAccuracyMeters).toBe(10)
  })

  it("drops the negative sentinel iOS reports for a measurement it could not make", () => {
    // CoreLocation returns a negative accuracy whenever that component is
    // invalid, which is routine for altitude on a fix derived from Wi-Fi or
    // cell. Speed and heading are already guarded that way on the next two
    // lines of toFix, and the server rejects the whole batch over one of these.
    const fix = toFix(location({ accuracy: -1, altitudeAccuracy: -1 }), "background", battery)
    expect(fix.altitudeAccuracyMeters).toBeNull()
    expect(fix.accuracyMeters).toBeNull()
    expect(fix.speedMps).toBeNull()
    expect(fix.headingDegrees).toBeNull()
  })
})
