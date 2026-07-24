import { formatSpeed, TRIP_SPEED_MIN_MPS } from "./format"

describe("formatSpeed", () => {
  it("shows a live speed only from 10 km/h", () => {
    expect(formatSpeed(1.4, "metric")).toBeNull()
    expect(formatSpeed(2.7, "metric")).toBeNull()
    expect(formatSpeed(2.8, "metric")).toBe("10 km/h")
    expect(formatSpeed(13.9, "imperial")).toBe("31 mph")
  })

  it("shows a trip's pace even for a walk", () => {
    expect(formatSpeed(1.4, "metric", TRIP_SPEED_MIN_MPS)).toBe("5 km/h")
    expect(formatSpeed(0.2, "metric", TRIP_SPEED_MIN_MPS)).toBeNull()
  })
})
