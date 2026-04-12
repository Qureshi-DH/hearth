import type { StateStorage } from "zustand/middleware"

import { storage } from "@/utils/storage"

/**
 * Synchronous, so persisted stores hydrate before the first render and screens
 * never flash an empty state. Secrets do not go through here. Use tokenVault.
 */
export const mmkvStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => storage.set(name, value),
  removeItem: (name) => storage.delete(name),
}
