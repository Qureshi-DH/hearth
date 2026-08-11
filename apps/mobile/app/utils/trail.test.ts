import { simplifyTrail, splitTrail } from "./trail"

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

describe("splitTrail", () => {
  const a = { lat: 51.4545, lon: -2.5879 }
  const b = { lat: a.lat + 0.001, lon: a.lon } // about 110 m on
  const c = { lat: b.lat + 0.001, lon: a.lon }
  const far = { lat: c.lat + 0.02, lon: a.lon } // over two kilometres of silence
  const after = { lat: far.lat + 0.001, lon: a.lon }

  it("draws what the phone reported and marks what it did not", () => {
    const { drawn, gaps } = splitTrail([a, b, c, far, after], 500)
    expect(drawn).toEqual([
      [a, b, c],
      [far, after],
    ])
    expect(gaps).toEqual([[c, far]])
  })

  it("is one line when every step was reported", () => {
    const { drawn, gaps } = splitTrail([a, b, c], 500)
    expect(drawn).toEqual([[a, b, c]])
    expect(gaps).toEqual([])
  })

  it("has nothing to draw between two lone fixes", () => {
    const { drawn, gaps } = splitTrail([a, far], 500)
    expect(drawn).toEqual([])
    expect(gaps).toEqual([[a, far]])
  })

  it("draws a motorway stretch the phone reported every ten seconds", () => {
    // 600 m apart, ten seconds apart: a fast road, thinned by the upload
    // gate, not a silence.
    const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 9, 0, seconds)).toISOString()
    const p1 = { lat: a.lat, lon: a.lon, recordedAt: t(0) }
    const p2 = { lat: a.lat + 0.0054, lon: a.lon, recordedAt: t(10) }
    const p3 = { lat: a.lat + 0.0108, lon: a.lon, recordedAt: t(20) }
    const { drawn, gaps } = splitTrail([p1, p2, p3], 500)
    expect(drawn).toEqual([[p1, p2, p3]])
    expect(gaps).toEqual([])
  })

  it("marks the same stretch a silence when the fixes are minutes apart", () => {
    const t = (minutes: number) => new Date(Date.UTC(2026, 8, 15, 9, minutes)).toISOString()
    const p1 = { lat: a.lat, lon: a.lon, recordedAt: t(0) }
    const p2 = { lat: a.lat + 0.0054, lon: a.lon, recordedAt: t(10) }
    const { drawn, gaps } = splitTrail([p1, p2], 500)
    expect(drawn).toEqual([])
    expect(gaps).toEqual([[p1, p2]])
  })

  describe("against the driving upload gate", () => {
    const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 9, 0, seconds)).toISOString()
    // The gate lets a fix through every 300 m at speed. With slack for a fix
    // that lands late, 450 m in 30 s is the widest step a gated drive makes.
    const gateStep = 0.00404 // about 449 m of latitude

    it("draws the steps of a gated drive as one line", () => {
      const p1 = { lat: a.lat, lon: a.lon, recordedAt: t(0) }
      const p2 = { lat: a.lat + gateStep, lon: a.lon, recordedAt: t(30) }
      const p3 = { lat: a.lat + 2 * gateStep, lon: a.lon, recordedAt: t(60) }
      const { drawn, gaps } = splitTrail([p1, p2, p3])
      expect(drawn).toEqual([[p1, p2, p3]])
      expect(gaps).toEqual([])
    })

    it("dashes a step that is beyond the gate in both distance and time", () => {
      const p1 = { lat: a.lat, lon: a.lon, recordedAt: t(0) }
      const p2 = { lat: a.lat + 0.005, lon: a.lon, recordedAt: t(70) } // about 555 m
      const { drawn, gaps } = splitTrail([p1, p2])
      expect(drawn).toEqual([])
      expect(gaps).toEqual([[p1, p2]])
    })

    it("does not dash a crawl: a phone that barely moved has no road unreported", () => {
      // Five minutes to cover 300 m is a traffic jam, and the gate lets one
      // fix through every few minutes of a stop. The line is the road.
      const p1 = { lat: a.lat, lon: a.lon, recordedAt: t(0) }
      const p2 = { lat: a.lat + 0.0027, lon: a.lon, recordedAt: t(300) }
      const { drawn, gaps } = splitTrail([p1, p2])
      expect(drawn).toEqual([[p1, p2]])
      expect(gaps).toEqual([])
    })

    it("dashes a long step it cannot date", () => {
      const p1 = { lat: a.lat, lon: a.lon }
      const p2 = { lat: a.lat + 0.005, lon: a.lon }
      const { gaps } = splitTrail([p1, p2])
      expect(gaps).toEqual([[p1, p2]])
    })
  })
})
