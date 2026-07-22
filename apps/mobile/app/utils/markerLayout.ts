import { haversineMeters } from "@hearth/shared"

export interface Positioned {
  id: string
  lat: number
  lon: number
}

/** What a marker is assumed to be wide until its name pill has been measured. */
export const MARKER_WIDTH_PX = 56
/** Avatar, pointer and name pill, with room for the selected size. */
export const MARKER_ROW_PX = 84
export const MARKER_GAP_PX = 6

/**
 * Web Mercator ground resolution at the equator, metres per point at zoom 0.
 * MapLibre zooms over 512 point tiles, so this is half the figure quoted for
 * 256 pixel slippy maps.
 */
const EQUATOR_METRES_PER_POINT = 78271.517

export function metresPerPoint(lat: number, zoom: number): number {
  return (EQUATOR_METRES_PER_POINT * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/**
 * Point offsets that keep markers off each other at this zoom.
 *
 * A family at home is four faces on one spot, and on a city wide view a
 * whole town is. A cluster badge would hide who is there, so everyone who
 * would overlap is laid out side by side instead: a row of up to three, rows
 * of a grid past that, centred on the shared spot. Zooming in pulls them
 * apart and the offsets fall away as soon as the real positions have room.
 *
 * Widths come from the markers' own layout, since a name pill can be wider
 * than the avatar. Slots follow the input order, so pass the members in a
 * stable order or a face hops between slots on every refresh.
 */
export function spreadOverlapping(
  points: Positioned[],
  zoom: number,
  widths: ReadonlyMap<string, number> = new Map(),
): Map<string, [number, number]> {
  const offsets = new Map<string, [number, number]>()
  if (points.length < 2) return offsets
  const widthOf = (point: Positioned) => widths.get(point.id) ?? MARKER_WIDTH_PX

  // Union-find over the pairs whose markers would touch on screen.
  const parent = points.map((_, index) => index)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const pa = points[a]!
      const pb = points[b]!
      const clearancePoints = (widthOf(pa) + widthOf(pb)) / 2 + MARKER_GAP_PX
      const clearance = clearancePoints * metresPerPoint((pa.lat + pb.lat) / 2, zoom)
      if (haversineMeters(pa, pb) < clearance) parent[find(a)] = find(b)
    }
  }

  const groups = new Map<number, Positioned[]>()
  points.forEach((point, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), point])
  })

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const columns = group.length <= 3 ? group.length : Math.ceil(Math.sqrt(group.length))
    const rows = Math.ceil(group.length / columns)
    for (let row = 0; row < rows; row += 1) {
      // Each row is centred on its own, so a short last row does not hang
      // off the left.
      const members = group.slice(row * columns, (row + 1) * columns)
      const rowWidth =
        members.reduce((sum, member) => sum + widthOf(member), 0) +
        MARKER_GAP_PX * (members.length - 1)
      let x = -rowWidth / 2
      const y = (row - (rows - 1) / 2) * MARKER_ROW_PX
      for (const member of members) {
        offsets.set(member.id, [x + widthOf(member) / 2, y])
        x += widthOf(member) + MARKER_GAP_PX
      }
    }
  }
  return offsets
}
