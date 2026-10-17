/**
 * What the join field holds, whether typed or carried in by a link. The
 * server refuses anything else with a 400, and the preview asks it on every
 * keystroke.
 */
export function cleanInviteCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16)
}
