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
})
