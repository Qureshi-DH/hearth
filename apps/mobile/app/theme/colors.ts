/**
 * Hearth light palette.
 *
 * Warm, low-chroma neutrals so the map stays the star; a single ember accent
 * for anything interactive; restrained status colours. Every key here must
 * also exist in colorsDark.ts.
 */
const palette = {
  neutral100: "#FFFFFF",
  neutral200: "#FBF7F2",
  neutral300: "#F1EAE2",
  neutral400: "#DDD3C8",
  neutral500: "#A69A8E",
  neutral600: "#6E645B",
  neutral700: "#3F3733",
  neutral800: "#1E1714",
  neutral900: "#0F0C0B",

  ember100: "#FFEFE6",
  ember200: "#FFD3BE",
  ember300: "#FFAE8A",
  ember400: "#FF8A5C",
  ember500: "#F5643A",
  ember600: "#D14B27",

  rose400: "#FF6E8A",
  rose500: "#F04A6A",

  gold300: "#FFE0A8",
  gold400: "#FFC470",
  gold500: "#F0A73A",

  sage300: "#B8E8CD",
  sage400: "#6AD39C",
  sage500: "#2FAE73",

  sky400: "#5FA8FF",
  sky500: "#2F7FE8",

  angry100: "#FFE3E3",
  angry500: "#E5484D",

  overlay20: "rgba(30, 23, 20, 0.2)",
  overlay50: "rgba(30, 23, 20, 0.5)",
  overlay80: "rgba(30, 23, 20, 0.8)",
  glass: "rgba(255, 255, 255, 0.72)",
  glassBorder: "rgba(30, 23, 20, 0.08)",
} as const

export const colors = {
  palette,
  transparent: "rgba(0, 0, 0, 0)",
  /** Default body text. */
  text: palette.neutral800,
  /** Secondary, de-emphasised text. */
  textDim: palette.neutral600,
  /** Placeholder and disabled text. */
  textFaint: palette.neutral500,
  /** Text drawn on top of `tint`. */
  onTint: palette.neutral100,
  /** Screen background. */
  background: palette.neutral200,
  /** Cards and sheets. */
  surface: palette.neutral100,
  /** A surface stacked on another surface. */
  surfaceElevated: palette.neutral300,
  /** Frosted panels floating over the map. */
  glass: palette.glass,
  glassBorder: palette.glassBorder,
  border: palette.neutral400,
  /** Primary interactive colour. */
  tint: palette.ember500,
  tintSoft: palette.ember100,
  tintStrong: palette.ember600,
  tintInactive: palette.neutral400,
  /** Gradient stops for hero surfaces and the SOS control. */
  gradientStart: palette.ember400,
  gradientEnd: palette.rose500,
  separator: palette.neutral300,
  success: palette.sage500,
  successSoft: palette.sage300,
  warning: palette.gold500,
  warningSoft: palette.gold300,
  info: palette.sky500,
  error: palette.angry500,
  errorBackground: palette.angry100,
  /** Modal scrim. */
  overlay: palette.overlay50,
  /** Colour used for the viewer's own marker. */
  self: palette.sky500,
  /** Geofence fill / stroke. */
  placeFill: "rgba(245, 100, 58, 0.12)",
  placeStroke: "rgba(245, 100, 58, 0.55)",
  /** Breadcrumb path. */
  path: palette.sky500,
} as const
