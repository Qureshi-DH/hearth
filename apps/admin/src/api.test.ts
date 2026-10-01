import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError, createClient, storageLock, type ClientOptions, type LockRunner } from "./api"

const USER = { id: "u1", displayName: "Daniyal", email: "d@example.com", isAdmin: true }

interface Call {
  url: string
  method: string
  authorization: string | null
  body: unknown
}

type Failure = "network" | "html" | 403 | 429 | 502 | null

/** A server that answers the portal's routes, with switches for what can go wrong. */
function fakeServer() {
  const calls: Call[] = []
  const state = {
    token: 0,
    refreshWorks: true,
    refreshFails: null as Failure,
    logoutFails: false,
    statsRejects: 0,
    inLock: false,
    refreshedInLock: [] as boolean[],
    loggedOutInLock: [] as boolean[],
    /** While set, a refresh waits for it before answering. */
    refreshGate: null as Promise<void> | null,
    refreshMs: 0,
    refreshing: 0,
    mostAtOnce: 0,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const html = (status: number) =>
    new Response("<html><body>Bad Gateway</body></html>", {
      status,
      headers: { "content-type": "text/html" },
    })

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    if (url.endsWith("/auth/portal/login")) {
      state.token += 1
      return json(200, { accessToken: `token-${state.token}`, expiresIn: 900, user: USER })
    }
    if (url.endsWith("/auth/portal/refresh")) {
      state.refreshedInLock.push(state.inLock)
      state.refreshing += 1
      state.mostAtOnce = Math.max(state.mostAtOnce, state.refreshing)
      try {
        if (state.refreshGate) await state.refreshGate
        if (state.refreshMs) await new Promise((resolve) => setTimeout(resolve, state.refreshMs))
      } finally {
        state.refreshing -= 1
      }
      if (state.refreshFails === "network") throw new TypeError("Failed to fetch")
      if (state.refreshFails === "html") return html(200)
      if (state.refreshFails === 403) {
        return json(403, { error: { code: "forbidden", message: "Not an administrator." } })
      }
      if (state.refreshFails === 502) return json(502, { error: { code: "bad_gateway" } })
      if (state.refreshFails === 429)
        return json(429, { error: { code: "blocked", message: "Blocked." } })
      if (!state.refreshWorks)
        return json(401, { error: { code: "unauthorized", message: "Sign in." } })
      state.token += 1
      return json(200, { accessToken: `token-${state.token}`, expiresIn: 900, user: USER })
    }
    if (url.endsWith("/auth/portal/logout")) {
      state.loggedOutInLock.push(state.inLock)
      if (state.logoutFails) throw new TypeError("Failed to fetch")
      return json(200, { ok: true })
    }
    if (url.endsWith("/admin/stats")) {
      if (!call.authorization) {
        return json(401, { error: { code: "unauthorized", message: "Sign in." } })
      }
      if (state.statsRejects > 0) {
        state.statsRejects -= 1
        return json(401, { error: { code: "unauthorized", message: "Token expired." } })
      }
      return json(200, { users: 3, seenWith: call.authorization })
    }
    if (url.endsWith("/admin/users/u2/password")) {
      return json(401, {
        error: { code: "wrong_password", message: "That password is not right." },
      })
    }
    if (url.endsWith("/admin/users/u9")) {
      return json(400, {
        error: { code: "bad_request", message: "The server must keep at least one administrator." },
      })
    }
    if (url.endsWith("/admin/broken")) return html(502)
    return json(404, { error: { code: "not_found", message: "No route." } })
  })

  return { fetch, calls, state }
}

/** What localStorage would be, shared by every tab of the browser. */
function memoryStorage() {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
}

function client(
  server: ReturnType<typeof fakeServer>,
  onSignedOut = vi.fn(),
  extra: Partial<ClientOptions> = {},
) {
  return {
    onSignedOut,
    api: createClient({
      fetch: server.fetch as unknown as typeof globalThis.fetch,
      storage: memoryStorage(),
      onSignedOut,
      ...extra,
    }),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Stands in for navigator.locks, holding one renewal at a time as the browser would. */
function fakeLocks(server: ReturnType<typeof fakeServer>) {
  const names: string[] = []
  let queue = Promise.resolve()
  const locks: LockRunner = {
    request<T>(name: string, run: () => Promise<T>): Promise<T> {
      names.push(name)
      const turn = queue.then(async () => {
        server.state.inLock = true
        try {
          return await run()
        } finally {
          server.state.inLock = false
        }
      })
      queue = turn.then(
        () => undefined,
        () => undefined,
      )
      return turn
    },
  }
  return { locks, names }
}

const refreshes = (server: ReturnType<typeof fakeServer>) =>
  server.calls.filter((call) => call.url.endsWith("/refresh"))

describe("the portal's API client", () => {
  it("signs in and sends the token with every call after", async () => {
    const server = fakeServer()
    const { api } = client(server)
    const user = await api.signIn("d@example.com", "correct-horse-battery")
    expect(user.displayName).toBe("Daniyal")

    const stats = await api.request<{ seenWith: string }>("/admin/stats")
    expect(stats.seenWith).toBe("Bearer token-1")
    const login = server.calls[0]!
    expect(login.body).toMatchObject({ email: "d@example.com", deviceId: expect.any(String) })
  })

  it("keeps one device id for the browser", async () => {
    const server = fakeServer()
    const { api } = client(server)
    await api.signIn("d@example.com", "pw")
    await api.resume()
    const [login, refresh] = server.calls
    expect((refresh!.body as { deviceId: string }).deviceId).toBe(
      (login!.body as { deviceId: string }).deviceId,
    )
  })

  it("renews an expired token from the cookie and tries the call again", async () => {
    const server = fakeServer()
    const { api } = client(server)
    await api.signIn("d@example.com", "pw")
    server.state.statsRejects = 1
    const stats = await api.request<{ seenWith: string }>("/admin/stats")
    expect(stats.seenWith).toBe("Bearer token-2")
  })

  it("renews once for calls that all find the token expired together", async () => {
    const server = fakeServer()
    const { api } = client(server)
    await api.signIn("d@example.com", "pw")
    server.state.statsRejects = 3
    await Promise.all([
      api.request("/admin/stats"),
      api.request("/admin/stats"),
      api.request("/admin/stats"),
    ])
    expect(refreshes(server)).toHaveLength(1)
  })

  it("says the session ended on its own when it is gone for good", async () => {
    const server = fakeServer()
    const { api, onSignedOut } = client(server)
    await api.signIn("d@example.com", "pw")
    server.state.statsRejects = 1
    server.state.refreshWorks = false
    await expect(api.request("/admin/stats")).rejects.toMatchObject({ status: 401 })
    expect(onSignedOut).toHaveBeenCalledTimes(1)
    expect(onSignedOut).toHaveBeenCalledWith("expired")
  })

  it("resumes a session the cookie still holds, and finds none when it does not", async () => {
    const server = fakeServer()
    const { api } = client(server)
    expect((await api.resume())?.displayName).toBe("Daniyal")
    server.state.refreshWorks = false
    expect(await client(server).api.resume()).toBeNull()
  })

  it("passes the server's own words on", async () => {
    const server = fakeServer()
    const { api } = client(server)
    await api.signIn("d@example.com", "pw")
    const failure = await api
      .request("/admin/users/u9", { method: "PATCH", body: { isAdmin: false } })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).message).toBe("The server must keep at least one administrator.")
  })

  it("signs out on the server and forgets the token", async () => {
    const server = fakeServer()
    const { api, onSignedOut } = client(server)
    await api.signIn("d@example.com", "pw")
    await api.signOut()
    expect(server.calls.at(-1)!.url).toMatch(/\/auth\/portal\/logout$/)
    expect(onSignedOut).toHaveBeenCalledWith("signed-out")
    server.state.statsRejects = 0
    server.state.refreshWorks = false
    await expect(api.request("/admin/stats")).rejects.toBeInstanceOf(ApiError)
    expect(server.calls.at(-2)!.authorization).toBeNull()
  })

  describe("a 401 that is not about the session", () => {
    it("comes straight back, without renewing or trying again", async () => {
      const server = fakeServer()
      const { api, onSignedOut } = client(server)
      await api.signIn("d@example.com", "pw")
      const failure = await api
        .request("/admin/users/u2/password", {
          method: "POST",
          body: { password: "a-new-one-here", currentPassword: "wrong" },
        })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ApiError)
      expect(failure).toMatchObject({ status: 401, code: "wrong_password" })
      expect(refreshes(server)).toHaveLength(0)
      expect(server.calls.filter((call) => call.url.endsWith("/password"))).toHaveLength(1)
      expect(onSignedOut).not.toHaveBeenCalled()
    })
  })

  describe("renewing alongside other tabs", () => {
    it("renews inside the browser's lock, so two tabs never spend one cookie at once", async () => {
      const server = fakeServer()
      const { locks, names } = fakeLocks(server)
      const { api } = client(server, vi.fn(), { locks })
      await api.signIn("d@example.com", "pw")
      server.state.statsRejects = 1
      await api.request("/admin/stats")
      expect(names).toEqual(["hearth-portal-renew"])
      expect(server.state.refreshedInLock).toEqual([true])
    })

    it("still renews once per tab with the lock in place", async () => {
      const server = fakeServer()
      const { locks, names } = fakeLocks(server)
      const { api } = client(server, vi.fn(), { locks })
      await api.signIn("d@example.com", "pw")
      server.state.statsRejects = 3
      await Promise.all([
        api.request("/admin/stats"),
        api.request("/admin/stats"),
        api.request("/admin/stats"),
      ])
      expect(names).toHaveLength(1)
      expect(refreshes(server)).toHaveLength(1)
    })

    it("lets two tabs renew one after the other", async () => {
      const server = fakeServer()
      const { locks } = fakeLocks(server)
      const one = client(server, vi.fn(), { locks }).api
      const two = client(server, vi.fn(), { locks }).api
      const [first, second] = await Promise.all([one.resume(), two.resume()])
      expect(first?.displayName).toBe("Daniyal")
      expect(second?.displayName).toBe("Daniyal")
      expect(server.state.refreshedInLock).toEqual([true, true])
    })

    it("renews without a lock in a browser that has none", async () => {
      const server = fakeServer()
      const { api } = client(server, vi.fn(), { locks: null })
      expect((await api.resume())?.displayName).toBe("Daniyal")
    })
  })

  describe("a renewal that fails for some other reason", () => {
    it("is an error, not a sign-out, when the server cannot be reached", async () => {
      const server = fakeServer()
      const { api, onSignedOut } = client(server)
      await api.signIn("d@example.com", "pw")
      server.state.statsRejects = 1
      server.state.refreshFails = "network"
      await expect(api.request("/admin/stats")).rejects.toBeInstanceOf(TypeError)
      expect(onSignedOut).not.toHaveBeenCalled()
    })

    it("is an error, not a sign-out, when the server answers 5xx", async () => {
      const server = fakeServer()
      server.state.refreshFails = 502
      const { api, onSignedOut } = client(server)
      await expect(api.resume()).rejects.toMatchObject({ status: 502 })
      expect(onSignedOut).not.toHaveBeenCalled()
    })

    it("is an error, not a sign-out, when the answer is not JSON", async () => {
      const server = fakeServer()
      server.state.refreshFails = "html"
      const { api } = client(server)
      const failure = await api.resume().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ApiError)
    })

    it("still means signed out when the server refuses with a 403", async () => {
      const server = fakeServer()
      server.state.refreshFails = 403
      const { api } = client(server)
      expect(await api.resume()).toBeNull()
    })

    // Behind a firewall that locks an address out for every 4xx, sending a
    // refused token again is another lockout, and it never ends.
    it("renews before the next call rather than sending the refused token again", async () => {
      const server = fakeServer()
      const { api } = client(server)
      await api.signIn("d@example.com", "pw")
      server.state.statsRejects = 1
      server.state.refreshFails = 429
      await expect(api.request("/admin/stats")).rejects.toMatchObject({ status: 429 })

      await expect(api.request("/admin/stats")).rejects.toMatchObject({ status: 429 })
      const after = server.calls.slice(-1)
      expect(after.map((call) => call.url.replace(/.*\/api\/v1/, ""))).toEqual([
        "/auth/portal/refresh",
      ])

      server.state.refreshFails = null
      const stats = await api.request<{ seenWith: string }>("/admin/stats")
      expect(stats.seenWith).toBe("Bearer token-2")
    })
  })

  describe("a token about to run out", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("is renewed before it is sent, so the server never has to refuse it", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
      const server = fakeServer()
      const { api } = client(server)
      await api.signIn("d@example.com", "pw")

      now.mockReturnValue(1_000_000 + 850_000)
      const stats = await api.request<{ seenWith: string }>("/admin/stats")
      expect(stats.seenWith).toBe("Bearer token-2")
      expect(server.calls.filter((call) => call.url.endsWith("/admin/stats"))).toHaveLength(1)
    })

    it("is still used when the early renewal gets no answer, since it has a minute left", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
      const server = fakeServer()
      const { api } = client(server)
      await api.signIn("d@example.com", "pw")

      now.mockReturnValue(1_000_000 + 850_000)
      server.state.refreshFails = "network"
      const stats = await api.request<{ seenWith: string }>("/admin/stats")
      expect(stats.seenWith).toBe("Bearer token-1")
    })
  })

  describe("signing out when the server cannot be reached", () => {
    it("stays signed in and says so", async () => {
      const server = fakeServer()
      const { api, onSignedOut } = client(server)
      await api.signIn("d@example.com", "pw")
      server.state.logoutFails = true
      await expect(api.signOut()).rejects.toBeInstanceOf(Error)
      expect(onSignedOut).not.toHaveBeenCalled()
      const stats = await api.request<{ seenWith: string }>("/admin/stats")
      expect(stats.seenWith).toBe("Bearer token-1")
    })
  })

  it("turns an error page that is not JSON into an ApiError with its status", async () => {
    const server = fakeServer()
    const { api } = client(server)
    await api.signIn("d@example.com", "pw")
    const failure = await api.request("/admin/broken").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 502 })
  })

  describe("signing out while a renewal is under way", () => {
    it("waits for it, so the logout revokes the cookie the renewal just set", async () => {
      const server = fakeServer()
      const { api, onSignedOut } = client(server, vi.fn(), { locks: null })
      await api.signIn("d@example.com", "pw")
      let open!: () => void
      server.state.refreshGate = new Promise<void>((resolve) => (open = resolve))
      server.state.statsRejects = 1
      const stats = api.request("/admin/stats")
      await settle()
      const out = api.signOut()
      await settle()
      expect(server.calls.some((call) => call.url.endsWith("/logout"))).toBe(false)
      open()
      await Promise.all([stats, out])
      const order = server.calls.map((call) => call.url.split("/").pop())
      expect(order.lastIndexOf("logout")).toBeGreaterThan(order.lastIndexOf("refresh"))
      expect(onSignedOut).toHaveBeenCalledWith("signed-out")
    })

    it("signs out inside the renewal lock, so another tab cannot rotate the cookie mid-way", async () => {
      const server = fakeServer()
      const { locks, names } = fakeLocks(server)
      const { api } = client(server, vi.fn(), { locks })
      await api.signIn("d@example.com", "pw")
      await api.signOut()
      expect(names).toEqual(["hearth-portal-renew"])
      expect(server.state.loggedOutInLock).toEqual([true])
    })
  })

  describe("renewing over plain http, where the browser has no navigator.locks", () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("takes turns through a lease in localStorage, one tab at a time", async () => {
      vi.stubGlobal("navigator", {})
      const server = fakeServer()
      server.state.refreshMs = 30
      const shared = memoryStorage()
      const tabs = [1, 2, 3].map(() => client(server, vi.fn(), { storage: shared }).api)
      const users = await Promise.all(tabs.map((tab) => tab.resume()))
      expect(users.map((user) => user?.displayName)).toEqual(["Daniyal", "Daniyal", "Daniyal"])
      expect(server.state.mostAtOnce).toBe(1)
      expect([...shared.store.keys()].some((key) => key.includes("lock"))).toBe(false)
    })

    it("does not wait forever on a lease a closed tab left behind", async () => {
      const shared = memoryStorage()
      shared.setItem(
        "hearth.lock.hearth-portal-renew",
        JSON.stringify({ owner: "a closed tab", expiresAt: Date.now() + 150 }),
      )
      const started = Date.now()
      const result = await storageLock(shared).request("hearth-portal-renew", async () => "ran")
      expect(result).toBe("ran")
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    })

    it("lets go of the lease when the work throws", async () => {
      const shared = memoryStorage()
      const lock = storageLock(shared)
      await expect(
        lock.request("hearth-portal-renew", async () => {
          throw new Error("refresh failed")
        }),
      ).rejects.toThrow("refresh failed")
      expect(shared.getItem("hearth.lock.hearth-portal-renew")).toBeNull()
    })
  })
})
