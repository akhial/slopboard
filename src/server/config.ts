// Settings, all from the environment, and the only place the environment is read.
// Bun loads `.env` from the working directory.

export interface Config {
  /** Read-write connection, owner of the schema. */
  databaseUrl: string;
  /** Connection of the read-only role behind POST /api/sql. Null disables that endpoint. */
  databaseRoUrl: string | null;
  /** Base URL of the proxy. Null when PROXY_URL is unset: no collector, no key CLI. */
  proxyUrl: string | null;
  proxyManagementKey: string;
  /** IANA zone for days, hours and "today". */
  boardTz: string;
  host: string;
  port: number;
  collectorEnabled: boolean;
  pollIntervalMs: number;
  /** Records asked from the proxy per poll. */
  pollBatch: number;
  /** Records kept in memory while Postgres is unavailable. */
  maxPending: number;
  boardCacheMs: number;
  pricesUrl: string;
  pricesRefreshHours: number;
  sqlTimeoutMs: number;
  sqlMaxRows: number;
  /** Size budget of one POST /api/sql result. */
  sqlMaxBytes: number;
  /** False when NODE_ENV is "production": the UI is then served minified and cached. */
  development: boolean;
}

export const DEFAULT_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const boardTz = env.BOARD_TZ?.trim() || "UTC";
  if (!isValidTimeZone(boardTz)) throw new Error(`BOARD_TZ "${boardTz}" is not an IANA time zone`);

  return {
    databaseUrl,
    databaseRoUrl: env.DATABASE_RO_URL?.trim() || null,
    proxyUrl: env.PROXY_URL?.trim().replace(/\/+$/, "") || null,
    proxyManagementKey: env.PROXY_MANAGEMENT_KEY?.trim() ?? "",
    boardTz,
    host: env.HOST?.trim() || "0.0.0.0",
    port: int(env, "PORT", 8318, 0),
    collectorEnabled: bool(env, "COLLECTOR_ENABLED", true),
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 2000, 100),
    pollBatch: int(env, "POLL_BATCH", 500, 1),
    maxPending: int(env, "MAX_PENDING", 50_000, 1),
    boardCacheMs: int(env, "BOARD_CACHE_MS", 5000, 0),
    pricesUrl: env.PRICES_URL?.trim() || DEFAULT_PRICES_URL,
    pricesRefreshHours: int(env, "PRICES_REFRESH_HOURS", 24, 1),
    sqlTimeoutMs: int(env, "SQL_TIMEOUT_MS", 5000, 100),
    sqlMaxRows: int(env, "SQL_MAX_ROWS", 1000, 1),
    sqlMaxBytes: int(env, "SQL_MAX_BYTES", 4_000_000, 1000),
    development: env.NODE_ENV?.trim() !== "production",
  };
}
