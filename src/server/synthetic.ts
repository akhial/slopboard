// Builds usage records in the shape the proxy queues them, for the seed script
// and the tests. Each provider family fills the flat `tokens` object with its
// own overlapping numbers, exactly as the proxy does, next to the canonical
// `token_breakdown`. See README.md, "Token accounting".

import { randomUUID } from "node:crypto";

export type ProviderKind = "claude" | "codex" | "gemini" | "other";

/** Non-overlapping usage of one request. */
export interface Usage {
  /** Input not served from or written to the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of cacheWrite with the 1 hour TTL. */
  cacheWrite1h?: number;
  /** Output excluding reasoning. */
  answer: number;
  reasoning: number;
}

export interface SyntheticRecord {
  kind: ProviderKind;
  at: Date;
  apiKey: string;
  model: string;
  /** What the client asked for; defaults to `model`. */
  alias?: string;
  usage?: Usage;
  sessionId?: string;
  parentSessionId?: string;
  /** Inbound request id; retries of one request share it. Defaults to a new id. */
  requestId?: string;
  /** Per-attempt id. Defaults to a new id. */
  executionId?: string;
  failedStatus?: number;
  failBody?: string;
  latencyMs?: number;
  ttftMs?: number;
  isFork?: boolean;
  isCompaction?: boolean;
  speed?: string;
  userAgent?: string;
  clientIp?: string;
  /** Account the upstream credential belongs to. */
  source?: string;
}

const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, answer: 0, reasoning: 0 };

const FAMILY: Record<ProviderKind, { provider: string; executor: string; endpoint: string; agent: string }> = {
  claude: { provider: "claude", executor: "ClaudeExecutor", endpoint: "POST /v1/messages", agent: "claude-cli/2.9.14 (external, cli)" },
  codex: { provider: "codex", executor: "CodexExecutor", endpoint: "POST /v1/responses", agent: "codex_cli_rs/0.142.0 (Ubuntu 24.04; x86_64)" },
  gemini: { provider: "gemini", executor: "GeminiExecutor", endpoint: "POST /v1beta/models/*action", agent: "GeminiCLI/0.31.0 (linux; x64)" },
  other: { provider: "openai-compatibility", executor: "OpenAICompatExecutor", endpoint: "POST /v1/chat/completions", agent: "opencode/1.4.2" },
};

/** The flat `tokens` object, with each family's own idea of what includes what. */
function flatTokens(kind: ProviderKind, u: Usage): Record<string, unknown> {
  const output = u.answer + u.reasoning;
  const base = {
    reasoning_tokens: u.reasoning,
    cache_read_tokens: u.cacheRead,
    cache_read_tokens_present: true,
    cache_creation_tokens: u.cacheWrite,
    ...(u.cacheWrite1h ? { cache_creation_1h_tokens: u.cacheWrite1h } : {}),
  };
  switch (kind) {
    case "claude":
      // Anthropic: input excludes cache traffic, output includes thinking.
      return {
        ...base,
        input_tokens: u.input,
        output_tokens: output,
        cached_tokens: u.cacheRead || u.cacheWrite,
        total_tokens: u.input + u.cacheRead + u.cacheWrite + output,
      };
    case "gemini":
      // Gemini: input includes cached content, thoughts are reported beside the candidates.
      return {
        ...base,
        input_tokens: u.input + u.cacheRead + u.cacheWrite,
        output_tokens: u.answer,
        cached_tokens: u.cacheRead,
        total_tokens: u.input + u.cacheRead + u.cacheWrite + output,
      };
    default:
      // OpenAI style: input includes cached tokens, output includes reasoning.
      return {
        ...base,
        input_tokens: u.input + u.cacheRead + u.cacheWrite,
        output_tokens: output,
        cached_tokens: u.cacheRead,
        total_tokens: u.input + u.cacheRead + u.cacheWrite + output,
      };
  }
}

/** One record as `GET /v8/management/observability/usage/queue` would return it. */
export function usageRecord(o: SyntheticRecord): Record<string, unknown> {
  const family = FAMILY[o.kind];
  const u = o.usage ?? NO_USAGE;
  const failed = o.failedStatus !== undefined;
  const requestId = o.requestId ?? randomUUID();
  const inputTotal = u.input + u.cacheRead + u.cacheWrite;
  const outputTotal = u.answer + u.reasoning;
  return {
    timestamp: o.at.toISOString(),
    latency_ms: o.latencyMs ?? 0,
    ttft_ms: o.ttftMs ?? 0,
    source: o.source ?? "team-account@example.com",
    auth_index: "a1b2c3d4e5f60718",
    client_ip: o.clientIp ?? "100.64.0.7",
    resolved_client_ip: o.clientIp ?? "100.64.0.7",
    x_forwarded_for: "",
    user_agent: o.userAgent ?? family.agent,
    tokens: flatTokens(o.kind, u),
    failed,
    generate: true,
    stream: true,
    fail: failed ? { status_code: o.failedStatus, body: o.failBody ?? "" } : { status_code: 200, body: "" },
    accounting_version: 2,
    token_breakdown: {
      schema_version: 2,
      quality: "complete",
      total_tokens: inputTotal + outputTotal,
      input: {
        total_tokens: inputTotal,
        uncached_tokens: u.input,
        cache_read_tokens: u.cacheRead,
        cache_write_tokens: u.cacheWrite,
      },
      output: { total_tokens: outputTotal, non_reasoning_tokens: u.answer, reasoning_tokens: u.reasoning },
      unclassified_tokens: 0,
    },
    provider: family.provider,
    executor_type: family.executor,
    model: o.model,
    alias: o.alias ?? o.model,
    endpoint: family.endpoint,
    auth_type: "oauth",
    api_key: o.apiKey,
    is_native_key: true,
    access_provider: "config-inline",
    request_id: requestId,
    execution_id: o.executionId ?? randomUUID(),
    trace_id: requestId,
    ...(o.sessionId ? { session_id: o.sessionId } : {}),
    ...(o.parentSessionId ? { parent_session_id: o.parentSessionId } : {}),
    ...(o.isFork ? { is_fork: true, node_kind: "fork" } : {}),
    ...(o.isCompaction ? { is_compaction: true, node_kind: "compaction" } : {}),
    reasoning_effort: u.reasoning > 0 ? "high" : "",
    service_tier: "default",
    ...(o.speed ? { speed: o.speed } : {}),
  };
}
