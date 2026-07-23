import { groupOverlapping, metresPerPoint } from "./markerLayout"

const HOME = { lat: 51.4545, lon: -2.5879 }
// About 25 metres east, which is one house away.
const NEXT_DOOR = { lat: HOME.lat, lon: HOME.lon + 0.00036 }
// About two kilometres east.
const ACROSS_TOWN = { lat: HOME.lat, lon: HOME.lon + 0.029 }

describe("groupOverlapping", () => {
  it("leaves people alone who have room at this zoom", () => {
    const groups = groupOverlapping(
      [
        { id: "a", ...HOME },
        { id: "b", ...ACROSS_TOWN },
      ],
      15,
    )
    expect(groups.map((group) => group.ids)).toEqual([["a"], ["b"]])
    expect(groups[0]).toMatchObject({ key: "a", ...HOME })
  })

  it("puts a household on one marker, in the order given, in the middle of them", () => {
    const groups = groupOverlapping(
      [
        { id: "c", ...HOME },
        { id: "a", ...NEXT_DOOR },
        { id: "b", ...HOME },
      ],
      15,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.ids).toEqual(["c", "a", "b"])
    expect(groups[0]!.key).toBe("c|a|b")
    expect(groups[0]!.lon).toBeCloseTo(HOME.lon + 0.00012, 6)
  })

  it("lets a marker that measured wide reach further", () => {
    // About 120 metres apart: clear at zoom 15 for two plain faces, but not
    // for a marker whose name pill measured 200 points wide.
    const points = [
      { id: "a", ...HOME },
      { id: "b", lat: HOME.lat, lon: HOME.lon + 0.00173 },
    ]
    expect(groupOverlapping(points, 15)).toHaveLength(2)
    expect(groupOverlapping(points, 15, new Map([["a", 200]]))).toHaveLength(1)
  })

  it("chains neighbours into one group even when the ends are apart", () => {
    // Three in a line, each within reach of the next and the ends not.
    const points = [
      { id: "a", ...HOME },
      { id: "b", lat: HOME.lat, lon: HOME.lon + 0.0011 },
      { id: "c", lat: HOME.lat, lon: HOME.lon + 0.0022 },
    ]
    expect(groupOverlapping(points, 15).map((group) => group.ids)).toEqual([["a", "b", "c"]])
  })

  it("groups a whole town on a wide view and lets it go when zoomed in", () => {
    const points = [
      { id: "a", ...HOME },
      { id: "b", ...ACROSS_TOWN },
    ]
    expect(groupOverlapping(points, 8)).toHaveLength(1)
    expect(groupOverlapping(points, 14)).toHaveLength(2)
  })

  it("knows the ground resolution of the map", () => {
    // At the equator and zoom 0 the whole world is one 512 point tile.
    expect(metresPerPoint(0, 0) * 512).toBeCloseTo(40075016.7, -3)
    expect(metresPerPoint(51.45, 15)).toBeCloseTo(1.49, 2)
  })
})
