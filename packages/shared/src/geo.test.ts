import { describe, expect, it } from "vitest"

import {
  activityFromSpeed,
  boundingBox,
  coarsenLocation,
  evaluateGeofence,
  formatDistance,
  haversineMeters,
  isValidLatLng,
  pathDistanceMeters,
} from "./geo"

const LONDON = { lat: 51.5074, lon: -0.1278 }
const PARIS = { lat: 48.8566, lon: 2.3522 }

describe("haversineMeters", () => {
  it("matches the known London-Paris great-circle distance", () => {
    const d = haversineMeters(LONDON, PARIS)
    expect(d).toBeGreaterThan(340_000)
    expect(d).toBeLessThan(345_000)
  })

  it("is zero for identical points", () => {
    expect(haversineMeters(LONDON, LONDON)).toBe(0)
  })

  it("is symmetric", () => {
    expect(haversineMeters(LONDON, PARIS)).toBeCloseTo(haversineMeters(PARIS, LONDON), 6)
  })
})

describe("evaluateGeofence", () => {
  const center = LONDON
  const radius = 100

  it("enters only within the strict radius", () => {
    const justOutside = { lat: center.lat + 0.0015, lon: center.lon } // ~167 m
    expect(
      evaluateGeofence({ point: justOutside, center, radiusMeters: radius, wasInside: false }),
    ).toBe(false)
  })

  it("keeps a member inside while they linger in the exit buffer", () => {
    const inBuffer = { lat: center.lat + 0.00105, lon: center.lon } // ~117 m
    expect(
      evaluateGeofence({
        point: inBuffer,
        center,
        radiusMeters: radius,
        wasInside: true,
        exitBufferMeters: 40,
      }),
    ).toBe(true)
    // The same point does not trigger a fresh arrival.
    expect(
      evaluateGeofence({
        point: inBuffer,
        center,
        radiusMeters: radius,
        wasInside: false,
        exitBufferMeters: 40,
      }),
    ).toBe(false)
  })

  it("releases once clear of radius + buffer", () => {
    const far = { lat: center.lat + 0.01, lon: center.lon }
    expect(
      evaluateGeofence({
        point: far,
        center,
        radiusMeters: radius,
        wasInside: true,
        exitBufferMeters: 40,
      }),
    ).toBe(false)
  })
})

describe("coarsenLocation", () => {
  it("is deterministic for the same input", () => {
    expect(coarsenLocation(LONDON)).toEqual(coarsenLocation(LONDON))
  })

  it("collapses nearby points onto the same grid cell", () => {
    const a = coarsenLocation({ lat: 51.5074, lon: -0.1278 }, 1000)
    const b = coarsenLocation({ lat: 51.5079, lon: -0.1281 }, 1000)
    expect(a).toEqual(b)
  })

  it("stays within roughly one grid cell of the true position", () => {
    const grid = 750
    const coarse = coarsenLocation(LONDON, grid)
    expect(haversineMeters(LONDON, coarse)).toBeLessThan(grid)
  })
})

describe("boundingBox", () => {
  it("returns null with no points", () => {
    expect(boundingBox([])).toBeNull()
  })

  it("contains all points", () => {
    const box = boundingBox([LONDON, PARIS])!
    expect(box.north).toBeCloseTo(51.5074)
    expect(box.south).toBeCloseTo(48.8566)
    expect(box.east).toBeCloseTo(2.3522)
    expect(box.west).toBeCloseTo(-0.1278)
  })

  it("expands when padded", () => {
    const tight = boundingBox([LONDON])!
    const padded = boundingBox([LONDON], 1000)!
    expect(padded.north).toBeGreaterThan(tight.north)
    expect(padded.west).toBeLessThan(tight.west)
  })
})

describe("pathDistanceMeters", () => {
  it("sums the legs", () => {
    const total = pathDistanceMeters([LONDON, PARIS, LONDON])
    expect(total).toBeCloseTo(haversineMeters(LONDON, PARIS) * 2, 3)
  })

  it("is zero for fewer than two points", () => {
    expect(pathDistanceMeters([LONDON])).toBe(0)
  })
})

describe("isValidLatLng", () => {
  it("rejects out-of-range and non-finite values", () => {
    expect(isValidLatLng({ lat: 91, lon: 0 })).toBe(false)
    expect(isValidLatLng({ lat: 0, lon: 181 })).toBe(false)
    expect(isValidLatLng({ lat: Number.NaN, lon: 0 })).toBe(false)
    expect(isValidLatLng({ lat: 0, lon: 0 })).toBe(true)
  })
})

describe("activityFromSpeed", () => {
  it("maps speeds to coarse activities", () => {
    expect(activityFromSpeed(null)).toBe("unknown")
    expect(activityFromSpeed(-1)).toBe("unknown")
    expect(activityFromSpeed(0.1)).toBe("still")
    expect(activityFromSpeed(1.4)).toBe("walking")
    expect(activityFromSpeed(3.0)).toBe("running")
    expect(activityFromSpeed(5)).toBe("cycling")
    expect(activityFromSpeed(20)).toBe("driving")
  })
})

describe("formatDistance", () => {
  it("switches units sensibly", () => {
    expect(formatDistance(120)).toBe("120 m")
    expect(formatDistance(3400)).toBe("3.4 km")
    expect(formatDistance(120, "imperial")).toBe("394 ft")
  })
})
