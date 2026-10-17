import { describe, expect, it } from "vitest"

import { createBudget, pushTestBudget } from "./budget"

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
}

const MINUTE = 60_000
const start = Date.UTC(2026, 9, 17, 9, 0)

describe("a budget of presses", () => {
  it("lets the allowance through and answers the next with how long to wait", () => {
    const take = createBudget("test", 3, 5 * MINUTE, memoryStorage())
    expect([take(start), take(start + MINUTE), take(start + 2 * MINUTE)]).toEqual([0, 0, 0])
    expect(take(start + 3 * MINUTE)).toBe(2 * MINUTE)
  })

  it("frees a press once the oldest leaves the window", () => {
    const take = createBudget("test", 1, 5 * MINUTE, memoryStorage())
    take(start)
    expect(take(start + 5 * MINUTE + 1)).toBe(0)
  })

  // Every tab of the browser, and a reload, spend the same allowance on the
  // server, so they share it here too.
  it("is shared by everything reading the same storage", () => {
    const storage = memoryStorage()
    createBudget("test", 1, 5 * MINUTE, storage)(start)
    expect(createBudget("test", 1, 5 * MINUTE, storage)(start + MINUTE)).toBeGreaterThan(0)
  })

  it("still works without storage", () => {
    const take = createBudget("test", 1, 5 * MINUTE, undefined)
    expect([take(start), take(start)]).toEqual([0, 5 * MINUTE])
  })
})

describe("the portal's test notifications", () => {
  // The server takes five in five minutes from one account, and the app on
  // the account's phone keeps three of them for itself.
  it("are two in five minutes, which leaves the phone its three", () => {
    const take = pushTestBudget(memoryStorage())
    expect([take(start), take(start + 1000), take(start + 2000)].map((wait) => wait > 0)).toEqual([
      false,
      false,
      true,
    ])
  })
})
