interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Presses of a button the server rate limits, counted here so the page says
 * "wait" before the server would answer 429. A firewall in front of a home
 * server can read a 429 as an attack and lock every device behind the
 * address out. Kept in storage so every tab and a reload share one count.
 *
 * The returned function takes a press and answers 0, or answers how long
 * until one frees up and takes nothing.
 */
export function createBudget(
  name: string,
  allowed: number,
  windowMs: number,
  storage: KeyValueStore | undefined,
): (now?: number) => number {
  const key = `hearth.portal.budget.${name}`
  let memory: number[] = []

  const read = (): number[] => {
    try {
      const parsed = JSON.parse(storage?.getItem(key) ?? "null") as unknown
      return Array.isArray(parsed) ? parsed.filter((at) => typeof at === "number") : memory
    } catch {
      return memory
    }
  }
  const write = (presses: number[]) => {
    memory = presses
    try {
      storage?.setItem(key, JSON.stringify(presses))
    } catch {
      // Private browsing can refuse storage. The count in memory still holds.
    }
  }

  return (now = Date.now()) => {
    const recent = read().filter((at) => at > now - windowMs && at <= now)
    if (recent.length >= allowed) return Math.min(...recent) + windowMs - now
    write([...recent, now])
    return 0
  }
}

/**
 * "Send me a test". The server takes five in five minutes from one account,
 * and the app on the account's phone keeps three of them for itself.
 */
export const pushTestBudget = (storage: KeyValueStore | undefined) =>
  createBudget("push-test", 2, 5 * 60_000, storage)
