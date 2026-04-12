import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"

import type { TokenPair } from "@/services/api/client"

const KEY = "hearth.tokens.v1"

/**
 * Tokens live in the OS keychain, never in MMKV or any state that gets
 * serialised to disk. The in-memory mirror keeps the synchronous read on every
 * API call cheap.
 */
let cached: TokenPair | null | undefined

async function readSecure(): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return globalThis.localStorage?.getItem(KEY) ?? null
    } catch {
      return null
    }
  }
  return SecureStore.getItemAsync(KEY)
}

async function writeSecure(value: string | null): Promise<void> {
  if (Platform.OS === "web") {
    try {
      if (value === null) globalThis.localStorage?.removeItem(KEY)
      else globalThis.localStorage?.setItem(KEY, value)
    } catch {
      // Private mode or storage disabled. The session just will not persist.
    }
    return
  }
  if (value === null) await SecureStore.deleteItemAsync(KEY)
  else
    await SecureStore.setItemAsync(KEY, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    })
}

export const tokenVault = {
  /** Call once at startup, before anything auth-gated renders. */
  async hydrate(): Promise<TokenPair | null> {
    if (cached !== undefined) return cached
    try {
      const raw = await readSecure()
      cached = raw ? (JSON.parse(raw) as TokenPair) : null
    } catch {
      cached = null
    }
    return cached
  },

  peek(): TokenPair | null {
    return cached ?? null
  },

  async set(tokens: TokenPair | null): Promise<void> {
    cached = tokens
    await writeSecure(tokens ? JSON.stringify(tokens) : null)
  },
}
