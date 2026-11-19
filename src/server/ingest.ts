// Turns the proxy's usage records into `events` rows and stores them.
//
// Record shape: `queuedUsageDetail` in CLIProxyAPI internal/redisqueue/plugin.go.
// The semantics relied on here are written up in README.md ("What the proxy sends").

import type { Db } from "./db.ts";

/** One row of the `events` table. Keys are column names, so rows go straight into `sql(rows)`. */
export interface EventRow {
  event_id: string;
  ts: string;
  key_hash: string | null;
  request_id: string | null;
  trace_id: string;
  session_id: string | null;
  parent_session_id: string | null;
  is_subagent: boolean;
  is_fork: boolean;
  is_compaction: boolean;
  node_kind: string | null;
  provider: string;
  executor_type: string | null;
  model: string;
  alias: string;
  requested_model: string;
  response_model: string | null;
  endpoint: string | null;
  auth_type: string | null;
  auth_index: string | null;
  source: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  speed: string | null;
  stream: boolean;
  generate: boolean;
  failed: boolean;
  status_code: number | null;
  fail_code: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  unclassified_tokens: number;
  token_quality: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  client_ip: string | null;
  user_agent: string | null;
  raw: Record<string, unknown>;
}

type Json = Record<string, unknown>;

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** The hash an API key is known by everywhere in Slopboard. */
export function hashApiKey(key: string): string {
  return sha256Hex(key.trim());
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Postgres text and jsonb reject NUL. */
function clean(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", "") : value;
}

function text(value: unknown): string {
  return typeof value === "string" ? clean(value).trim() : "";
}

function textOrNull(value: unknown): string | null {
  return text(value) || null;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** "model(high)" -> "model". Mirrors ParseSuffix in the proxy's internal/thinking/suffix.go. */
export function stripThinkingSuffix(model: string): string {
  const open = model.lastIndexOf("(");
  if (open <= 0 || !model.endsWith(")")) return model;
  return model.slice(0, open).trim() || model;
}

const ISO_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Keeps the proxy's timestamp (Postgres rounds its nanoseconds), or falls back to now. */
function timestamp(value: unknown): string {
  if (typeof value === "string") {
    const m = ISO_TS.exec(value.trim());
    // Validate with millisecond precision: Date.parse is not guaranteed to take nine digits.
    if (m && !Number.isNaN(Date.parse(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3]}`))) {
      const year = Number(value.slice(0, 4));
      if (year >= 2000 && year < 3000) return value.trim();
    }
  }
  return new Date().toISOString();
}

interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  unclassified: number;
  quality: string;
}

/**
 * Maps the record onto non-overlapping buckets.
 *
 * `token_breakdown` is the proxy's canonical v2 accounting: per provider it has
 * already taken cache tokens out of input (OpenAI and Gemini report them inside
 * input, Anthropic beside it) and folded reasoning into output (Gemini reports
 * it beside output). So nothing here adds or subtracts across buckets. The flat
 * `tokens` object keeps each provider's own overlapping numbers and is only
 * used for its total when a record carries no usable breakdown, in which case
 * the tokens stay unclassified rather than being guessed into buckets.
 */
function tokensOf(record: Json): Tokens {
  const flat = isObject(record.tokens) ? record.tokens : {};
  const tb = record.token_breakdown;
  if (isObject(tb) && tb.schema_version === 2 && isObject(tb.input) && isObject(tb.output)) {
    const output = count(tb.output.total_tokens);
    const cacheWrite = count(tb.input.cache_write_tokens);
    return {
      input: count(tb.input.uncached_tokens),
      cacheRead: count(tb.input.cache_read_tokens),
      cacheWrite,
      cacheWrite1h: Math.min(count(flat.cache_creation_1h_tokens), cacheWrite),
      output,
      reasoning: Math.min(count(tb.output.reasoning_tokens), output),
      unclassified: count(tb.unclassified_tokens),
      quality: text(tb.quality) || "complete",
    };
  }
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    unclassified: count(flat.total_tokens),
    quality: "legacy",
  };
}

const REDACTED = "[redacted]";

/** Deep copy without NULs and without any occurrence of the given secrets. */
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let s = clean(value);
    for (const secret of secrets) if (s.includes(secret)) s = s.replaceAll(secret, REDACTED);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (isObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[clean(k)] = scrub(v, secrets);
    return out;
  }
  return value;
}

/**
 * `source` names the upstream credential. For OAuth credentials that is the
 * account e-mail, which is worth keeping. For API-key upstreams it is the
 * upstream key itself, and with no credential at all it is the client key
 * (resolveUsageSource in the proxy), so anything that is not an OAuth account
 * is replaced by a short fingerprint.
 */
function safeSource(source: string, authType: string, apiKey: string): string | null {
  if (!source) return null;
  if (source !== apiKey && authType.toLowerCase() === "oauth") return source;
  return `sha256:${sha256Hex(source).slice(0, 16)}`;
}

/** Shorter strings are not searched for elsewhere: replacing every "abc" would only damage the record. */
const MIN_SECRET_LENGTH = 8;

// Credentials whose value is not known here (an OAuth access token, say) can
// still be recognised by how they are written when an upstream echoes the
// request back in an error.
const BEARER = /\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const KEY_HEADER = /((?:authorization|x-api-key|x-goog-api-key|api[-_]key)["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)[^\s"',;]{16,}/gi;

/** Blanks out anything in an upstream error text that is written like a credential. */
export function redactCredentials(text: string): string {
  return text.replace(BEARER, `$1$2${REDACTED}`).replace(KEY_HEADER, `$1${REDACTED}`);
}

const MAX_FAIL_BODY = 8000;

/** Returns null for anything that is not a usage record. */
export function normalizeRecord(input: unknown): EventRow | null {
  let record = input;
  if (typeof record === "string") {
    try {
      record = JSON.parse(record);
    } catch {
      return null;
    }
  }
  if (!isObject(record)) return null;
  // Control messages of the queue's pub/sub side, never usage.
  if (record.refresh === true || record.support_refresh === true) return null;
  if (!("tokens" in record) && !("token_breakdown" in record) && !("model" in record)) return null;

  const apiKey = text(record.api_key);
  const authType = text(record.auth_type);
  const originalSource = text(record.source);
  const source = safeSource(originalSource, authType, apiKey);

  // The client key never stays, wherever in the record it shows up. Neither
  // does an upstream credential: when `source` is one (it was replaced by a
  // fingerprint), an upstream that echoes its Authorization header would
  // otherwise put it right back through the error body.
  const secrets: string[] = [];
  if (apiKey) secrets.push(apiKey);
  if (source !== originalSource && originalSource.length >= MIN_SECRET_LENGTH) secrets.push(originalSource);
  const raw = scrub(record, secrets) as Json;
  delete raw.api_key;
  if (source !== null) raw.source = source;
  if (isObject(raw.response_headers)) {
    for (const name of Object.keys(raw.response_headers)) {
      if (/^(set-cookie|authorization|proxy-authorization)$/i.test(name)) delete raw.response_headers[name];
    }
  }
  const fail = isObject(raw.fail) ? raw.fail : {};
  if (typeof fail.body === "string") {
    const body = redactCredentials(fail.body);
    fail.body = body.length > MAX_FAIL_BODY ? `${body.slice(0, MAX_FAIL_BODY)}... [truncated]` : body;
  }

  const requestId = text(record.request_id);
  const eventId = text(record.execution_id) || `h:${sha256Hex(JSON.stringify(raw))}`;
  const traceId = text(record.trace_id) || requestId || eventId;

  const sessionId = text(record.session_id).toLowerCase();
  let parentSessionId = sessionId ? text(record.parent_session_id).toLowerCase() : "";
  if (parentSessionId === sessionId) parentSessionId = "";
  const nodeKind = text(record.node_kind).toLowerCase();
  const isFork = record.is_fork === true || nodeKind === "fork";
  const isCompaction = record.is_compaction === true || nodeKind === "compaction";

  const model = text(record.model) || "unknown";
  const alias = text(record.alias) || model;
  const failed = record.failed === true;
  const tokens = tokensOf(record);
  const statusCode = count(fail.status_code);

  return {
    event_id: eventId,
    ts: timestamp(record.timestamp),
    key_hash: apiKey ? hashApiKey(apiKey) : null,
    request_id: requestId || null,
    trace_id: traceId,
    session_id: sessionId || null,
    parent_session_id: parentSessionId || null,
    // A session under a parent is a subagent, unless the link only records
    // that the conversation was forked or compacted.
    is_subagent: parentSessionId !== "" && !isFork && !isCompaction,
    is_fork: isFork,
    is_compaction: isCompaction,
    node_kind: nodeKind || null,
    provider: text(record.provider) || "unknown",
    executor_type: textOrNull(record.executor_type),
    model,
    alias,
    requested_model: stripThinkingSuffix(alias),
    response_model: textOrNull(record.response_model),
    endpoint: textOrNull(record.endpoint),
    auth_type: authType || null,
    auth_index: textOrNull(record.auth_index),
    source,
    reasoning_effort: textOrNull(record.reasoning_effort),
    service_tier: textOrNull(record.service_tier),
    speed: textOrNull(record.speed)?.toLowerCase() ?? null,
    stream: record.stream === true,
    generate: record.generate !== false,
    failed,
    status_code: statusCode || (failed ? 500 : 200),
    fail_code: textOrNull(fail.code),
    input_tokens: tokens.input,
    cache_read_tokens: tokens.cacheRead,
    cache_write_tokens: tokens.cacheWrite,
    cache_write_1h_tokens: tokens.cacheWrite1h,
    output_tokens: tokens.output,
    reasoning_tokens: tokens.reasoning,
    unclassified_tokens: tokens.unclassified,
    token_quality: tokens.quality,
    latency_ms: record.latency_ms === undefined ? null : count(record.latency_ms),
    ttft_ms: record.ttft_ms === undefined ? null : count(record.ttft_ms),
    client_ip: textOrNull(record.resolved_client_ip) ?? textOrNull(record.client_ip),
    user_agent: textOrNull(record.user_agent),
    raw,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Inserts rows that are not stored yet (event_id is the primary key) and keeps
 * `sessions`, `models` and every affected `thread_id` in step, all in one
 * transaction. Returns the number of rows that were new.
 */
export async function insertEvents(sql: Db, rows: EventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const unique = [...new Map(rows.map((r) => [r.event_id, r])).values()];

  return await sql.begin(async (tx) => {
    const insertedIds: string[] = [];
    for (const chunk of chunks(unique, 400)) {
      const res = await tx<{ event_id: string }[]>`
        insert into events ${tx(chunk)} on conflict (event_id) do nothing returning event_id`;
      for (const r of res) insertedIds.push(r.event_id);
    }
    if (insertedIds.length === 0) return 0;
    const insertedSet = new Set(insertedIds);
    const inserted = unique.filter((r) => insertedSet.has(r.event_id));

    const models = new Map<string, { model: string; provider: string }>();
    for (const r of inserted) if (!models.has(r.model)) models.set(r.model, { model: r.model, provider: r.provider });
    await tx`insert into models ${tx([...models.values()])} on conflict (model) do nothing`;

    // One row per session; a known parent beats an unknown one.
    const sessions = new Map<string, { session_id: string; parent_session_id: string | null; thread_id: string; first_seen: string }>();
    for (const r of inserted) {
      if (!r.session_id) continue;
      const seen = sessions.get(r.session_id);
      if (!seen) {
        sessions.set(r.session_id, {
          session_id: r.session_id,
          parent_session_id: r.parent_session_id,
          thread_id: r.session_id,
          first_seen: r.ts,
        });
      } else if (!seen.parent_session_id && r.parent_session_id) {
        seen.parent_session_id = r.parent_session_id;
      }
    }
    if (sessions.size === 0) return insertedIds.length;

    // Returns sessions that are new or that just learned their parent.
    const changed: string[] = [];
    for (const chunk of chunks([...sessions.values()], 1000)) {
      const res = await tx<{ session_id: string }[]>`
        insert into sessions ${tx(chunk)}
        on conflict (session_id) do update set parent_session_id = excluded.parent_session_id
          where sessions.parent_session_id is null and excluded.parent_session_id is not null
        returning session_id`;
      for (const r of res) changed.push(r.session_id);
    }

    let rethreaded: string[] = [];
    if (changed.length > 0) {
      // Everything under a changed session had that session as its root until
      // now, so `thread_id = any(changed)` finds the whole affected subtree.
      // Walk each affected session up to its root; a parent that never sent a
      // request of its own still counts as the root. Depth is capped to
      // survive a cycle.
      const res = await tx<{ session_id: string }[]>`
        with recursive up (session_id, cur, depth) as (
          select s.session_id, s.session_id, 0
          from sessions s
          where s.session_id = any(${changed}::text[]) or s.thread_id = any(${changed}::text[])
          union all
          select u.session_id, p.parent_session_id, u.depth + 1
          from up u
          join sessions p on p.session_id = u.cur
          where p.parent_session_id is not null and u.depth < 64
        ), roots as (
          select distinct on (session_id) session_id, cur as root
          from up
          order by session_id, depth desc
        )
        update sessions s set thread_id = r.root
        from roots r
        where s.session_id = r.session_id and s.thread_id is distinct from r.root
        returning s.session_id`;
      rethreaded = res.map((r) => r.session_id);
    }

    for (const chunk of chunks(insertedIds, 5000)) {
      await tx`
        update events e set thread_id = s.thread_id
        from sessions s
        where e.event_id = any(${chunk}::text[]) and s.session_id = e.session_id`;
    }
    if (rethreaded.length > 0) {
      await tx`
        update events e set thread_id = s.thread_id
        from sessions s
        where e.session_id = any(${rethreaded}::text[]) and s.session_id = e.session_id
          and e.thread_id is distinct from s.thread_id`;
    }
    return insertedIds.length;
  });
}
