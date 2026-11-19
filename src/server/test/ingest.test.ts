import { describe, expect, test } from "bun:test";
import { hashApiKey, normalizeRecord, redactCredentials, sha256Hex, stripThinkingSuffix } from "../ingest.ts";
import { usageRecord, type ProviderKind, type Usage } from "../synthetic.ts";

const KEY = "sk-live-client-key-0123456789";

/** A record as the proxy emits it; `tokens` and `token_breakdown` are filled in per test. */
function record(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: "2026-11-19T10:11:12.123456789Z",
    latency_ms: 4200,
    ttft_ms: 900,
    source: "someone@example.com",
    auth_index: "abc",
    client_ip: "100.64.0.9",
    resolved_client_ip: "100.64.0.9",
    x_forwarded_for: "",
    user_agent: "claude-cli/2.9.14",
    failed: false,
    generate: true,
    stream: true,
    fail: { status_code: 200, body: "" },
    accounting_version: 2,
    provider: "claude",
    executor_type: "ClaudeExecutor",
    model: "claude-fable-5-2",
    alias: "claude-fable-5-2",
    endpoint: "POST /v1/messages",
    auth_type: "oauth",
    api_key: KEY,
    is_native_key: true,
    request_id: "0197aaaa-0000-7000-8000-000000000001",
    execution_id: "5b1c8a52-6a3e-4d0b-9d0e-3d2c1b0a9f8e",
    trace_id: "0197aaaa-0000-7000-8000-000000000001",
    session_id: "11111111-1111-4111-8111-111111111111",
    reasoning_effort: "high",
    service_tier: "default",
    ...extra,
  };
}

function buckets(row: NonNullable<ReturnType<typeof normalizeRecord>>) {
  return {
    input: row.input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
    unclassified: row.unclassified_tokens,
  };
}

const total = (b: ReturnType<typeof buckets>) => b.input + b.cacheRead + b.cacheWrite + b.output + b.unclassified;

describe("token accounting", () => {
  test("Anthropic: cache traffic sits beside input, thinking sits inside output", () => {
    // usage: input_tokens 12, cache_read 50000, cache_creation 2000, output_tokens 900 of which 300 thinking
    const row = normalizeRecord(
      record({
        tokens: {
          input_tokens: 12,
          output_tokens: 900,
          reasoning_tokens: 300,
          cached_tokens: 50_000,
          cache_read_tokens: 50_000,
          cache_read_tokens_present: true,
          cache_creation_tokens: 2000,
          cache_creation_1h_tokens: 500,
          total_tokens: 52_912,
        },
        token_breakdown: {
          schema_version: 2,
          quality: "complete",
          total_tokens: 52_912,
          input: { total_tokens: 52_012, uncached_tokens: 12, cache_read_tokens: 50_000, cache_write_tokens: 2000 },
          output: { total_tokens: 900, non_reasoning_tokens: 600, reasoning_tokens: 300 },
          unclassified_tokens: 0,
        },
      }),
    )!;
    const b = buckets(row);
    expect(b).toEqual({ input: 12, cacheRead: 50_000, cacheWrite: 2000, output: 900, reasoning: 300, unclassified: 0 });
    expect(total(b)).toBe(52_912);
    expect(row.cache_write_1h_tokens).toBe(500);
    expect(row.token_quality).toBe("complete");
  });

  test("OpenAI/Codex: cached tokens are part of input and must not be added again", () => {
    // usage: input_tokens 60000 with cached_tokens 55000, output_tokens 1500 with reasoning 1000
    const row = normalizeRecord(
      record({
        provider: "codex",
        executor_type: "CodexExecutor",
        model: "gpt-5.3-codex",
        tokens: {
          input_tokens: 60_000,
          output_tokens: 1500,
          reasoning_tokens: 1000,
          cached_tokens: 55_000,
          cache_read_tokens: 55_000,
          cache_read_tokens_present: true,
          cache_creation_tokens: 0,
          total_tokens: 61_500,
        },
        token_breakdown: {
          schema_version: 2,
          quality: "complete",
          total_tokens: 61_500,
          input: { total_tokens: 60_000, uncached_tokens: 5000, cache_read_tokens: 55_000, cache_write_tokens: 0 },
          output: { total_tokens: 1500, non_reasoning_tokens: 500, reasoning_tokens: 1000 },
          unclassified_tokens: 0,
        },
      }),
    )!;
    const b = buckets(row);
    expect(b).toEqual({ input: 5000, cacheRead: 55_000, cacheWrite: 0, output: 1500, reasoning: 1000, unclassified: 0 });
    // Adding the flat fields naively would give 60000 + 55000 + 1500 = 116500.
    expect(total(b)).toBe(61_500);
  });

  test("Gemini: thoughts are reported beside the answer and are folded into output", () => {
    // usage: promptTokenCount 10000 with cachedContentTokenCount 4000, candidates 500, thoughts 700
    const row = normalizeRecord(
      record({
        provider: "gemini",
        executor_type: "GeminiExecutor",
        model: "gemini-3.1-pro-preview",
        tokens: {
          input_tokens: 10_000,
          output_tokens: 500,
          reasoning_tokens: 700,
          cached_tokens: 4000,
          cache_read_tokens: 4000,
          cache_read_tokens_present: true,
          cache_creation_tokens: 0,
          total_tokens: 11_200,
        },
        token_breakdown: {
          schema_version: 2,
          quality: "complete",
          total_tokens: 11_200,
          input: { total_tokens: 10_000, uncached_tokens: 6000, cache_read_tokens: 4000, cache_write_tokens: 0 },
          output: { total_tokens: 1200, non_reasoning_tokens: 500, reasoning_tokens: 700 },
          unclassified_tokens: 0,
        },
      }),
    )!;
    const b = buckets(row);
    expect(b).toEqual({ input: 6000, cacheRead: 4000, cacheWrite: 0, output: 1200, reasoning: 700, unclassified: 0 });
    expect(total(b)).toBe(11_200);
  });

  test("an unknown provider's total is kept but not guessed into buckets", () => {
    const row = normalizeRecord(
      record({
        provider: "mystery",
        tokens: { input_tokens: 700, output_tokens: 300, cached_tokens: 400, total_tokens: 1000 },
        token_breakdown: {
          schema_version: 2,
          quality: "unclassified",
          total_tokens: 1000,
          input: { total_tokens: 0, uncached_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          output: { total_tokens: 0, non_reasoning_tokens: 0, reasoning_tokens: 0 },
          unclassified_tokens: 1000,
        },
      }),
    )!;
    expect(buckets(row)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unclassified: 1000 });
    expect(row.token_quality).toBe("unclassified");
  });

  test("a record without a v2 breakdown keeps only its total", () => {
    const row = normalizeRecord(
      record({ tokens: { input_tokens: 60_000, output_tokens: 1500, cached_tokens: 55_000, total_tokens: 61_500 } }),
    )!;
    expect(buckets(row)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unclassified: 61_500 });
    expect(row.token_quality).toBe("legacy");
  });

  test.each(["claude", "codex", "gemini", "other"] as ProviderKind[])(
    "synthetic %s records round-trip without double counting",
    (kind) => {
      const usage: Usage = { input: 1234, cacheRead: 40_960, cacheWrite: 777, cacheWrite1h: 77, answer: 555, reasoning: 2222 };
      const rec = usageRecord({ kind, at: new Date(), apiKey: KEY, model: "m", usage });
      const row = normalizeRecord(rec)!;
      expect(buckets(row)).toEqual({
        input: 1234,
        cacheRead: 40_960,
        cacheWrite: 777,
        output: 2777,
        reasoning: 2222,
        unclassified: 0,
      });
      expect(total(buckets(row))).toBe((rec.tokens as { total_tokens: number }).total_tokens);
    },
  );
});

describe("identity and privacy", () => {
  test("the client key is hashed and its plaintext appears nowhere in the row", () => {
    const row = normalizeRecord(
      record({
        // With no upstream credential the proxy reports the client key as the source.
        source: KEY,
        auth_type: "unknown",
        fail: { status_code: 200, body: `echo of Authorization: Bearer ${KEY}` },
        response_headers: { "Set-Cookie": ["session=abc"], "X-Request-Id": ["r1"] },
        tokens: { total_tokens: 1 },
      }),
    )!;
    expect(row.key_hash).toBe(sha256Hex(KEY));
    expect(row.key_hash).toBe(hashApiKey(`  ${KEY}\n`));
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(row.raw.api_key).toBeUndefined();
    expect(row.source).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(row.raw.source).toBe(row.source);
    expect(row.raw.response_headers).toEqual({ "X-Request-Id": ["r1"] });
    // Everything else of the record is still there.
    expect(row.raw.model).toBe("claude-fable-5-2");
    expect(row.raw.session_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("an OAuth account is kept as the source, an upstream API key is not", () => {
    expect(normalizeRecord(record({ tokens: {} }))!.source).toBe("someone@example.com");
    const viaKey = normalizeRecord(record({ tokens: {}, auth_type: "api_key", source: "sk-upstream-secret" }))!;
    expect(viaKey.source).toMatch(/^sha256:/);
    expect(JSON.stringify(viaKey)).not.toContain("sk-upstream-secret");
  });

  test("an upstream key echoed in an error body does not get in through the back door", () => {
    const upstream = "sk-upstream-9f8e7d6c5b4a3210";
    const row = normalizeRecord(
      record({
        tokens: {},
        auth_type: "api_key",
        source: upstream,
        failed: true,
        fail: {
          status_code: 401,
          // The upstream sends the request headers back, as some gateways do.
          body: `{"error":"invalid key","request":{"headers":{"authorization":"Bearer ${upstream}","x-api-key":"${upstream}"}},"hint":"key ${upstream} is disabled"}`,
        },
        response_headers: { "X-Debug-Key": [upstream] },
      }),
    )!;
    expect(row.source).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain(upstream);
    expect(JSON.stringify(row)).not.toContain("9f8e7d6c5b4a3210");
    // The rest of the error is still readable.
    const body = (row.raw.fail as { body: string }).body;
    expect(body).toContain("invalid key");
    expect(body).toContain("is disabled");
    expect(row.status_code).toBe(401);
  });

  test("credentials are recognised by how they are written, even when their value is unknown", () => {
    // An OAuth access token: `source` is the account, so the token itself is not known here.
    const row = normalizeRecord(
      record({
        tokens: {},
        failed: true,
        fail: {
          status_code: 403,
          body: 'forbidden. headers: {"Authorization":"Bearer sk-ant-oat01-AbCdEf0123456789_xyz","X-Api-Key":"AIzaSyA-1234567890abcdefghij"} api_key=zzzzYYYYxxxx1234567890',
        },
      }),
    )!;
    const body = (row.raw.fail as { body: string }).body;
    expect(body).toBe('forbidden. headers: {"Authorization":"Bearer [redacted]","X-Api-Key":"[redacted]"} api_key=[redacted]');
    expect(row.source).toBe("someone@example.com");
    // Ordinary error texts are left alone.
    for (const text of [
      '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
      "the bearer of this message has no authorization: none given",
    ]) {
      expect(redactCredentials(text)).toBe(text);
    }
    // A short source is replaced where it stands but not hunted through the record.
    const short = normalizeRecord(record({ tokens: {}, auth_type: "api_key", source: "abc", fail: { status_code: 200, body: "abcdef" } }))!;
    expect(short.source).toMatch(/^sha256:/);
    expect((short.raw.fail as { body: string }).body).toBe("abcdef");
  });

  test("a request without a key has no hash", () => {
    expect(normalizeRecord(record({ tokens: {}, api_key: "" }))!.key_hash).toBeNull();
  });

  test("event id is the per-attempt execution_id, the trace falls back to the request id", () => {
    const row = normalizeRecord(record({ tokens: {}, trace_id: undefined }))!;
    expect(row.event_id).toBe("5b1c8a52-6a3e-4d0b-9d0e-3d2c1b0a9f8e");
    expect(row.request_id).toBe("0197aaaa-0000-7000-8000-000000000001");
    expect(row.trace_id).toBe("0197aaaa-0000-7000-8000-000000000001");
    // Without an execution id the same payload still gets the same id.
    const a = normalizeRecord(record({ tokens: {}, execution_id: undefined }))!;
    const b = normalizeRecord(record({ tokens: {}, execution_id: undefined }))!;
    expect(a.event_id).toStartWith("h:");
    expect(a.event_id).toBe(b.event_id);
  });

  test("sessions: a parent makes a subagent, unless the link is a fork or a compaction", () => {
    const parent = "22222222-2222-4222-8222-222222222222";
    expect(normalizeRecord(record({ tokens: {} }))!.is_subagent).toBe(false);
    const sub = normalizeRecord(record({ tokens: {}, parent_session_id: parent }))!;
    expect(sub.is_subagent).toBe(true);
    expect(sub.parent_session_id).toBe(parent);
    const fork = normalizeRecord(record({ tokens: {}, parent_session_id: parent, is_fork: true, node_kind: "fork" }))!;
    expect([fork.is_subagent, fork.is_fork, fork.parent_session_id]).toEqual([false, true, parent]);
    const compaction = normalizeRecord(record({ tokens: {}, parent_session_id: parent, node_kind: "compaction" }))!;
    expect([compaction.is_subagent, compaction.is_compaction]).toEqual([false, true]);
    // A session cannot be its own parent.
    const self = normalizeRecord(record({ tokens: {}, parent_session_id: "11111111-1111-4111-8111-111111111111" }))!;
    expect([self.is_subagent, self.parent_session_id]).toEqual([false, null]);
  });

  test("the requested model drops the thinking suffix, the alias keeps it", () => {
    const row = normalizeRecord(record({ tokens: {}, model: "gpt-5.3-codex", alias: "gpt-5.3-codex(high)" }))!;
    expect([row.model, row.alias, row.requested_model]).toEqual(["gpt-5.3-codex", "gpt-5.3-codex(high)", "gpt-5.3-codex"]);
    expect(stripThinkingSuffix("claude-sonnet-4-5(16384)")).toBe("claude-sonnet-4-5");
    expect(stripThinkingSuffix("(odd)")).toBe("(odd)");
  });

  test("failures carry their status, successes are 200", () => {
    const failed = normalizeRecord(record({ tokens: {}, failed: true, fail: { status_code: 429, body: "slow down", code: "rate_limit" } }))!;
    expect([failed.failed, failed.status_code, failed.fail_code]).toEqual([true, 429, "rate_limit"]);
    expect(normalizeRecord(record({ tokens: {} }))!.status_code).toBe(200);
  });

  test("timestamps keep their precision and garbage becomes now", () => {
    expect(normalizeRecord(record({ tokens: {} }))!.ts).toBe("2026-11-19T10:11:12.123456789Z");
    const before = Date.now();
    const row = normalizeRecord(record({ tokens: {}, timestamp: "not a time" }))!;
    expect(Date.parse(row.ts)).toBeGreaterThanOrEqual(before);
  });

  test("things that are not usage records are ignored", () => {
    expect(normalizeRecord(null)).toBeNull();
    expect(normalizeRecord("not json")).toBeNull();
    expect(normalizeRecord([1, 2])).toBeNull();
    expect(normalizeRecord({ refresh: true })).toBeNull();
    expect(normalizeRecord({ support_refresh: true })).toBeNull();
    expect(normalizeRecord({ hello: "world" })).toBeNull();
    // The queue hands back a JSON string when a payload was not valid JSON to it.
    expect(normalizeRecord(JSON.stringify(record({ tokens: {} })))!.model).toBe("claude-fable-5-2");
  });

  test("NUL bytes cannot reach Postgres", () => {
    const row = normalizeRecord(record({ tokens: {}, user_agent: "bad\u0000agent", fail: { status_code: 200, body: "a\u0000b" } }))!;
    expect(row.user_agent).toBe("badagent");
    expect(JSON.stringify(row)).not.toContain("\\u0000");
  });
});
