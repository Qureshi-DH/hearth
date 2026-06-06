import { MMKV } from "react-native-mmkv"

export const storage = new MMKV()

export function loadString(key: string): string | null {
  try {
    return storage.getString(key) ?? null
  } catch {
    return null
  }
}

export function saveString(key: string, value: string): boolean {
  try {
    storage.set(key, value)
    return true
  } catch {
    return false
  }
}

export function load<T>(key: string): T | null {
  let almostThere: string | null = null
  try {
    almostThere = loadString(key)
    return JSON.parse(almostThere ?? "") as T
  } catch {
    return (almostThere as T) ?? null
  }
}

export function save(key: string, value: unknown): boolean {
  try {
    saveString(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function remove(key: string): void {
  try {
    storage.delete(key)
  } catch {
    // Storage can be unavailable in a share extension or a locked device.
    // Losing a cached value is not worth crashing over.
  }
}

export function clear(): void {
  try {
    storage.clearAll()
  } catch {
    // Same as remove: best effort.
  }
}
