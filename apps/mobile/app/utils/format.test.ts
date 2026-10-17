import { formatSpeed, speedFromKmh, speedToKmh, TRIP_SPEED_MIN_MPS } from "./format"

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

describe("speed alert units", () => {
  it("leaves km/h as it is", () => {
    expect(speedFromKmh(100, "metric")).toBe(100)
    expect(speedToKmh(100, "metric")).toBe(100)
  })

  it("shows the stored km/h in mph and stores mph as whole km/h", () => {
    expect(speedFromKmh(120, "imperial")).toBe(75)
    expect(speedToKmh(75, "imperial")).toBe(121)
  })

  // Typed in mph, stored in km/h and read back, the number has to be the one
  // that was typed.
  it("gives back the mph that was typed", () => {
    for (let mph = 0; mph <= 186; mph += 1) {
      expect(speedFromKmh(speedToKmh(mph, "imperial"), "imperial")).toBe(mph)
    }
  })
})
