import * as Location from "expo-location"

import { load, save } from "@/utils/storage"

/**
 * "Near Queen Street" beats a pair of coordinates and beats "Unnamed spot".
 * The phone's own geocoder answers, which needs no server and no account,
 * and its answers are kept so a trip list scrolled twice asks once. A grid
 * of about a hundred metres is the resolution a street name has anyway.
 */
const CACHE_KEY = "hearth.geocode.v1"
const CACHE_CAP = 400
const GRID = 1000

let cache: Record<string, string | null> | null = null
const inFlight = new Map<string, Promise<string | null>>()

export function gridKey(lat: number, lon: number): string {
  return `${Math.round(lat * GRID)},${Math.round(lon * GRID)}`
}

function table(): Record<string, string | null> {
  cache ??= load<Record<string, string | null>>(CACHE_KEY) ?? {}
  return cache
}

function remember(key: string, value: string | null) {
  const current = table()
  current[key] = value
  const keys = Object.keys(current)
  // Oldest first, as insertion order has it.
  if (keys.length > CACHE_CAP)
    for (const stale of keys.slice(0, keys.length - CACHE_CAP)) delete current[stale]
  save(CACHE_KEY, current)
}

/** What a geocoder has to say about a spot, or null where it has nothing. */
export function labelFor(address: Location.LocationGeocodedAddress | undefined): string | null {
  if (!address) return null
  const street = address.street?.trim() || null
  // A named landmark beats its street, but a house number is not a landmark.
  const name = address.name?.trim() || null
  const landmark = name && street && !name.startsWith(street) && !/^\d/.test(name) ? name : null
  const locality =
    address.district?.trim() || address.city?.trim() || address.subregion?.trim() || null
  const head = landmark ?? street ?? locality
  if (!head) return null
  return locality && locality !== head ? `${head}, ${locality}` : head
}

export function cachedNearby(lat: number, lon: number): string | null | undefined {
  return table()[gridKey(lat, lon)]
}

/**
 * A street for a spot, from the cache or the phone's geocoder. Null means
 * the geocoder had nothing to say, and that answer is kept too so the same
 * empty field is not asked about on every render.
 */
export async function nearby(lat: number, lon: number): Promise<string | null> {
  const key = gridKey(lat, lon)
  const known = table()[key]
  if (known !== undefined) return known
  const pending = inFlight.get(key)
  if (pending) return pending
  const request = Promise.resolve()
    .then(() => Location.reverseGeocodeAsync({ latitude: lat, longitude: lon }))
    .then((addresses) => labelFor(addresses?.[0]))
    .catch(() => null)
    .then((label) => {
      remember(key, label)
      inFlight.delete(key)
      return label
    })
  inFlight.set(key, request)
  return request
}
