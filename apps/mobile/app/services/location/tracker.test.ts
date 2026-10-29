import type { LocationObject } from "expo-location"

import { pingActivity, thin, toFix } from "./tracker"

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString()
const HOME = { lat: 33.6844, lon: 73.0479 }

describe("pingActivity", () => {
  // About 111 m a thousandth of a degree north. The same cases as the native
  // side's own label, in UploadWireTest.kt, so the two platforms agree.
  const ping = (minutes: number, lat: number, accuracyMeters: number, speedMps?: number) => ({
    recordedAt: at(minutes),
    lat,
    lon: HOME.lon,
    accuracyMeters,
    speedMps: speedMps ?? null,
  })

  it("takes a speed the GPS measured at its word", () => {
    expect(pingActivity(ping(5, HOME.lat, 6, 14), null)).toBe("driving")
    expect(pingActivity(ping(5, HOME.lat, 6, 0), null)).toBe("still")
    expect(pingActivity(ping(5, HOME.lat, 6, 2), null)).toBe("unknown")
  })

  it("calls a phone still that stayed inside the two error circles and a little", () => {
    expect(pingActivity(ping(5, HOME.lat, 40), ping(0, HOME.lat + 0.0005, 30))).toBe("still")
  })

  it("calls road speed between two pings a drive", () => {
    expect(pingActivity(ping(5, HOME.lat + 0.03, 40), ping(0, HOME.lat, 30))).toBe("driving")
  })

  it("says nothing of a walk's worth, which could be anything", () => {
    expect(pingActivity(ping(5, HOME.lat + 0.004, 40), ping(0, HOME.lat, 30))).toBe("unknown")
  })

  it("says nothing of pings too close or too far apart in time", () => {
    expect(pingActivity(ping(0.5, HOME.lat, 40), ping(0, HOME.lat, 30))).toBe("unknown")
    expect(pingActivity(ping(90, HOME.lat, 40), ping(0, HOME.lat, 30))).toBe("unknown")
  })

  it("says nothing with nothing to compare against", () => {
    expect(pingActivity(ping(5, HOME.lat, 40), null)).toBe("unknown")
  })

  // A cell estimate a kilometre and more wide.
  it("does not call a phone still on estimates too loose to show it", () => {
    expect(pingActivity(ping(5, HOME.lat + 0.0135, 1500), ping(0, HOME.lat, 1500))).toBe("unknown")
  })

  it("does not call a loose estimate far off a drive", () => {
    expect(pingActivity(ping(5, HOME.lat + 0.018, 500), ping(0, HOME.lat, 30))).toBe("unknown")
  })
})

describe("thin", () => {
  const sample = (ms: number, source: "background" | "sos" = "background") => ({
    recordedAt: new Date(Date.UTC(2026, 0, 1) + ms).toISOString(),
    lat: HOME.lat,
    lon: HOME.lon,
    source,
  })

  it("keeps a fix a second from a burst of three", () => {
    const kept = thin([sample(0), sample(200), sample(400), sample(1_000)], null, 1_000)
    expect(kept.map((fix) => fix.recordedAt)).toEqual([
      sample(0).recordedAt,
      sample(1_000).recordedAt,
    ])
  })

  it("never drops an SOS fix", () => {
    expect(thin([sample(0), sample(100, "sos")], null, 1_000)).toHaveLength(2)
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
    const fix = toFix(location({}), "background", battery, null)
    expect(fix.accuracyMeters).toBe(65)
    expect(fix.altitudeAccuracyMeters).toBe(10)
  })

  it("drops the negative sentinel iOS reports for a measurement it could not make", () => {
    // CoreLocation returns a negative accuracy whenever that component is
    // invalid, which is routine for altitude on a fix derived from Wi-Fi or
    // cell. Speed and heading are already guarded that way on the next two
    // lines of toFix, and the server rejects the whole batch over one of these.
    const fix = toFix(location({ accuracy: -1, altitudeAccuracy: -1 }), "background", battery, null)
    expect(fix.altitudeAccuracyMeters).toBeNull()
    expect(fix.accuracyMeters).toBeNull()
    expect(fix.speedMps).toBeNull()
    expect(fix.headingDegrees).toBeNull()
  })

  it("labels the fix against the one before it", () => {
    const before = { recordedAt: at(0), lat: 51.4545, lon: -2.5879, accuracyMeters: 30 }
    const fix = toFix(location({ accuracy: 40 }), "nudge", battery, {
      ...before,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 17, 57)).toISOString(),
    })
    expect(fix.activity).toBe("still")
  })
})
