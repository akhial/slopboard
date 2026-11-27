import { describe, expect, test } from "bun:test";
import { buildPoolStatuses } from "../pools.ts";
import { analyzeBillingCycles, attributeAccountEvents, filterGlitchSamples, type QuotaPoint } from "../subscriptions.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("filterGlitchSamples", () => {
  test("strips a transient wrong-pool Antigravity 0%-used / now+7d spike", () => {
    const resetReal = Date.parse("2026-12-03T07:58:07.000Z");
    const resetBogus = Date.parse("2026-12-04T10:10:17.000Z");
    const pts: QuotaPoint[] = [
      { tsMs: Date.parse("2026-11-27T09:49:11.000Z"), usedPct: 35.79, resetAtMs: resetReal },
      { tsMs: Date.parse("2026-11-27T09:58:13.000Z"), usedPct: 35.98, resetAtMs: resetReal },
      { tsMs: Date.parse("2026-11-27T10:09:16.000Z"), usedPct: 0, resetAtMs: resetBogus },
      { tsMs: Date.parse("2026-11-27T10:18:18.000Z"), usedPct: 36.4, resetAtMs: resetReal },
      { tsMs: Date.parse("2026-11-27T10:28:18.000Z"), usedPct: 36.88, resetAtMs: resetReal },
    ];

    const cleaned = filterGlitchSamples(pts);
    expect(cleaned).toHaveLength(4);
    expect(cleaned.map((p) => p.usedPct)).toEqual([35.79, 35.98, 36.4, 36.88]);

    // Billing cycle analysis should NOT credit a bogus early reset bonus week.
    const cycles = analyzeBillingCycles(pts, {
      provider: "antigravity",
      billingDay: 22,
      explicitMonthlyCost: 200,
      explicitPlan: "ultra",
      ignored: false,
    });
    const cycle = cycles.get("2026-11-22")!;
    expect(cycle.resets).toHaveLength(0);
    expect(cycle.bonusWeeks).toBe(0);
    expect(cycle.effectiveWeeks).toBeCloseTo(30 / 7, 6);

    // Events after the glitch must still be attributed instead of dropped as staleReset.
    const attributed = attributeAccountEvents(
      [
        {
          eventId: "e1",
          tsMs: Date.parse("2026-11-27T10:15:00.000Z"),
          model: "gemini-4-neon",
          apiCostUsd: null,
          totalTokens: 100_000,
          effectiveTokens: 100_000,
          failed: false,
          quotaUsedPct: null,
          quotaResetAtMs: null,
        },
        {
          eventId: "e2",
          tsMs: Date.parse("2026-11-27T10:24:00.000Z"),
          model: "gemini-4-neon",
          apiCostUsd: null,
          totalTokens: 100_000,
          effectiveTokens: 100_000,
          failed: false,
          quotaUsedPct: null,
          quotaResetAtMs: null,
        },
      ],
      pts,
      {
        weights: { baselineRate: 0, tokenBaselineRate: 1e-9, multipliers: new Map() },
        costPerWeekAt: () => 200 / (30 / 7),
        ignored: false,
      },
    );
    expect(attributed.get("e1")!.quotaWeeks).toBeCloseTo((36.4 - 35.98) / 100, 6);
    expect(attributed.get("e2")!.quotaWeeks).toBeCloseTo((36.88 - 36.4) / 100, 6);
  });

  test("preserves genuine mid-window and scheduled resets", () => {
    const reset1 = Date.parse("2026-12-03T08:00:00.000Z");
    const reset2 = Date.parse("2026-12-10T08:00:00.000Z");

    // Genuine mid-window reset: drops to 0% and stays low.
    const midWindow: QuotaPoint[] = [
      { tsMs: Date.parse("2026-11-27T08:00:00.000Z"), usedPct: 80, resetAtMs: reset1 },
      { tsMs: Date.parse("2026-11-27T08:10:00.000Z"), usedPct: 0, resetAtMs: reset1 },
      { tsMs: Date.parse("2026-11-27T08:20:00.000Z"), usedPct: 3, resetAtMs: reset1 },
      { tsMs: Date.parse("2026-11-27T08:30:00.000Z"), usedPct: 7, resetAtMs: reset1 },
    ];
    expect(filterGlitchSamples(midWindow).map((p) => p.usedPct)).toEqual([80, 0, 3, 7]);

    // Genuine scheduled reset: resetAt advances and stays advanced.
    const scheduled: QuotaPoint[] = [
      { tsMs: Date.parse("2026-12-03T07:50:00.000Z"), usedPct: 95, resetAtMs: reset1 },
      { tsMs: Date.parse("2026-12-03T08:05:00.000Z"), usedPct: 1, resetAtMs: reset2 },
      { tsMs: Date.parse("2026-12-03T08:15:00.000Z"), usedPct: 4, resetAtMs: reset2 },
    ];
    expect(filterGlitchSamples(scheduled).map((p) => p.usedPct)).toEqual([95, 1, 4]);
  });
});

describe("buildPoolStatuses", () => {
  test("weights Claude plans (Pro=0.1x, Max5=0.5x, Max20=1x) and computes 6h burn", () => {
    const now = Date.parse("2026-11-27T10:30:00.000Z");
    const resetSat = Date.parse("2026-11-28T07:00:00.000Z");
    const resetMon = Date.parse("2026-11-30T05:00:00.000Z");
    const mk = (source: string, plan: string, used6hAgo: number, usedNow: number, resetAtMs: number) => ({
      provider: "claude",
      source,
      explicitPlan: plan,
      ignored: false,
      samples: [
        { tsMs: now - 6 * HOUR, usedPct: used6hAgo, resetAtMs, plan },
        { tsMs: now - 5 * MIN, usedPct: usedNow, resetAtMs, plan },
      ],
    });

    const pools = buildPoolStatuses(
      [
        mk("m1", "max20", 100, 100, resetSat),
        mk("m2", "max20", 100, 100, resetMon),
        mk("m3", "max20", 100, 100, resetMon),
        mk("m4", "max20", 100, 100, resetMon),
        mk("m5", "max20", 73, 91, resetMon), // burned 18% in ~6h -> ~3%/h
        mk("mid", "max5", 0, 0, resetSat),   // 50% pool remaining
        mk("pro", "pro", 100, 100, resetMon), // 0% pool remaining
        { ...mk("ignored", "max20", 0, 0, resetMon), ignored: true },
      ],
      now,
    );

    expect(pools).toHaveLength(1);
    const claude = pools[0]!;
    expect(claude.provider).toBe("claude");
    expect(claude.accounts).toBe(7);
    expect(claude.capacity).toBe(560);
    // 9% from m5 + 50% from max5 = 59%
    expect(claude.remaining).toBeCloseTo(59, 1);
    expect(claude.burnPerHour).toBeGreaterThan(2.8);
    expect(claude.burnPerHour).toBeLessThan(3.2);
    expect(claude.nextResetAt).toBe(new Date(resetSat).toISOString());
    expect(claude.recorded.length).toBeGreaterThanOrEqual(2);
    expect(claude.recorded.length).toBeLessThanOrEqual(48);
    expect(claude.projected.length).toBeGreaterThanOrEqual(2);
  });

  test("ignores Antigravity 100% glitch spike when computing burn rate and emptyAt", () => {
    const now = Date.parse("2026-11-27T10:20:00.000Z");
    const resetReal = Date.parse("2026-12-03T07:58:07.000Z");
    const resetBogus = Date.parse("2026-12-04T10:10:17.000Z");

    const pools = buildPoolStatuses(
      [
        {
          provider: "antigravity",
          source: "ag-1",
          explicitPlan: "ultra",
          ignored: false,
          samples: [
            { tsMs: now - 6 * HOUR, usedPct: 34.0, resetAtMs: resetReal },
            { tsMs: now - 22 * MIN, usedPct: 35.98, resetAtMs: resetReal },
            { tsMs: now - 11 * MIN, usedPct: 0, resetAtMs: resetBogus }, // bogus cloudcode-pa fallback!
            { tsMs: now - 2 * MIN, usedPct: 36.4, resetAtMs: resetReal },
          ],
        },
      ],
      now,
    );

    expect(pools).toHaveLength(1);
    const ag = pools[0]!;
    expect(ag.capacity).toBe(100);
    expect(ag.remaining).toBeCloseTo(63.6, 1);
    // True burn is ~2.4% over ~6h = ~0.4%/h, NOT ~6.5%/h!
    expect(ag.burnPerHour).toBeGreaterThan(0.3);
    expect(ag.burnPerHour).toBeLessThan(0.5);
    expect(ag.emptyAt).toBeNull();
  });

  test("respects provider filter and skips stale accounts older than 7 days", () => {
    const now = Date.parse("2026-11-27T10:20:00.000Z");
    const reset = now + 3 * DAY;
    const pools = buildPoolStatuses(
      [
        {
          provider: "codex",
          source: "c1",
          explicitPlan: "pro",
          ignored: false,
          samples: [
            { tsMs: now - 3 * HOUR, usedPct: 45, resetAtMs: reset },
            { tsMs: now - 5 * MIN, usedPct: 46, resetAtMs: reset },
          ],
        },
        {
          provider: "codex",
          source: "retired",
          explicitPlan: "pro",
          ignored: false,
          samples: [{ tsMs: now - 10 * DAY, usedPct: 10, resetAtMs: now - 3 * DAY }],
        },
        {
          provider: "claude",
          source: "cl1",
          explicitPlan: "max20",
          ignored: false,
          samples: [{ tsMs: now - 10 * MIN, usedPct: 50, resetAtMs: reset }],
        },
      ],
      now,
      ["codex"],
    );

    expect(pools).toHaveLength(1);
    expect(pools[0]!.provider).toBe("codex");
    expect(pools[0]!.accounts).toBe(1);
    expect(pools[0]!.capacity).toBe(100);
    expect(pools[0]!.remaining).toBeCloseTo(54, 1);
  });
});
