import { API_PREFIX, type ApiErrorBody, type AuthTokens } from "@hearth/shared"

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }

  get isNetwork() {
    return this.status === 0
  }
  get isUnauthorized() {
    return this.status === 401
  }
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface ApiClientHooks {
  getBaseUrl(): string | null
  getTokens(): TokenPair | null
  setTokens(tokens: TokenPair | null): Promise<void> | void
  /** Called when a refresh fails for good. The app should sign the user out. */
  onSessionExpired(): void
  /**
   * Sent with every refresh, so the server can tell this phone's two runtimes
   * racing over one token from a stolen token being replayed.
   */
  getDeviceId?(): string | null
}

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  /** Set false for public endpoints so a missing token is not an error. */
  auth?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Every authenticated request that comes back 401 waits on one shared refresh
 * promise and is retried once. A burst of queries on app resume therefore costs
 * one refresh call, not one per query.
 */
export class ApiClient {
  private refreshing: Promise<TokenPair | null> | null = null

  constructor(private readonly hooks: ApiClientHooks) {}

  get<T>(path: string, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("GET", path, options)
  }
  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("POST", path, { ...options, body })
  }
  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PATCH", path, { ...options, body })
  }
  delete<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("DELETE", path, { ...options, body })
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const first = await this.send<T>(method, path, options)
    if (first.kind === "ok") return first.data

    if (first.error.status === 401 && options.auth !== false && this.hooks.getTokens()) {
      const refreshed = await this.refreshTokens()
      if (refreshed) {
        const second = await this.send<T>(method, path, options)
        if (second.kind === "ok") return second.data
        throw second.error
      }
    }
    throw first.error
  }

  url(path: string): string {
    const base = this.hooks.getBaseUrl()
    if (!base) throw new ApiError(0, "no_server", "No server configured.")
    return `${base.replace(/\/+$/, "")}${API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`
  }

  websocketUrl(): string | null {
    const base = this.hooks.getBaseUrl()
    const tokens = this.hooks.getTokens()
    if (!base || !tokens) return null
    const wsBase = base.replace(/^http/, "ws").replace(/\/+$/, "")
    return `${wsBase}${API_PREFIX}/ws?access_token=${encodeURIComponent(tokens.accessToken)}`
  }

  private async send<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<{ kind: "ok"; data: T } | { kind: "error"; error: ApiError }> {
    let url: string
    try {
      url = this.url(path)
    } catch (error) {
      return { kind: "error", error: error as ApiError }
    }

    if (options.query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) continue
        params.set(key, String(value))
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    // FormData has to set its own content-type so the multipart boundary
    // survives. Naming it here produces a body the server cannot parse.
    const isFormData = options.body instanceof FormData
    const headers: Record<string, string> = { accept: "application/json" }
    if (options.body !== undefined && !isFormData) headers["content-type"] = "application/json"
    if (options.auth !== false) {
      const tokens = this.hooks.getTokens()
      if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true })

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body:
          options.body === undefined
            ? undefined
            : isFormData
              ? (options.body as FormData)
              : JSON.stringify(options.body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = (error as Error).name === "AbortError"
      return {
        kind: "error",
        error: new ApiError(
          0,
          aborted ? "timeout" : "network_error",
          aborted ? "The server took too long to respond." : "Could not reach the server.",
        ),
      }
    }
    clearTimeout(timer)

    if (response.status === 204) return { kind: "ok", data: undefined as T }

    const text = await response.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }

    if (response.ok) return { kind: "ok", data: parsed as T }

    const body = parsed as ApiErrorBody | null
    return {
      kind: "error",
      error: new ApiError(
        response.status,
        body?.error?.code ?? `http_${response.status}`,
        body?.error?.message ?? `Request failed with status ${response.status}.`,
        body?.error?.details,
      ),
    }
  }

  /**
   * Rotates the tokens now. The tracker's control channel calls this when
   * the server refuses its socket: a parked phone may make no REST call for
   * a quarter hour, so it cannot wait for one to do the rotating. Single
   * flight, and a refusal still ends the session as it does on any call.
   */
  refreshTokens(): Promise<TokenPair | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<TokenPair | null> {
    const current = this.hooks.getTokens()
    if (!current) return null

    const result = await this.send<AuthTokens>("POST", "/auth/refresh", {
      body: {
        refreshToken: current.refreshToken,
        deviceId: this.hooks.getDeviceId?.() ?? undefined,
      },
      auth: false,
    })

    if (result.kind === "error") {
      // A network blip must not log the user out. Only a definitive rejection does.
      if (result.error.status === 401 || result.error.status === 403) {
        await this.hooks.setTokens(null)
        this.hooks.onSessionExpired()
      }
      return null
    }

    const next = { accessToken: result.data.accessToken, refreshToken: result.data.refreshToken }
    await this.hooks.setTokens(next)
    return next
  }
}
