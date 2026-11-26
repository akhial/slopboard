// Client for the parts of the proxy's management API that Slopboard uses.
// Routes: CLIProxyAPI internal/api/server_management_v8.go.

const QUEUE_PATH = "/v8/management/observability/usage/queue";
const API_KEYS_PATH = "/v8/management/config/access/api-keys";
const QUOTA_HISTORY_PATH = "/v8/management/quota/history";

export interface QuotaHistoryWindowSeries {
  id: string;
  period_seconds: number;
  /** [t_ms, used_percent, reset_at_ms | null] */
  points: [number, number, number | null][];
  dropped_at?: number;
}

export interface QuotaHistoryAccount {
  auth_id: string;
  auth_index: string;
  file_name: string;
  provider: string;
  label: string;
  email: string;
  plan: string;
  /** [t_ms, plan] oldest first */
  plans?: [number, string][];
  windows: QuotaHistoryWindowSeries[];
}

export interface QuotaHistoryResponse {
  enabled: boolean;
  now: number;
  poll_interval_seconds: number;
  accounts: QuotaHistoryAccount[];
}

export class ProxyError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the proxy could not be reached at all. */
    readonly status: number,
  ) {
    super(message);
    this.name = "ProxyError";
  }

  /** Bad or missing management key, remote management off, or this address is banned. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ApiKeyList {
  keys: string[];
  /** Version of the proxy's config file; send it back as If-Match when writing. */
  etag: string | null;
  /** The proxy's config has no access.api-keys entry at all. */
  missing: boolean;
}

export interface ApiKeyChange {
  /** The list as read. */
  before: string[];
  /** The list as written, or the same list when nothing had to change. */
  after: string[];
  changed: boolean;
}

export class ProxyClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly managementKey: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // The management middleware takes "Authorization: Bearer <key>" or "X-Management-Key".
    headers.set("Authorization", `Bearer ${this.managementKey}`);
    try {
      return await fetch(this.baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ProxyError(`proxy unreachable at ${this.baseUrl}: ${(error as Error).message}`, 0);
    }
  }

  private static async fail(res: Response, what: string): Promise<never> {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProxyError(`${what}: HTTP ${res.status} ${body}`.trim(), res.status);
  }

  /**
   * Pops up to `count` usage records. The pop is destructive: whatever this
   * returns is gone from the proxy, so the caller owns it from here on.
   */
  async popUsage(count: number): Promise<unknown[]> {
    const res = await this.request(`${QUEUE_PATH}?count=${count}`);
    if (!res.ok) await ProxyClient.fail(res, "usage queue");
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      throw new ProxyError(`usage queue: unreadable response: ${(error as Error).message}`, res.status);
    }
    if (!Array.isArray(body)) throw new ProxyError("usage queue: response is not an array", res.status);
    return body;
  }

  /**
   * Reads recorded quota history (used % and reset timestamps per credential)
   * from the proxy. Returns enabled=false when the proxy does not support or
   * has disabled quota history.
   */
  async getQuotaHistory(fromMs?: number, toMs?: number): Promise<QuotaHistoryResponse> {
    const params = new URLSearchParams();
    if (fromMs !== undefined) params.set("from", String(Math.floor(fromMs)));
    if (toMs !== undefined) params.set("to", String(Math.floor(toMs)));
    const qs = params.toString();
    const res = await this.request(qs ? `${QUOTA_HISTORY_PATH}?${qs}` : QUOTA_HISTORY_PATH);
    if (res.status === 404) {
      return { enabled: false, now: Date.now(), poll_interval_seconds: 0, accounts: [] };
    }
    if (!res.ok) await ProxyClient.fail(res, "quota history");
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      throw new ProxyError(`quota history: unreadable response: ${(error as Error).message}`, res.status);
    }
    if (typeof body !== "object" || body === null || !Array.isArray((body as { accounts?: unknown }).accounts)) {
      throw new ProxyError("quota history: unexpected response shape", res.status);
    }
    return body as QuotaHistoryResponse;
  }

  /** The client API keys the proxy accepts. */
  async getApiKeys(): Promise<ApiKeyList> {
    const res = await this.request(API_KEYS_PATH);
    if (res.status === 404) {
      // Only the config handler's own "this entry does not exist" means "no
      // keys". Any other 404 (wrong URL, management API switched off, a reverse
      // proxy in between) must not be mistaken for an empty list and written over.
      const body: unknown = await res.json().catch(() => null);
      if (typeof body === "object" && body !== null && (body as { error?: unknown }).error === "not_found") {
        return { keys: [], etag: null, missing: true };
      }
      throw new ProxyError("read api keys: HTTP 404 that is not the proxy's own \"not_found\"; is PROXY_URL right and the management API on?", 404);
    }
    if (!res.ok) await ProxyClient.fail(res, "read api keys");
    const body: unknown = await res.json().catch(() => null);
    if (!Array.isArray(body) || body.some((k) => typeof k !== "string")) {
      throw new ProxyError("read api keys: expected an array of strings", res.status);
    }
    return { keys: body as string[], etag: res.headers.get("etag"), missing: false };
  }

  /**
   * Replaces the whole key list (the proxy has no append). With `etag` the
   * write only succeeds if the config is unchanged since it was read; a 412
   * means someone else wrote in between and the caller should start over.
   */
  async putApiKeys(keys: string[], etag: string | null): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const res = await this.request(API_KEYS_PATH, { method: "PUT", headers, body: JSON.stringify(keys) });
    if (!res.ok) await ProxyClient.fail(res, "write api keys");
  }

  /**
   * Reads the key list, applies `change`, and writes the result back, retrying
   * when another writer got in between. `change` returns null for "nothing to do".
   *
   * The write is always conditional on the version that was read. The one
   * exception is a config with no key list yet, which has no version to name.
   */
  async updateApiKeys(change: (keys: string[]) => string[] | null, attempts = 5): Promise<ApiKeyChange> {
    for (let attempt = 1; ; attempt++) {
      const list = await this.getApiKeys();
      const next = change([...list.keys]);
      if (next === null) return { before: list.keys, after: list.keys, changed: false };
      if (!list.missing && !list.etag) {
        throw new ProxyError("the proxy sent its key list without an ETag; refusing to replace the list without a version to check against", 0);
      }
      try {
        await this.putApiKeys(next, list.etag);
        return { before: list.keys, after: next, changed: true };
      } catch (error) {
        if (error instanceof ProxyError && error.status === 412 && attempt < attempts) continue;
        throw error;
      }
    }
  }
}
