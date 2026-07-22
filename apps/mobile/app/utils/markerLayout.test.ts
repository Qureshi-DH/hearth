import { metresPerPoint, spreadOverlapping } from "./markerLayout"

const HOME = { lat: 51.4545, lon: -2.5879 }
// About 25 metres east, which is one house away.
const NEXT_DOOR = { lat: HOME.lat, lon: HOME.lon + 0.00036 }
// About two kilometres east.
const ACROSS_TOWN = { lat: HOME.lat, lon: HOME.lon + 0.029 }

describe("spreadOverlapping", () => {
  it("leaves people alone who have room at this zoom", () => {
    const offsets = spreadOverlapping(
      [
        { id: "a", ...HOME },
        { id: "b", ...ACROSS_TOWN },
      ],
      15,
    )
    expect(offsets.size).toBe(0)
  })

  it("lays a household out in a row, centred on the house, in the order given", () => {
    const offsets = spreadOverlapping(
      [
        { id: "c", ...HOME },
        { id: "a", ...NEXT_DOOR },
        { id: "b", ...HOME },
      ],
      15,
    )
    expect(offsets.get("c")).toEqual([-62, 0])
    expect(offsets.get("a")).toEqual([0, 0])
    expect(offsets.get("b")).toEqual([62, 0])
  })

  it("gives a wide name pill the room it measured", () => {
    const offsets = spreadOverlapping(
      [
        { id: "a", ...HOME },
        { id: "b", ...HOME },
      ],
      15,
      new Map([["a", 100]]),
    )
    // Row is 100 + 6 + 56 wide, centred.
    expect(offsets.get("a")).toEqual([-31, 0])
    expect(offsets.get("b")).toEqual([53, 0])
  })

  it("moves to rows past three, each row centred", () => {
    const offsets = spreadOverlapping(
      ["a", "b", "c", "d", "e"].map((id) => ({ id, ...HOME })),
      15,
    )
    expect(offsets.get("a")).toEqual([-62, -42])
    expect(offsets.get("b")).toEqual([0, -42])
    expect(offsets.get("c")).toEqual([62, -42])
    expect(offsets.get("d")).toEqual([-31, 42])
    expect(offsets.get("e")).toEqual([31, 42])
  })

  it("groups a whole town on a wide view and lets it go when zoomed in", () => {
    const points = [
      { id: "a", ...HOME },
      { id: "b", ...ACROSS_TOWN },
    ]
    expect(spreadOverlapping(points, 8).size).toBe(2)
    expect(spreadOverlapping(points, 14).size).toBe(0)
  })

  it("knows the ground resolution of the map", () => {
    // At the equator and zoom 0 the whole world is one 512 point tile.
    expect(metresPerPoint(0, 0) * 512).toBeCloseTo(40075016.7, -3)
    expect(metresPerPoint(51.45, 15)).toBeCloseTo(1.49, 2)
  })
})
