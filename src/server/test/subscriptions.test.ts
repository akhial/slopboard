import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Board } from "../../shared/api.ts";
import { buildBoard, resetBoardCaches } from "../board.ts";
import { extractQuotaHeader, hashApiKey, insertEvents, normalizeRecord } from "../ingest.ts";
import { refreshPrices } from "../prices.ts";
import { ProxyClient } from "../proxy.ts";
import {
  analyzeBillingCycles,
  attributeAccountEvents,
  billingCycleFor,
  fitModelWeights,
  isPlanTierChange,
  recomputeSubscriptionCosts,
  syncQuotaHistory,
  upsertSubscription,
  type AttrEvent,
  type QuotaChunk,
  type QuotaPoint,
} from "../subscriptions.ts";
import { usageRecord } from "../synthetic.ts";
import { assertBoard } from "./contract.ts";
import { FakeProxy } from "./fake-proxy.ts";
import { createTestDb, SETUP_TIMEOUT, type TestDb } from "./pg.ts";

setDefaultTimeout(30_000);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const CLI = join(import.meta.dir, "..", "cli.ts");

describe("billing cycles and reset detection", () => {
  test("computes exact UTC billing cycle lengths across 28, 29, 30 and 31 day months", () => {
    // 26th of month: Oct 26 -> Nov 26 is 31 days; Nov 26 -> Dec 26 is 30 days.
    const oct26 = billingCycleFor(Date.UTC(2026, 10, 23, 12, 0), 26);
    expect(oct26.key).toBe("2026-10-26");
    expect(oct26.days).toBe(31);
    expect(oct26.scheduledWeeks).toBeCloseTo(31 / 7, 10);

    const nov26 = billingCycleFor(Date.UTC(2026, 10, 26, 0, 0), 26);
    expect(nov26.key).toBe("2026-11-26");
    expect(nov26.days).toBe(30);
    expect(nov26.scheduledWeeks).toBeCloseTo(30 / 7, 10);

    // Day 31 clamps cleanly in short months (Feb non-leap vs leap).
    const feb2026 = billingCycleFor(Date.UTC(2026, 1, 15), 31);
    expect(feb2026.key).toBe("2026-01-31");
    expect(feb2026.days).toBe(28);
    expect(feb2026.scheduledWeeks).toBe(4);

    const feb2028 = billingCycleFor(Date.UTC(2028, 1, 15), 31);
    expect(feb2028.key).toBe("2028-01-31");
    expect(feb2028.days).toBe(29);
  });

  test("counts Claude mid-window full resets and Fable givebacks, while ignoring noise and tier upgrades", () => {
    const reset1 = Date.UTC(2026, 10, 26, 12, 0);
    const reset2 = Date.UTC(2026, 11, 3, 12, 0);
    const points: QuotaPoint[] = [
      // Normal burn + 1% source noise (48 -> 47 must not count as a reset)
      { tsMs: Date.UTC(2026, 10, 20, 0, 0), usedPct: 0, resetAtMs: reset1, plan: "max20" },
      { tsMs: Date.UTC(2026, 10, 20, 12, 0), usedPct: 48, resetAtMs: reset1, plan: "max20" },
      { tsMs: Date.UTC(2026, 10, 20, 12, 5), usedPct: 47, resetAtMs: reset1, plan: "max20" },
      { tsMs: Date.UTC(2026, 10, 21, 0, 0), usedPct: 100, resetAtMs: reset1, plan: "max20" },
      // Mid-window Fable giveback: 100% -> 51% (+0.49 wk)
      { tsMs: Date.UTC(2026, 10, 21, 1, 0), usedPct: 51, resetAtMs: reset1, plan: "max20" },
      { tsMs: Date.UTC(2026, 10, 22, 0, 0), usedPct: 100, resetAtMs: reset1, plan: "max20" },
      // Mid-window full reset: 100% -> 0% (+1.00 wk)
      { tsMs: Date.UTC(2026, 10, 22, 6, 0), usedPct: 0, resetAtMs: reset1, plan: "max20" },
      { tsMs: Date.UTC(2026, 10, 24, 12, 0), usedPct: 100, resetAtMs: reset1, plan: "max20" },
      // Normal scheduled reset (reset_at advances +7d -> 0 bonus)
      { tsMs: Date.UTC(2026, 10, 26, 12, 5), usedPct: 0, resetAtMs: reset2, plan: "max20" },
    ];

    const cycles = analyzeBillingCycles(points, {
      provider: "claude",
      billingDay: 18,
      explicitMonthlyCost: 200,
      explicitPlan: "max20",
      ignored: false,
    });
    const c = cycles.get("2026-11-18")!;
    expect(c.cycle.days).toBe(30);
    expect(c.resets).toHaveLength(2);
    expect(c.bonusWeeks).toBeCloseTo(1.49, 6);
    expect(c.effectiveWeeks).toBeCloseTo(30 / 7 + 1.49, 6);
    expect(c.costPerWeek).toBeCloseTo(200 / (30 / 7 + 1.49), 6);

    // Tier upgrade (pro -> max5 -> max20) must not count utilization drops as free bonus resets.
    expect(isPlanTierChange("pro", "max5")).toBe(true);
    expect(isPlanTierChange("max", "max20")).toBe(false);
    const upgraded = analyzeBillingCycles(
      [
        { tsMs: Date.UTC(2026, 10, 12, 0, 0), usedPct: 54, resetAtMs: reset1, plan: "pro" },
        { tsMs: Date.UTC(2026, 10, 13, 0, 0), usedPct: 0, resetAtMs: reset1, plan: "max5" },
        { tsMs: Date.UTC(2026, 10, 14, 0, 0), usedPct: 99, resetAtMs: reset1, plan: "max5" },
        { tsMs: Date.UTC(2026, 10, 14, 23, 0), usedPct: 0, resetAtMs: reset1, plan: "max20" },
      ],
      { provider: "claude", billingDay: 15, explicitMonthlyCost: 200, explicitPlan: null, ignored: false },
    );
    expect(upgraded.get("2026-10-15")!.bonusWeeks).toBe(0);
  });

  test("counts Codex early resets before the 7-day deadline while ignoring idle reset_at drifts", () => {
    const t0 = Date.UTC(2026, 10, 11, 8, 44);
    const scheduledReset = t0 + 7 * DAY;
    // Reset happens 4.55 days early after reaching 100%
    const earlyAt = scheduledReset - 4.55 * DAY;
    const points: QuotaPoint[] = [
      // Idle drift at 0% (must give 0 bonus)
      { tsMs: t0 - 20 * 60_000, usedPct: 0, resetAtMs: scheduledReset - 20 * 60_000, plan: "pro" },
      { tsMs: t0, usedPct: 0, resetAtMs: scheduledReset, plan: "pro" },
      { tsMs: earlyAt - 60_000, usedPct: 100, resetAtMs: scheduledReset, plan: "pro" },
      { tsMs: earlyAt, usedPct: 0, resetAtMs: earlyAt + 7 * DAY, plan: "pro" },
    ];

    const cycles = analyzeBillingCycles(points, {
      provider: "codex",
      billingDay: 1,
      explicitMonthlyCost: 200,
      explicitPlan: "pro",
      ignored: false,
    });
    const c = cycles.get("2026-11-01")!;
    expect(c.resets).toHaveLength(1);
    expect(c.resets[0]!.kind).toBe("early");
    expect(c.bonusWeeks).toBeCloseTo(4.55 / 7, 3);
    expect(c.costPerWeek).toBeCloseTo(200 / (30 / 7 + 4.55 / 7), 4);
  });
});

describe("empirical model weighting and tick attribution", () => {
  test("learns Fable vs Opus quota burn ratio automatically from 5% chunks", () => {
    // Ground truth: Opus = 1/3000 wk/$, Fable = 2.5/3000 wk/$ (2.5x heavier per API dollar).
    const chunks: QuotaChunk[] = [];
    for (let i = 0; i < 20; i++) {
      const opusUsd = 20 + (i % 5) * 25;
      const fableUsd = Math.max(0, (0.05 - opusUsd / 3000) * (3000 / 2.5));
      chunks.push({
        dqWeeks: 0.05,
        byModelApiUsd: new Map([
          ["claude-opus-5-5", opusUsd],
          ["claude-fable-5-2", fableUsd],
          ["claude-haiku-5-5", 0.05], // rare model (< 5%): stays at 1.0
        ]),
      });
    }
    const weights = fitModelWeights(chunks);
    const opusM = weights.multipliers.get("claude-opus-5-5")!;
    const fableM = weights.multipliers.get("claude-fable-5-2")!;
    expect(fableM / opusM).toBeGreaterThan(2.2);
    expect(fableM / opusM).toBeLessThan(2.7);
    expect(weights.multipliers.has("claude-haiku-5-5")).toBe(false);
  });

  test("conserves exact quota across ticks and ignores out-of-order jitter and stale post-reset headers", () => {
    const t0 = Date.UTC(2026, 10, 20, 10, 0);
    const reset1 = t0 + 5 * DAY;
    const reset2 = reset1 + 7 * DAY;

    const events: AttrEvent[] = [
      // Tick 1: 0% -> 1% across e1 ($10) and e2 ($30) -> 0.0025 and 0.0075 wk
      { eventId: "e1", tsMs: t0, model: "opus", apiCostUsd: 10, totalTokens: 1000, failed: false, quotaUsedPct: 0, quotaResetAtMs: reset1 },
      { eventId: "e2", tsMs: t0 + 1000, model: "opus", apiCostUsd: 30, totalTokens: 3000, failed: false, quotaUsedPct: 1, quotaResetAtMs: reset1 },
      // Concurrent jitter: 1% -> 0% -> 1% must NOT double-count!
      { eventId: "e3", tsMs: t0 + 2000, model: "opus", apiCostUsd: 20, totalTokens: 2000, failed: false, quotaUsedPct: 0, quotaResetAtMs: reset1 },
      { eventId: "e4", tsMs: t0 + 3000, model: "opus", apiCostUsd: 20, totalTokens: 2000, failed: false, quotaUsedPct: 1, quotaResetAtMs: reset1 },
      // Tick 2: 1% -> 2% closes e3 + e4 + e5 ($20 + $20 + $40 = $80)
      { eventId: "e5", tsMs: t0 + 4000, model: "opus", apiCostUsd: 40, totalTokens: 4000, failed: false, quotaUsedPct: 2, quotaResetAtMs: reset1 },
      // Scheduled reset to 0% with reset2, followed 1s later by a stale in-flight response from reset1 at 100%!
      { eventId: "e6", tsMs: t0 + 10_000, model: "opus", apiCostUsd: 25, totalTokens: 2500, failed: false, quotaUsedPct: 0, quotaResetAtMs: reset2 },
      { eventId: "e7-stale", tsMs: t0 + 11_000, model: "opus", apiCostUsd: 25, totalTokens: 2500, failed: false, quotaUsedPct: 100, quotaResetAtMs: reset1 },
      { eventId: "e8", tsMs: t0 + 12_000, model: "opus", apiCostUsd: 50, totalTokens: 5000, failed: false, quotaUsedPct: 1, quotaResetAtMs: reset2 },
    ];

    const res = attributeAccountEvents(events, [], {
      weights: { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() },
      costPerWeekAt: () => 50, // $50 / week
      ignored: false,
    });

    // Tick 1 exact split: 0.01 wk total = $0.50
    expect(res.get("e1")!.quotaWeeks).toBeCloseTo(0.0025, 10);
    expect(res.get("e2")!.quotaWeeks).toBeCloseTo(0.0075, 10);
    expect(res.get("e1")!.subCostUsd! + res.get("e2")!.subCostUsd!).toBeCloseTo(0.5, 10);

    // Tick 2 exact split: 0.01 wk total (NO double counting from 1->0->1 jitter!)
    const tick2Sum = res.get("e3")!.quotaWeeks! + res.get("e4")!.quotaWeeks! + res.get("e5")!.quotaWeeks!;
    expect(tick2Sum).toBeCloseTo(0.01, 10);
    expect(res.get("e5")!.quotaWeeks).toBeCloseTo(0.005, 10);

    // Post-reset tick: stale 100% header did NOT create a phantom 100% jump! Total is exactly 0.01 wk!
    const postResetSum = res.get("e6")!.quotaWeeks! + res.get("e7-stale")!.quotaWeeks! + res.get("e8")!.quotaWeeks!;
    expect(postResetSum).toBeCloseTo(0.01, 10);
    // Total attributed across all 8 events = 0.03 wk = $1.50
    const totalUsd = [...res.values()].reduce((s, r) => s + (r.subCostUsd ?? 0), 0);
    expect(totalUsd).toBeCloseTo(1.5, 10);
  });

  test("falls back to quota_samples when events carry no response headers", () => {
    const t0 = Date.UTC(2026, 10, 20, 10, 0);
    const reset = t0 + 7 * DAY;
    const events: AttrEvent[] = [
      { eventId: "a", tsMs: t0 + 1000, model: "opus", apiCostUsd: 10, totalTokens: 1000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
      { eventId: "b", tsMs: t0 + 2000, model: "opus", apiCostUsd: 30, totalTokens: 3000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
    ];
    const samples: QuotaPoint[] = [
      { tsMs: t0, usedPct: 10, resetAtMs: reset },
      { tsMs: t0 + 5000, usedPct: 60, resetAtMs: reset }, // +50% of a weekly quota!
    ];
    const res = attributeAccountEvents(events, samples, {
      weights: { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() },
      costPerWeekAt: () => 50,
      ignored: false,
    });
    // 50% of a $50 week = $25 total, split 1:3 -> $6.25 and $18.75!
    expect(res.get("a")!.quotaWeeks).toBeCloseTo(0.125, 10);
    expect(res.get("a")!.subCostUsd).toBeCloseTo(6.25, 10);
    expect(res.get("b")!.quotaWeeks).toBeCloseTo(0.375, 10);
    expect(res.get("b")!.subCostUsd).toBeCloseTo(18.75, 10);
  });

  test("attributes initial nonzero burn after a scheduled reset for both header and poll-only streams", () => {
    const t0 = Date.UTC(2026, 10, 20, 10, 0);
    const reset1 = t0 + 10_000;
    const reset2 = reset1 + 7 * DAY;

    // 1) Header stream: first new-window event already reports 10%, next reports 20% -> full 20% attributed.
    const headerEvents: AttrEvent[] = [
      { eventId: "old", tsMs: t0, model: "opus", apiCostUsd: 10, totalTokens: 1000, failed: false, quotaUsedPct: 80, quotaResetAtMs: reset1 },
      { eventId: "new1", tsMs: reset1 + 1000, model: "opus", apiCostUsd: 10, totalTokens: 1000, failed: false, quotaUsedPct: 10, quotaResetAtMs: reset2 },
      { eventId: "new2", tsMs: reset1 + 2000, model: "opus", apiCostUsd: 10, totalTokens: 1000, failed: false, quotaUsedPct: 20, quotaResetAtMs: reset2 },
    ];
    const headerRes = attributeAccountEvents(headerEvents, [], {
      weights: { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() },
      costPerWeekAt: () => 50,
      ignored: false,
    });
    expect(headerRes.get("new1")!.quotaWeeks).toBeCloseTo(0.1, 10);
    expect(headerRes.get("new2")!.quotaWeeks).toBeCloseTo(0.1, 10);

    // 2) Poll-only stream (e.g. Antigravity): headerless event arrives after reset1 before next poll at 12%.
    const pollEvents: AttrEvent[] = [
      { eventId: "pre", tsMs: reset1 - 5000, model: "gemini-4-neon", apiCostUsd: null, totalTokens: 1000, effectiveTokens: 1000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
      { eventId: "post1", tsMs: reset1 + 1000, model: "gemini-4-neon", apiCostUsd: null, totalTokens: 1000, effectiveTokens: 1000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
      { eventId: "post2", tsMs: reset1 + 2000, model: "gemini-4-neon", apiCostUsd: null, totalTokens: 3000, effectiveTokens: 3000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
    ];
    const pollSamples: QuotaPoint[] = [
      { tsMs: t0, usedPct: 90, resetAtMs: reset1 },
      { tsMs: reset1 + 5000, usedPct: 12, resetAtMs: reset2 },
    ];
    const pollRes = attributeAccountEvents(pollEvents, pollSamples, {
      weights: { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() },
      costPerWeekAt: () => 50,
      ignored: false,
    });
    expect(pollRes.get("post1")!.quotaWeeks).toBeCloseTo(0.03, 10);
    expect(pollRes.get("post2")!.quotaWeeks).toBeCloseTo(0.09, 10);
  });

  test("distributes mixed priced/unpriced batches by effectiveTokens instead of zeroing unpriced models", () => {
    const t0 = Date.UTC(2026, 10, 20, 10, 0);
    const reset = t0 + 7 * DAY;
    const events: AttrEvent[] = [
      // Unpriced model (e.g. gemini-4-neon-high) with 3x the effective tokens
      { eventId: "unpriced", tsMs: t0 + 1000, model: "gemini-4-neon-high", apiCostUsd: null, totalTokens: 3000, effectiveTokens: 3000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
      // Priced model (e.g. gemini-3.1-flash-lite) in the same poll interval
      { eventId: "priced", tsMs: t0 + 2000, model: "gemini-3.1-flash-lite", apiCostUsd: 0.05, totalTokens: 1000, effectiveTokens: 1000, failed: false, quotaUsedPct: null, quotaResetAtMs: null },
    ];
    const samples: QuotaPoint[] = [
      { tsMs: t0, usedPct: 10, resetAtMs: reset },
      { tsMs: t0 + 5000, usedPct: 30, resetAtMs: reset }, // +20% weekly quota
    ];
    const res = attributeAccountEvents(events, samples, {
      weights: { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() },
      costPerWeekAt: () => 50,
      ignored: false,
    });
    expect(res.get("unpriced")!.quotaWeeks).toBeCloseTo(0.15, 10);
    expect(res.get("priced")!.quotaWeeks).toBeCloseTo(0.05, 10);
    expect(res.get("unpriced")!.subCostUsd).toBeCloseTo(7.5, 10);
    expect(res.get("priced")!.subCostUsd).toBeCloseTo(2.5, 10);
  });
});

describe("quota header extraction", () => {
  test("extracts Claude 7d and Codex weekly headers and ignores Codex imagegen/daily limits", () => {
    const claude = extractQuotaHeader("claude", {
      "Anthropic-Ratelimit-Unified-7d-Utilization": ["0.42"],
      "Anthropic-Ratelimit-Unified-7d-Reset": ["1796299200"],
    });
    expect(claude.usedPct).toBe(42);
    expect(claude.resetAt).toBe(new Date(1796299200 * 1000).toISOString());

    const codex = extractQuotaHeader("codex", {
      "X-Codex-Primary-Used-Percent": ["36"],
      "X-Codex-Primary-Window-Minutes": ["10080"],
      "X-Codex-Primary-Reset-At": ["1796022875"],
      "X-Codex-Active-Limit": ["premium"],
    });
    expect(codex.usedPct).toBe(36);
    expect(codex.resetAt).toBe(new Date(1796022875 * 1000).toISOString());

    const imagegen = extractQuotaHeader("codex", {
      "X-Codex-Primary-Used-Percent": ["50"],
      "X-Codex-Primary-Window-Minutes": ["10080"],
      "X-Codex-Active-Limit": ["imagegen_daily"],
    });
    expect(imagegen).toEqual({ usedPct: null, resetAt: null });

    const nonWeekly = extractQuotaHeader("codex", {
      "X-Codex-Primary-Used-Percent": ["12"],
      "X-Codex-Primary-Window-Minutes": ["1440"],
    });
    expect(nonWeekly).toEqual({ usedPct: null, resetAt: null });
  });
});

describe("end-to-end subscription sync, board and CLI", () => {
  let db: TestDb;
  let proxy: FakeProxy;
  let prices: ReturnType<typeof Bun.serve>;

  const KEY_ADA = "sk-sub-ada";
  const KEY_BOB = "sk-sub-bob";

  beforeAll(async () => {
    db = await createTestDb("subscriptions");
    proxy = new FakeProxy("sub-mgmt-key");
    prices = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(Bun.file(`${import.meta.dir}/fixtures/prices.json`)),
    });
    await refreshPrices(db.sql, prices.url.href);
    await db.sql`insert into people (id, name) values ('ada', 'Ada'), ('bob', 'Bob')`;
    await db.sql`insert into api_keys (key_hash, person_id) values (${hashApiKey(KEY_ADA)}, 'ada'), (${hashApiKey(KEY_BOB)}, 'bob')`;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await prices.stop(true);
    await proxy.stop();
    await db.close();
  });

  async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: db.url,
        PROXY_URL: proxy.url,
        PROXY_MANAGEMENT_KEY: proxy.managementKey,
      },
      cwd: import.meta.dir + "/fixtures",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("syncs quota history, computes exact real spend across Claude & Codex, leaves Antigravity unpriced, and serves subscription board", async () => {
    const now = Date.now();
    // Anchor inside the current UTC month, 2 hours ago, so all events fall inside "today" and one billing cycle.
    const t0 = now - 2 * HOUR;
    const claudeReset = t0 + 5 * DAY;
    const codexReset = t0 + 4 * DAY;

    // Proxy quota history:
    // - Claude Max20x account had a mid-window full reset (100% -> 0%) earlier in the same billing cycle!
    // - Claude Pro $20 account (will be ignored via CLI)
    // - Codex Pro $200 account (no bonus resets)
    const earlierInCycle = t0 - 10 * 60_000;
    proxy.quotaHistory = {
      enabled: true,
      now,
      poll_interval_seconds: 600,
      accounts: [
        {
          auth_id: "claude-ultra",
          auth_index: "idx1",
          file_name: "claude-ultra.json",
          provider: "claude",
          label: "ultra@example.com",
          email: "ultra@example.com",
          plan: "max20",
          plans: [[earlierInCycle - 2 * 60_000, "max20"]],
          windows: [
            {
              id: "seven_day",
              period_seconds: 604800,
              points: [
                [earlierInCycle - 2 * 60_000, 100, claudeReset],
                [earlierInCycle, 0, claudeReset], // +1.00 bonus week!
              ],
            },
          ],
        },
        {
          auth_id: "claude-pro",
          auth_index: "idx2",
          file_name: "claude-pro.json",
          provider: "claude",
          label: "pro@example.com",
          email: "pro@example.com",
          plan: "pro",
          windows: [
            {
              id: "seven_day",
              period_seconds: 604800,
              points: [[earlierInCycle, 0, claudeReset]],
            },
          ],
        },
        {
          auth_id: "codex-pro",
          auth_index: "idx3",
          file_name: "codex-pro.json",
          provider: "codex",
          label: "codex@example.com",
          email: "codex@example.com",
          plan: "pro",
          windows: [
            {
              id: "seven_day",
              period_seconds: 604800,
              points: [[earlierInCycle, 0, codexReset]],
            },
          ],
        },
      ],
    };

    const usage = { input: 100_000, cacheRead: 0, cacheWrite: 0, answer: 10_000, reasoning: 0 };
    const claudeHeaders = (frac: number) => ({
      "Anthropic-Ratelimit-Unified-7d-Utilization": [String(frac)],
      "Anthropic-Ratelimit-Unified-7d-Reset": [String(Math.floor(claudeReset / 1000))],
    });
    const codexHeaders = (pct: number) => ({
      "X-Codex-Primary-Used-Percent": [String(pct)],
      "X-Codex-Primary-Window-Minutes": ["10080"],
      "X-Codex-Primary-Reset-At": [String(Math.floor(codexReset / 1000))],
      "X-Codex-Active-Limit": ["premium"],
    });

    await insertEvents(db.sql, [
      // Ada burns 50% of the Claude Max20x weekly quota (0.00 -> 0.50)
      normalizeRecord(usageRecord({ kind: "claude", at: new Date(t0), apiKey: KEY_ADA, model: "priced-model", source: "ultra@example.com", usage, responseHeaders: claudeHeaders(0.0) }))!,
      normalizeRecord(usageRecord({ kind: "claude", at: new Date(t0 + 1000), apiKey: KEY_ADA, model: "priced-model", source: "ultra@example.com", usage, responseHeaders: claudeHeaders(0.5) }))!,
      // Bob burns 50% of the Claude Pro ($20) quota (will be ignored -> $0)
      normalizeRecord(usageRecord({ kind: "claude", at: new Date(t0 + 2000), apiKey: KEY_BOB, model: "priced-model", source: "pro@example.com", usage, responseHeaders: claudeHeaders(0.0) }))!,
      normalizeRecord(usageRecord({ kind: "claude", at: new Date(t0 + 3000), apiKey: KEY_BOB, model: "priced-model", source: "pro@example.com", usage, responseHeaders: claudeHeaders(0.5) }))!,
      // Bob burns 25% of the Codex Pro ($200) quota
      normalizeRecord(usageRecord({ kind: "codex", at: new Date(t0 + 4000), apiKey: KEY_BOB, model: "priced-model", source: "codex@example.com", usage, responseHeaders: codexHeaders(0) }))!,
      normalizeRecord(usageRecord({ kind: "codex", at: new Date(t0 + 5000), apiKey: KEY_BOB, model: "priced-model", source: "codex@example.com", usage, responseHeaders: codexHeaders(25) }))!,
      // Ada also sends an Antigravity request (no subscription pricing -> unpriced)
      normalizeRecord({
        ...usageRecord({ kind: "gemini", at: new Date(t0 + 6000), apiKey: KEY_ADA, model: "gemini-4-neon", source: "ag@example.com", usage }),
        provider: "antigravity",
      })!,
    ]);

    // Sync via ProxyClient & verify auto-discovered plan pricing works immediately.
    const client = new ProxyClient(proxy.url, proxy.managementKey);
    const syncRes = await syncQuotaHistory(db.sql, client);
    expect(syncRes.enabled).toBe(true);
    expect(syncRes.accounts).toBe(3);

    // Configure exact billing day for Claude Max20x via CLI and ignore the $20 Pro account via CLI.
    const billingDay = new Date(t0).getUTCDate();
    const setRes = await cli(["subscriptions", "set", "claude", "ultra@example.com", "--cost", "200", "--billing-day", String(billingDay)]);
    expect(setRes.code).toBe(0);
    expect(setRes.stdout).toContain("ultra@example.com");

    const ignoreRes = await cli(["subscriptions", "ignore", "claude", "pro@example.com"]);
    expect(ignoreRes.code).toBe(0);
    expect(ignoreRes.stdout).toContain("Ignored claude pro@example.com");

    // Verify expected exact dollar math:
    // - Claude ultra: cycle starting on `billingDay` has `ultraCycle.days / 7 + 1.0` effective weeks (from the +1.00 bonus reset!).
    //   Ada burned 0.50 weeks -> `0.50 * 200 / (days/7 + 1)`.
    // - Claude pro: ignored -> $0.00.
    // - Codex pro: auto-discovered $200/mo, default billing day 1 -> `0.25 * 200 / (calDays/7)`.
    // - Antigravity: unpriced (null).
    const ultraCycle = billingCycleFor(t0, billingDay);
    const expectedAdaUsd = 0.5 * (200 / (ultraCycle.scheduledWeeks + 1));
    const codexCycle = billingCycleFor(t0, 1);
    const expectedBobUsd = 0.25 * (200 / codexCycle.scheduledWeeks);

    resetBoardCaches(db.sql);
    const board: Board = JSON.parse(JSON.stringify(await buildBoard(db.sql, "UTC", "today", 2)));
    assertBoard(board);
    expect(board.costMode).toBe("subscription");

    const ada = board.people.find((p) => p.id === "ada")!;
    const bob = board.people.find((p) => p.id === "bob")!;
    expect(ada.costUsd).toBeCloseTo(expectedAdaUsd, 6);
    expect(bob.costUsd).toBeCloseTo(expectedBobUsd, 6);
    expect(board.totals.costUsd).toBeCloseTo(expectedAdaUsd + expectedBobUsd, 6);
    // List costs are still populated alongside real subscription spend.
    expect(ada.listCostUsd).toBeGreaterThan(0);
    expect(bob.listCostUsd).toBeGreaterThan(0);

    // Antigravity model is marked unpriced under subscription mode.
    const agModel = board.models.find((m) => m.model === "gemini-4-neon")!;
    expect(agModel.priced).toBe(false);
    expect(agModel.costUsd).toBeNull();

    // Award uses real subscription spend wording.
    const spendAward = board.awards.find((a) => a.id === "series-a-burn-rate")!;
    expect(spendAward.winnerId).toBe("ada");
    expect(spendAward.value).toContain("real spend");

    // CLI subscriptions list prints every account and its status.
    const listRes = await cli(["subscriptions", "list"]);
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toContain("ultra@example.com");
    expect(listRes.stdout).toContain("pro@example.com");
    expect(listRes.stdout).toContain("ignored");
    expect(listRes.stdout).toContain("codex@example.com");

    // Verify upsertSubscription + deleteSubscription + recompute via CLI.
    await upsertSubscription(db.sql, { provider: "codex", source: "codex@example.com", monthlyCostUsd: 200, billingDay: 15 });
    const delRes = await cli(["subscriptions", "delete", "codex", "codex@example.com"]);
    expect(delRes.code).toBe(0);
    const recomputeRes = await recomputeSubscriptionCosts(db.sql);
    expect(recomputeRes.accounts).toBeGreaterThanOrEqual(3);
  });

  test("ignore-before-sync restores auto plan default on unignore, preserves ms ordering, and meters Antigravity via quota_samples", async () => {
    const now = Date.now();
    // Anchor on a clean whole second 1 hour ago so sub-second offsets stay inside one second.
    const baseSec = Math.floor((now - HOUR) / 1000) * 1000;
    const reset = baseSec + 6 * DAY;

    // 1) Ignore a brand-new Claude account BEFORE any quota_samples exist, then sync, then unignore.
    const preIgnore = await cli(["subscriptions", "ignore", "claude", "late@example.com"]);
    expect(preIgnore.code).toBe(0);

    proxy.quotaHistory = {
      enabled: true,
      now,
      poll_interval_seconds: 600,
      accounts: [
        {
          auth_id: "claude-late",
          auth_index: "idx10",
          file_name: "claude-late.json",
          provider: "claude",
          label: "late@example.com",
          email: "late@example.com",
          plan: "max20",
          windows: [
            { id: "seven_day", period_seconds: 604800, points: [[baseSec - 60_000, 0, reset]] },
          ],
        },
        {
          auth_id: "ag-ultra",
          auth_index: "idx11",
          file_name: "antigravity-ag.json",
          provider: "antigravity",
          label: "ag-metered@example.com",
          email: "ag-metered@example.com",
          plan: "ultra",
          windows: [
            {
              id: "seven_day",
              period_seconds: 604800,
              points: [
                [baseSec, 10, reset],
                [baseSec + 10_000, 30, reset], // +20% of weekly quota
              ],
            },
          ],
        },
      ],
    };

    const usage = { input: 100_000, cacheRead: 0, cacheWrite: 0, answer: 10_000, reasoning: 0 };
    const hdr = (frac: number) => ({
      "Anthropic-Ratelimit-Unified-7d-Utilization": [String(frac)],
      "Anthropic-Ratelimit-Unified-7d-Reset": [String(Math.floor(reset / 1000))],
    });

    await insertEvents(db.sql, [
      // Sub-second ordering: "z-first" at .100 (10%) must sort before "a-second" at .900 (30%).
      // If timestamps were truncated to whole seconds, lexical tie-break would invert them!
      {
        ...normalizeRecord(usageRecord({ kind: "claude", at: new Date(baseSec + 100), apiKey: KEY_ADA, model: "priced-model", source: "late@example.com", usage, responseHeaders: hdr(0.1) }))!,
        event_id: "z-first",
      },
      {
        ...normalizeRecord(usageRecord({ kind: "claude", at: new Date(baseSec + 900), apiKey: KEY_BOB, model: "priced-model", source: "late@example.com", usage, responseHeaders: hdr(0.3) }))!,
        event_id: "a-second",
      },
      // Antigravity poll-only events: unpriced gemini-4-neon + priced model in the same 20% interval
      normalizeRecord({
        ...usageRecord({ kind: "gemini", at: new Date(baseSec + 2000), apiKey: KEY_ADA, model: "gemini-4-neon-high", source: "ag-metered@example.com", usage }),
        provider: "antigravity",
      })!,
      normalizeRecord({
        ...usageRecord({ kind: "gemini", at: new Date(baseSec + 3000), apiKey: KEY_BOB, model: "priced-model", source: "ag-metered@example.com", usage }),
        provider: "antigravity",
      })!,
    ]);

    const client = new ProxyClient(proxy.url, proxy.managementKey);
    await syncQuotaHistory(db.sql, client);

    // While ignored, late@example.com events cost $0.
    const ignoredRows = await db.sql<{ sub_cost_usd: string | null }[]>`
      select sub_cost_usd from events where provider = 'claude' and source = 'late@example.com'`;
    expect(ignoredRows.every((r) => Number(r.sub_cost_usd) === 0)).toBe(true);

    // Unignoring restores auto-discovered max20 ($200/mo) instead of pinning $0!
    const unignore = await cli(["subscriptions", "unignore", "claude", "late@example.com"]);
    expect(unignore.code).toBe(0);
    expect(unignore.stdout).toContain("auto plan default");

    const cycle = billingCycleFor(baseSec, 1);
    const lateRows = await db.sql<{ event_id: string; quota_weeks: string | null; sub_cost_usd: string | null }[]>`
      select event_id, quota_weeks, sub_cost_usd from events
      where provider = 'claude' and source = 'late@example.com'
      order by ts asc`;
    // Both events inside the same second were ordered properly: z-first (.100) got 10%, a-second (.900) got 20%!
    expect(lateRows[0]!.event_id).toBe("z-first");
    expect(lateRows[1]!.event_id).toBe("a-second");
    expect(Number(lateRows[0]!.quota_weeks)).toBeCloseTo(0.1, 10);
    expect(Number(lateRows[1]!.quota_weeks)).toBeCloseTo(0.2, 10);
    expect(Number(lateRows[0]!.sub_cost_usd)).toBeCloseTo(0.1 * (200 / cycle.scheduledWeeks), 5);
    expect(Number(lateRows[1]!.sub_cost_usd)).toBeCloseTo(0.2 * (200 / cycle.scheduledWeeks), 5);

    // Antigravity ultra ($250/mo auto-discovered) split +20% equally across the two equal-token events (10% each)!
    const agRows = await db.sql<{ model: string; quota_weeks: string | null; sub_cost_usd: string | null }[]>`
      select model, quota_weeks, sub_cost_usd from events
      where provider = 'antigravity' and source = 'ag-metered@example.com'
      order by ts asc`;
    expect(agRows).toHaveLength(2);
    expect(Number(agRows[0]!.quota_weeks)).toBeCloseTo(0.1, 6);
    expect(Number(agRows[1]!.quota_weeks)).toBeCloseTo(0.1, 6);
    expect(Number(agRows[0]!.sub_cost_usd)).toBeCloseTo(0.1 * (250 / cycle.scheduledWeeks), 5);
    expect(Number(agRows[1]!.sub_cost_usd)).toBeCloseTo(0.1 * (250 / cycle.scheduledWeeks), 5);
  });
});
