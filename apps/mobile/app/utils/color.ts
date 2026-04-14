/** Anything that is not a hex string comes back unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#")) return hex
  const clean = hex.slice(1)
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean
  const value = Number.parseInt(full.slice(0, 6), 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`
}

/** Pick a readable foreground for a saturated avatar colour. */
export function onColor(hex: string): string {
  if (!hex.startsWith("#") || hex.length < 7) return "#FFFFFF"
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? "#1E1714" : "#FFFFFF"
}
