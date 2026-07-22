import { simplifyTrail } from "./trail"

// Roughly 0.00027 degrees of latitude is 30 metres.
const step = 0.0003

describe("simplifyTrail", () => {
  it("drops the indoor scribble and keeps real movement", () => {
    const home = { lat: 51.4545, lon: -2.5879 }
    const points = [
      home,
      { lat: home.lat + 0.00005, lon: home.lon }, // a few metres, a wobble
      { lat: home.lat - 0.00004, lon: home.lon + 0.00003 },
      { lat: home.lat + step, lon: home.lon }, // a real step
      { lat: home.lat + step + 0.00003, lon: home.lon }, // wobble again
      { lat: home.lat + 2 * step, lon: home.lon },
    ]
    const kept = simplifyTrail(points)
    expect(kept).toEqual([points[0], points[3], points[5]])
  })

  it("always keeps where they are now", () => {
    const a = { lat: 51.4545, lon: -2.5879 }
    const b = { lat: a.lat + 0.00002, lon: a.lon }
    expect(simplifyTrail([a, b])).toEqual([a, b])
  })

  it("leaves a single point and an empty trail alone", () => {
    expect(simplifyTrail([])).toEqual([])
    const only = { lat: 1, lon: 2 }
    expect(simplifyTrail([only])).toEqual([only])
  })
})
