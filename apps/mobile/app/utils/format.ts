import {
  formatDistance as sharedFormatDistance,
  metersPerSecondToKmh,
  metersPerSecondToMph,
} from "@hearth/shared"

export type Units = "metric" | "imperial"

export function formatSpeed(mps: number | null | undefined, units: Units): string | null {
  if (mps == null || !Number.isFinite(mps) || mps < 0.5) return null
  const value = units === "imperial" ? metersPerSecondToMph(mps) : metersPerSecondToKmh(mps)
  return `${Math.round(value)} ${units === "imperial" ? "mph" : "km/h"}`
}

export function formatDistance(meters: number, units: Units): string {
  return sharedFormatDistance(meters, units)
}

export function formatBattery(level: number | null | undefined): string | null {
  if (level == null) return null
  return `${Math.round(level * 100)}%`
}

/** Spread rather than charAt, so non-Latin scripts keep a whole grapheme. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const first = [...(words[0] ?? "")][0] ?? ""
  const second = words.length > 1 ? ([...(words[words.length - 1] ?? "")][0] ?? "") : ""
  return (first + second).toUpperCase()
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "-"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatRadius(meters: number, units: Units): string {
  if (units === "imperial") {
    const feet = meters * 3.28084
    return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(feet / 5280).toFixed(1)} mi`
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
}
