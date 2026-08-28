import * as Location from "expo-location"

import { load, save } from "@/utils/storage"

/**
 * "Near Queen Street" beats a pair of coordinates and beats "Unnamed spot".
 * The phone's own geocoder answers, which needs no server and no account,
 * and its answers are kept so a trip list scrolled twice asks once. A grid
 * of about a hundred metres is the resolution a street name has anyway.
 */
// v2 drops the plus codes v1 kept: a phone that cached "8H+2W" for its own
// street would go on reading it back for as long as the entry survived.
const CACHE_KEY = "hearth.geocode.v2"
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

/**
 * An Open Location Code, which Android's geocoder hands back wherever it
 * has no street: "8H+2W", "7JVW4XPP+2H", sometimes with the town appended.
 * The alphabet is fixed and excludes vowels. They are coordinates spelled
 * differently, and "near 8H+2W" tells a family nothing, so they are read
 * as no answer at all.
 */
const PLUS_CODE = /(^|\s)[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i

/** A house number, a postcode, or anything else with no word in it. */
const NO_WORDS = /^[^\p{L}]*$/u
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i

function meaningful(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  if (PLUS_CODE.test(text) || NO_WORDS.test(text) || POSTCODE.test(text)) return null
  return text
}

/** What a geocoder has to say about a spot, or null where it has nothing. */
export function labelFor(address: Location.LocationGeocodedAddress | undefined): string | null {
  if (!address) return null
  const street = meaningful(address.street)
  // A named landmark beats its street, but a house number is not a landmark.
  const name = meaningful(address.name)
  const landmark = name && street && !name.startsWith(street) && !/^\d/.test(name) ? name : null
  const locality =
    meaningful(address.district) ?? meaningful(address.city) ?? meaningful(address.subregion)
  // A region is a poor answer and a better one than a plus code.
  const head = landmark ?? street ?? locality ?? meaningful(address.region)
  if (!head) return null
  return locality && locality !== head ? `${head}, ${locality}` : head
}

/**
 * The first of a geocoder's answers that says something. Android returns
 * several for one spot, and the plus code is often the first of them while
 * the street is the second.
 */
export function bestLabel(
  addresses: Location.LocationGeocodedAddress[] | undefined,
): string | null {
  for (const address of addresses ?? []) {
    const label = labelFor(address)
    if (label) return label
  }
  return null
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
    .then((addresses) => bestLabel(addresses))
    .catch(() => null)
    .then((label) => {
      remember(key, label)
      inFlight.delete(key)
      return label
    })
  inFlight.set(key, request)
  return request
}
