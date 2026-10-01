import { API_PREFIX, type CurrentUser, type PortalSession } from "@hearth/shared"

/** What the server said went wrong, in its own words. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** Said wherever a call failed before any answer came back. */
export const UNREACHABLE =
  "The server could not be reached. Check that it is running and try again."

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The part of navigator.locks the client needs. */
export interface LockRunner {
  request<T>(name: string, run: () => Promise<T>): Promise<T>
}

/**
 * "expired" when the session ended on its own, "signed-out" when somebody
 * pressed the button. Only the first is worth a notice on the sign-in screen.
 */
export type SignOutReason = "expired" | "signed-out"

export interface ClientOptions {
  fetch?: typeof globalThis.fetch
  /** Where the browser's device id is kept. It names the browser, and is not a secret. */
  storage?: KeyValueStore
  /**
   * Defaults to navigator.locks, or to a lease in `storage` where the page is
   * not a secure context and has no navigator.locks. Null renews without one.
   */
  locks?: LockRunner | null
  onSignedOut?: (reason: SignOutReason) => void
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
}

const DEVICE_KEY = "hearth.portal.device"

/**
 * Every tab shares the one cookie and the one device id, and the server
 * rotates the cookie on each renewal. Two tabs renewing at once would spend
 * the same cookie twice, which the server reads as a stolen token.
 */
const RENEW_LOCK = "hearth-portal-renew"

/**
 * How long before the access token runs out it is renewed. Sent after that it
 * would be refused with a 401, and a firewall in front of the server can read
 * a 401 as an attack and lock out everybody behind the same address.
 */
const RENEW_AHEAD_MS = 60_000

/**
 * The access token lives here, in memory, and nowhere else. The refresh token
 * is a cookie the page cannot read, which the server sets and rotates, so a
 * reload renews the session from the cookie and a closed browser ends it.
 * Renewing never stretches the session past the limit the server set at
 * sign-in, so a long day at the portal ends in a sign-in screen.
 */
export function createClient(options: ClientOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const locks = options.locks === undefined ? browserLocks(options.storage) : options.locks
  const deviceId = browserDeviceId(options.storage)
  let accessToken: string | null = null
  let renewing: Promise<CurrentUser | null> | null = null
  /** When to renew, counted on this browser's clock from when the token came. */
  let renewAt = Infinity
  /**
   * The server refused the token and no renewal has had an answer since.
   * Sent again it would only be refused again, another 4xx for the firewall.
   */
  let refused = false

  async function call<T>(path: string, init: RequestOptions, token: string | null): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    if (init.body !== undefined) headers["content-type"] = "application/json"
    const response = await fetchImpl(`${API_PREFIX}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    })
    const payload = parse(await response.text())
    if (payload === UNREADABLE) {
      throw new ApiError(
        response.status,
        "unreadable",
        response.ok
          ? "The server's answer could not be read."
          : `The server answered ${response.status}.`,
      )
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
      throw new ApiError(
        response.status,
        error?.code ?? "request_error",
        error?.message ?? `The server answered ${response.status}.`,
      )
    }
    return payload as T
  }

  function adopt(session: PortalSession): CurrentUser {
    accessToken = session.accessToken
    renewAt = Date.now() + session.expiresIn * 1000 - RENEW_AHEAD_MS
    refused = false
    return session.user
  }

  /**
   * Null only when the server says the session is over. A failure to reach
   * it, or a broken answer, is thrown, so a flaky network does not look like
   * being signed out.
   */
  async function refresh(): Promise<CurrentUser | null> {
    try {
      return adopt(
        await call<PortalSession>(
          "/auth/portal/refresh",
          { method: "POST", body: { deviceId } },
          null,
        ),
      )
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        accessToken = null
        return null
      }
      throw error
    }
  }

  function withLock<T>(run: () => Promise<T>): Promise<T> {
    return locks ? locks.request(RENEW_LOCK, run) : run()
  }

  /** One renewal at a time, shared by every call in this tab that found the token expired. */
  function renew(): Promise<CurrentUser | null> {
    renewing ??= withLock(refresh).finally(() => {
      renewing = null
    })
    return renewing
  }

  return {
    async signIn(email: string, password: string): Promise<CurrentUser> {
      return adopt(
        await call<PortalSession>(
          "/auth/portal/login",
          { method: "POST", body: { email, password, deviceId } },
          null,
        ),
      )
    },

    /** Picks up the session the cookie holds, if there is one. */
    resume(): Promise<CurrentUser | null> {
      return renew()
    },

    /** Throws, and stays signed in, when the server never heard it. */
    async signOut(): Promise<void> {
      // A renewal that lands after the logout would set a fresh cookie, and
      // the next reload would sign straight back in. So this waits for one
      // under way here, and takes the lock against one in another tab.
      if (renewing) await renewing.catch(() => null)
      await withLock(() => call("/auth/portal/logout", { method: "POST" }, null))
      accessToken = null
      options.onSignedOut?.("signed-out")
    },

    async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
      if (accessToken && (refused || Date.now() >= renewAt)) {
        try {
          if (!(await renew())) {
            options.onSignedOut?.("expired")
            throw new ApiError(401, "unauthorized", "Sign in again.")
          }
        } catch (error) {
          // A token due for renewal still has a minute if nobody refused it,
          // so an unanswered renewal holds back only one that was refused.
          if (refused || !accessToken) throw error
        }
      }
      const token = accessToken
      try {
        return await call<T>(path, init, token)
      } catch (error) {
        // A wrong password is a 401 too, and renewing would not make it right.
        if (!(error instanceof ApiError && error.status === 401 && error.code === "unauthorized")) {
          throw error
        }
        // Another call may already have renewed it while this one waited.
        if (accessToken && accessToken !== token) return call<T>(path, init, accessToken)
        refused = true
        if (await renew()) return call<T>(path, init, accessToken)
        options.onSignedOut?.("expired")
        throw error
      }
    },
  }
}

const UNREADABLE = Symbol("unreadable")

/** A proxy's error page or a cut-off body is HTML or nothing, not JSON. */
function parse(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return UNREADABLE
  }
}

function browserLocks(storage: KeyValueStore | undefined): LockRunner | null {
  const native = globalThis.navigator?.locks as LockRunner | undefined
  if (native) return native
  return storage ? storageLock(storage) : null
}

const LEASE_MS = 5_000

interface Lease {
  owner: string
  expiresAt: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stands in for navigator.locks, which a browser only offers in a secure
 * context, for a portal reached over plain http on a home network. A tab
 * claims a lease in localStorage, waits a moment for any other tab's claim to
 * land, and goes ahead only if the claim is still its own. The lease runs out
 * on its own, so a tab closed while holding one blocks the others briefly.
 */
export function storageLock(storage: KeyValueStore): LockRunner {
  return {
    async request<T>(name: string, run: () => Promise<T>): Promise<T> {
      const key = `hearth.lock.${name}`
      const owner = randomId()
      const read = (): Lease | null => {
        try {
          const lease = JSON.parse(storage.getItem(key) ?? "null") as Lease | null
          return typeof lease?.owner === "string" && typeof lease.expiresAt === "number"
            ? lease
            : null
        } catch {
          return null
        }
      }
      const claim = () =>
        storage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS }))

      try {
        let backoff = 25
        for (;;) {
          const lease = read()
          if (!lease || lease.expiresAt <= Date.now()) {
            claim()
            await sleep(10 + Math.random() * 30)
            if (read()?.owner === owner) break
          }
          await sleep(backoff + Math.random() * backoff)
          backoff = Math.min(backoff * 2, 500)
        }
      } catch {
        // Storage that throws cannot hold a lease. Renewing without one is
        // what happened before there was a lock at all.
        return run()
      }

      // A renewal slower than the lease must not let a second tab in mid-way.
      const keepAlive = setInterval(() => {
        if (read()?.owner === owner) claim()
      }, LEASE_MS / 2)
      try {
        return await run()
      } finally {
        clearInterval(keepAlive)
        try {
          if (read()?.owner === owner) storage.removeItem(key)
        } catch {
          // Left to run out on its own.
        }
      }
    },
  }
}

function browserDeviceId(storage: KeyValueStore | undefined): string {
  const fresh = `portal-${randomId()}`
  if (!storage) return fresh
  try {
    const kept = storage.getItem(DEVICE_KEY)
    if (kept) return kept
    storage.setItem(DEVICE_KEY, fresh)
  } catch {
    // Private windows and blocked storage: a new id per visit is fine.
  }
  return fresh
}

function randomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
