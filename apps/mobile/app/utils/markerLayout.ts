import { haversineMeters } from "@hearth/shared"

export interface Positioned {
  id: string
  lat: number
  lon: number
}

/** One marker on the map: everyone stood close enough to share it. */
export interface MarkerGroup {
  key: string
  ids: string[]
  lat: number
  lon: number
}

/** The box one face takes: the avatar plus room for its selection halo. */
export const FACE_BOX_PX = 56
/** Faces in a group sit this far apart, so each overlaps the one before it. */
export const FACE_STRIDE_PX = 34
const MARKER_GAP_PX = 6

/**
 * Web Mercator ground resolution at the equator, metres per point at zoom 0.
 * MapLibre zooms over 512 point tiles, so this is half the figure quoted for
 * 256 pixel slippy maps.
 */
const EQUATOR_METRES_PER_POINT = 78271.517

export function metresPerPoint(lat: number, zoom: number): number {
  return (EQUATOR_METRES_PER_POINT * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

export function markerWidth(faces: number): number {
  return FACE_BOX_PX + (faces - 1) * FACE_STRIDE_PX
}

export const groupKey = (ids: string[]) => ids.join("|")

/**
 * Who shares a marker at this zoom.
 *
 * A family at home is four faces on one spot, and on a city wide view a
 * whole town is. Spreading them apart made them look like four places, so
 * anyone whose marker would touch another's joins it instead: the faces
 * stack into one marker with one name pill, on the middle of where they
 * all are. Zooming in pulls them apart again as soon as there is room.
 *
 * Widths come from the markers' own layout when they have reported one,
 * since a name pill can be wider than the faces. Groups keep the input
 * order, so pass the members in a stable order or a face hops between
 * slots on every refresh.
 */
export function groupOverlapping(
  points: Positioned[],
  zoom: number,
  widths: ReadonlyMap<string, number> = new Map(),
): MarkerGroup[] {
  const index = new Map(points.map((point, position) => [point.id, position]))
  let groups = points.map((point) => ({ members: [point] }))
  const widthOf = (group: { members: Positioned[] }) =>
    widths.get(groupKey(group.members.map((member) => member.id))) ??
    markerWidth(group.members.length)
  const centre = (group: { members: Positioned[] }) => ({
    lat: group.members.reduce((sum, member) => sum + member.lat, 0) / group.members.length,
    lon: group.members.reduce((sum, member) => sum + member.lon, 0) / group.members.length,
  })

  // Merging two groups moves the centre and widens the marker, which can
  // reach a third, so go round until nothing touches.
  let merged = true
  while (merged) {
    merged = false
    outer: for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const ga = groups[a]!
        const gb = groups[b]!
        const ca = centre(ga)
        const cb = centre(gb)
        const clearancePoints = (widthOf(ga) + widthOf(gb)) / 2 + MARKER_GAP_PX
        const clearance = clearancePoints * metresPerPoint((ca.lat + cb.lat) / 2, zoom)
        if (haversineMeters(ca, cb) < clearance) {
          const members = [...ga.members, ...gb.members].sort(
            (x, y) => index.get(x.id)! - index.get(y.id)!,
          )
          groups = [
            ...groups.slice(0, a),
            { members },
            ...groups.slice(a + 1, b),
            ...groups.slice(b + 1),
          ]
          merged = true
          break outer
        }
      }
    }
  }

  return groups.map((group) => {
    const ids = group.members.map((member) => member.id)
    return { key: groupKey(ids), ids, ...centre(group) }
  })
}
