import type { MemberPresence } from "@hearth/shared"

/**
 * Whichever of two reports about one member is the later word. A fix older
 * than the one on screen lost a race, a poll that left before a socket frame
 * and came back after it, and drawing it would step the dot back. A change
 * of sharing is the later word whatever its time says, since a pause carries
 * no time at all and an approximate one is on a coarse clock.
 */
function later(current: MemberPresence | undefined, incoming: MemberPresence): MemberPresence {
  if (!current?.recordedAt || !incoming.recordedAt) return incoming
  if (current.sharingState !== incoming.sharingState) return incoming
  if (current.approximate !== incoming.approximate) return incoming
  return Date.parse(incoming.recordedAt) < Date.parse(current.recordedAt) ? current : incoming
}

/** One member's presence, from a socket frame, into the circle's list. */
export function withPresence(
  current: MemberPresence[] | undefined,
  incoming: MemberPresence,
): MemberPresence[] {
  if (!current) return [incoming]
  const index = current.findIndex((entry) => entry.userId === incoming.userId)
  if (index === -1) return [...current, incoming]
  const kept = later(current[index], incoming)
  if (kept === current[index]) return current
  const next = current.slice()
  next[index] = kept
  return next
}

/**
 * A whole list, from the poll or the socket's priming. It says who is in the
 * circle, and for each of them the later of what it says and what was there.
 */
export function mergePresence(
  current: MemberPresence[] | undefined,
  incoming: MemberPresence[],
): MemberPresence[] {
  if (!current) return incoming
  const byUser = new Map(current.map((entry) => [entry.userId, entry]))
  return incoming.map((entry) => later(byUser.get(entry.userId), entry))
}
