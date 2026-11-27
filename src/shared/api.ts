// The contract between the server (src/server) and the leaderboard UI (src/web).
// Both sides import these types. Change them only together.

/** Time window the board covers. "today" and "week" follow the board timezone. */
export type RangeKey = "today" | "7d" | "30d" | "all";

/** Whether `costUsd` reflects real subscription quota spend or public API list rates. */
export type CostMode = "subscription" | "list";

export interface TokenCounts {
  /** Input tokens that were not served from the prompt cache. */
  input: number;
  /** Input tokens read from the prompt cache. */
  cacheRead: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** The part of `output` that was reasoning. 0 when the provider does not report it. */
  reasoning: number;
  /** input + cacheRead + cacheWrite + output. */
  total: number;
}

export interface PersonRow {
  /** Stable slug, safe for URLs and DOM ids. The shared key is "shared". */
  id: string;
  name: string;
  /** True for traffic on a key that belongs to no one (the old shared key, unknown keys). */
  unassigned: boolean;
  /**
   * 1-based rank by total tokens in this range, counted among assigned people only.
   * 0 for unassigned rows, which are never ranked.
   */
  rank: number;
  /**
   * Rank among assigned people in the preceding window of the same length. Null when the
   * person had no tokens then, when range is "all", and for unassigned rows.
   */
  previousRank: number | null;
  requests: number;
  failedRequests: number;
  tokens: TokenCounts;
  /**
   * Primary cost in USD: real subscription quota spend when `Board.costMode === "subscription"`,
   * or public API list value when `"list"`. 0 when there was no activity.
   * Null only when there were tokens and none of them could be priced.
   */
  costUsd: number | null;
  /** What these tokens would cost at public API list prices, in USD. */
  listCostUsd: number | null;
  /** Distinct top-level threads (a thread is a root session plus its subagents). */
  threads: number;
  /** Distinct subagent sessions spawned. */
  subagents: number;
  /** Share of total tokens spent inside subagents, 0..1. */
  subagentTokenShare: number;
  /** cacheRead / (input + cacheRead + cacheWrite), 0..1. */
  cacheHitRate: number;
  /** Model with the most tokens, as a display name, or null. */
  topModel: string | null;
  /** Days with at least one request in this range. */
  activeDays: number;
  /** Consecutive active days ending today (board timezone), over all time. */
  streakDays: number;
  /** Hour of day (0-23, board timezone) with the most tokens, or null. */
  peakHour: number | null;
  lastSeenAt: string | null;
  /** Total tokens per timeline bucket, aligned with Board.timeline.buckets. */
  spark: number[];
}

export interface ModelRow {
  /** Model id as requested by clients. */
  model: string;
  displayName: string;
  provider: string;
  requests: number;
  tokens: TokenCounts;
  costUsd: number | null;
  listCostUsd: number | null;
  /** False when no price is known under the active cost mode, so costUsd is null. */
  priced: boolean;
  /** Person id with the most tokens on this model, or null. */
  topPersonId: string | null;
}

export interface Timeline {
  /** "hour" for today, "day" otherwise. */
  unit: "hour" | "day";
  /** ISO start of each bucket, oldest first. */
  buckets: string[];
  /** Total tokens per bucket for each person id (same ids as Board.people). */
  series: Record<string, number[]>;
}

export interface HeatCell {
  /** 0 = Monday ... 6 = Sunday, board timezone. */
  weekday: number;
  /** 0-23, board timezone. */
  hour: number;
  tokens: number;
  requests: number;
}

/** A funny superlative with one winner. Server decides the list and the wording. */
export interface Award {
  id: string;
  title: string;
  /** One emoji. */
  emoji: string;
  /** One short sentence saying what earns it. */
  blurb: string;
  /** Person id, or null when nobody qualifies in this range. */
  winnerId: string | null;
  /** Already formatted for display, e.g. "41.2M tokens", "03:14 average", "87%". */
  value: string | null;
  runnerUpId: string | null;
}

/** A single record-setting thing (one thread, one request, one hour), not a per-person total. */
export interface RecordCard {
  id: string;
  title: string;
  emoji: string;
  /** Already formatted headline number. */
  value: string;
  /** Already formatted supporting line, e.g. "claude-fable-5-2 · 214 requests · Tue 02:10". */
  detail: string;
  personId: string | null;
  at: string | null;
}

export interface LiveEvent {
  at: string;
  personId: string;
  /** Model id as requested by the client. */
  model: string;
  /** Display name of that model. */
  modelName: string;
  totalTokens: number;
  costUsd: number | null;
  subagent: boolean;
  failed: boolean;
}

export interface BoardTotals {
  requests: number;
  failedRequests: number;
  tokens: TokenCounts;
  costUsd: number | null;
  listCostUsd: number | null;
  threads: number;
  subagents: number;
  /** Assigned people with at least one request in this range. */
  people: number;
  /** Tokens per minute over the last 10 minutes, regardless of range. */
  tokensPerMinuteNow: number;
}

export interface Board {
  generatedAt: string;
  range: RangeKey;
  /** ISO start of the window, null for "all". */
  rangeStart: string | null;
  /** IANA timezone used for days, hours and "today". */
  timezone: string;
  /** Whether `costUsd` is real subscription spend or public API list price. */
  costMode: CostMode;
  /** Active provider filter (sorted lowercase), or null when all providers are included. */
  providers: string[] | null;
  /** Every provider ever seen in the store, in display order. */
  availableProviders: string[];
  /** Newest event stored, null when the store is empty. */
  lastEventAt: string | null;
  /**
   * Seconds since the collector last pulled from the proxy successfully, null if never.
   * The collector polls every few seconds, so over 60 means it is behind and over 300 means stale.
   */
  collectorLagSeconds: number | null;
  totals: BoardTotals;
  /**
   * Every registered person, plus the unassigned "shared" row once it has ever had traffic,
   * so every person id used anywhere in this document resolves here. Rows can have zero
   * activity in this range. Assigned people come first in rank order, unassigned rows last.
   */
  people: PersonRow[];
  /** Sorted by total tokens, largest first. */
  models: ModelRow[];
  timeline: Timeline;
  /** Always the last 28 days, regardless of range. Cells with no traffic are omitted. */
  heatmap: HeatCell[];
  awards: Award[];
  records: RecordCard[];
  /** Newest first, at most 30. */
  recent: LiveEvent[];
}

/** GET /api/board?range=<RangeKey>[&providers=claude,codex] -> Board */
export const BOARD_PATH = "/api/board";

/** GET /api/health -> Health */
export interface Health {
  ok: boolean;
  db: boolean;
  collectorLagSeconds: number | null;
  events: number;
}

/** POST /api/sql { "sql": "select ..." } -> SqlResult. Runs as the read-only role. */
export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface ApiError {
  error: string;
}
