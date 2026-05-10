/**
 * Hearth dark palette, the default for a map-first app.
 *
 * Near-neutral charcoal rather than brown. The accent is a warm ember, and a
 * warm-brown surface underneath muddies both. Greys let the ember, the
 * avatars and the map carry all the colour. A trace
 * of warmth remains in the mid tones so it does not read as clinical blue.
 * Keys mirror colors.ts exactly.
 */
const palette = {
  neutral900: "#FFFFFF",
  neutral800: "#ECECEE",
  neutral700: "#C6C6CB",
  neutral600: "#95959D",
  neutral500: "#68686F",
  neutral400: "#2A2A2E",
  neutral300: "#1B1B1E",
  neutral200: "#121214",
  neutral100: "#0A0A0B",

  ember100: "#2F2521",
  ember200: "#6B3524",
  ember300: "#B05433",
  ember400: "#F0673B",
  ember500: "#FF7A45",
  ember600: "#FF9B70",

  rose400: "#FF7A93",
  rose500: "#FF5C7A",

  gold300: "#4A3A1C",
  gold400: "#FFC470",
  gold500: "#FFD08A",

  sage300: "#1B3F2E",
  sage400: "#4CC38A",
  sage500: "#6FE0A8",

  sky400: "#5FA8FF",
  sky500: "#7DB8FF",

  angry100: "#43191D",
  angry500: "#FF6B6B",

  overlay20: "rgba(0, 0, 0, 0.2)",
  overlay50: "rgba(0, 0, 0, 0.5)",
  overlay80: "rgba(0, 0, 0, 0.8)",
  glass: "rgba(20, 20, 23, 0.78)",
  glassBorder: "rgba(255, 255, 255, 0.09)",
} as const

export const colors = {
  palette,
  transparent: "rgba(0, 0, 0, 0)",
  text: palette.neutral800,
  textDim: palette.neutral600,
  textFaint: palette.neutral500,
  onTint: "#1A0D07",
  background: palette.neutral200,
  surface: palette.neutral300,
  surfaceElevated: palette.neutral400,
  glass: palette.glass,
  glassBorder: palette.glassBorder,
  border: palette.neutral400,
  tint: palette.ember500,
  tintSoft: palette.ember100,
  tintStrong: palette.ember600,
  tintInactive: palette.neutral400,
  gradientStart: palette.ember400,
  gradientEnd: palette.rose500,
  separator: palette.neutral400,
  success: palette.sage400,
  successSoft: palette.sage300,
  warning: palette.gold400,
  warningSoft: palette.gold300,
  info: palette.sky400,
  error: palette.angry500,
  errorBackground: palette.angry100,
  overlay: palette.overlay50,
  self: palette.sky400,
  placeFill: "rgba(255, 122, 69, 0.14)",
  placeStroke: "rgba(255, 122, 69, 0.6)",
  path: palette.sky400,
} as const
