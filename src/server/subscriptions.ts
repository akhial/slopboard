// Subscription-based real cost accounting.
//
// Translates flat monthly subscription costs (Claude Max/Pro, Codex Pro/Plus, ...)
// into exact per-event real USD spend:
//
//   1. Billing-cycle supply: each account's monthly price is divided by the
//      effective weekly quotas supplied during its billing cycle (exact calendar
//      days / 7, plus any mid-window bonus resets or early resets observed in
//      quota history).
//   2. Quota attribution: for each account, observed weekly quota increments
//      (from per-event response headers merged with CLIProxyAPI's quota history)
//      are split across the events that caused each tick, weighted by empirical
//      per-model API cost multipliers fitted from observed 5% quota bins.
//   3. Persistence: `quota_weeks` and `sub_cost_usd` are written back onto
//      `events` so board queries and POST /api/sql stay fast and consistent.

import { getMeta, num, numOrNull, setMeta, type Db } from "./db.ts";
import type { ProxyClient, QuotaHistoryResponse } from "./proxy.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

/** Two reset timestamps within this window are the same scheduled reset (handles jitter). */
const RESET_MERGE_MS = 10 * 60_000;
/** Minimum downward drop (percentage points) treated as a real reset rather than API/header noise. */
const RESET_DROP_THRESHOLD = 5.0;
/** A reset_at shift must occur at least this early before prev_reset_at to count as an early reset. */
const EARLY_RESET_MARGIN_MS = HOUR_MS;
/** Stale in-flight responses may carry pre-reset utilization for a short window after a mid-window reset. */
const STALE_POST_RESET_MS = 60_000;
/** Max span of a transient wrong-pool / phantom-reset glitch before the real window resumes. */
const GLITCH_REVERT_WINDOW_MS = 45 * 60_000;
/** Maximum pull range accepted by CLIProxyAPI /v8/management/quota/history. */
const PROXY_HISTORY_MAX_DAYS = 45;
const LAST_SYNC_KEY = "subscriptions.quota_synced_at";
const SEVEN_DAY_WINDOW = "seven_day";

/** Default monthly USD price for known OAuth subscription plans when not explicitly overridden. */
const DEFAULT_PLAN_PRICES: Record<string, Record<string, number>> = {
  claude: {
    max20: 200,
    max5: 100,
    max: 200,
    pro: 20,
  },
  codex: {
    pro: 200,
    plus: 20,
    team: 30,
  },
  antigravity: {
    ultra: 200,
    pro: 20,
    free: 0,
  },
};

/** Preserves full millisecond precision when Bun SQL returns Date instances. */
function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value));
}

function toMsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = toMs(value);
  return Number.isFinite(ms) ? ms : null;
}

export function defaultPlanMonthlyCost(provider: string, plan: string | null | undefined): number | null {
  if (!plan) return null;
  const p = provider.trim().toLowerCase();
  const pl = plan.trim().toLowerCase();
  const price = DEFAULT_PLAN_PRICES[p]?.[pl];
  return price === undefined ? null : price;
}

/** True when two plan strings represent a real tier change rather than a label refinement (max -> max20). */
export function isPlanTierChange(prevPlan: string | null | undefined, nextPlan: string | null | undefined): boolean {
  const a = (prevPlan ?? "").trim().toLowerCase();
  const b = (nextPlan ?? "").trim().toLowerCase();
  if (!a || !b || a === b) return false;
  if (a === "max" && (b === "max5" || b === "max20")) return false;
  if (b === "max" && (a === "max5" || a === "max20")) return false;
  return true;
}

// ------------------------------------------------------------ billing cycles

export interface BillingCycle {
  /** ISO date of cycle start (UTC), e.g. "2026-11-18". */
  key: string;
  startMs: number;
  endMs: number;
  days: number;
  scheduledWeeks: number;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function cycleAnchorMs(year: number, monthIndex: number, billingDay: number): number {
  const clamped = Math.min(billingDay, daysInUtcMonth(year, monthIndex));
  return Date.UTC(year, monthIndex, clamped, 0, 0, 0, 0);
}

/**
 * Returns the UTC billing cycle `[startMs, endMs)` containing `tsMs`.
 * `billingDay` is 1..31 (null defaults to 1, i.e. calendar month). Days past
 * a short month's end (e.g. 31 in February) clamp to the last day of that month.
 */
export function billingCycleFor(tsMs: number, billingDay: number | null): BillingCycle {
  const day = billingDay !== null && billingDay >= 1 && billingDay <= 31 ? Math.trunc(billingDay) : 1;
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const thisAnchor = cycleAnchorMs(y, m, day);
  let startMs: number;
  let endMs: number;
  if (tsMs >= thisAnchor) {
    startMs = thisAnchor;
    const nextY = m === 11 ? y + 1 : y;
    const nextM = m === 11 ? 0 : m + 1;
    endMs = cycleAnchorMs(nextY, nextM, day);
  } else {
    endMs = thisAnchor;
    const prevY = m === 0 ? y - 1 : y;
    const prevM = m === 0 ? 11 : m - 1;
    startMs = cycleAnchorMs(prevY, prevM, day);
  }
  const days = (endMs - startMs) / DAY_MS;
  return {
    key: new Date(startMs).toISOString().slice(0, 10),
    startMs,
    endMs,
    days,
    scheduledWeeks: days / 7,
  };
}

// ------------------------------------------------------------ reset & cycle analysis

export interface QuotaPoint {
  tsMs: number;
  usedPct: number;
  resetAtMs: number | null;
  plan?: string | null;
}

export interface DetectedReset {
  tsMs: number;
  kind: "mid-window" | "early";
  fromPct: number;
  toPct: number;
  bonusWeeks: number;
  cycleKey: string;
}

export interface CyclePricing {
  cycle: BillingCycle;
  plan: string | null;
  monthlyCostUsd: number | null;
  bonusWeeks: number;
  effectiveWeeks: number;
  costPerWeek: number | null;
  resets: DetectedReset[];
}

function isTransientDrop(points: readonly QuotaPoint[], index: number, highWater: number): boolean {
  const cur = points[index]!;
  for (let j = index + 1; j < points.length && j <= index + 5; j++) {
    const nxt = points[j]!;
    if (nxt.tsMs - cur.tsMs > STALE_POST_RESET_MS) break;
    if (nxt.usedPct >= highWater - 1.0) return true;
    if (nxt.usedPct <= cur.usedPct + 2.0) return false;
  }
  return false;
}

/**
 * Strips short-lived phantom-reset / wrong-pool glitches from chronological quota
 * samples — e.g. an Antigravity fallback poll to `cloudcode-pa` reporting `usedPct=0`
 * and `resetAt=now+7d` right between two genuine `daily-cloudcode-pa` reads at
 * `usedPct=36%` with the real reset timestamp.
 *
 * A run of 1–3 dipped points (<= 45 min) is dropped only when a following sample
 * unambiguously reverts to both the pre-drop `resetAt` (±10 min) and pre-drop
 * utilization (`>= hw - 2`), so genuine resets and tier upgrades are never touched.
 */
export function filterGlitchSamples<T extends QuotaPoint>(points: readonly T[]): T[] {
  if (points.length < 3) return [...points].sort((a, b) => a.tsMs - b.tsMs);
  const sorted = [...points].sort((a, b) => a.tsMs - b.tsMs);
  const out: T[] = [];
  let hw: number | null = null;
  let curResetAtMs: number | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    const drop = hw !== null ? hw - p.usedPct : 0;

    if (hw !== null && drop >= RESET_DROP_THRESHOLD) {
      let revertIdx = -1;
      for (let j = i + 1; j < sorted.length && j <= i + 4; j++) {
        const nxt = sorted[j]!;
        const span = nxt.tsMs - p.tsMs;
        if (span > GLITCH_REVERT_WINDOW_MS) break;
        const usedReverted = nxt.usedPct >= hw - 2.0;
        const resetReverted =
          curResetAtMs !== null && nxt.resetAtMs !== null
            ? Math.abs(nxt.resetAtMs - curResetAtMs) <= RESET_MERGE_MS
            : span <= STALE_POST_RESET_MS;
        if (usedReverted && resetReverted) {
          revertIdx = j;
          break;
        }
      }
      if (revertIdx !== -1) {
        i = revertIdx - 1;
        continue;
      }
    }

    out.push(p);
    const raAdvanced = curResetAtMs !== null && p.resetAtMs !== null && p.resetAtMs > curResetAtMs + RESET_MERGE_MS;
    if (raAdvanced) {
      hw = p.usedPct;
      curResetAtMs = p.resetAtMs;
    } else if (hw !== null && drop >= RESET_DROP_THRESHOLD) {
      hw = p.usedPct;
      if (p.resetAtMs !== null) curResetAtMs = p.resetAtMs;
    } else {
      hw = hw === null ? p.usedPct : Math.max(hw, p.usedPct);
      if (curResetAtMs === null && p.resetAtMs !== null) curResetAtMs = p.resetAtMs;
    }
  }
  return out;
}

/**
 * Resolves the effective plan for a point, preferring specific tiers (`max20`,
 * `max5`) over the legacy generic `"max"` label when later samples clarified it.
 */
function resolvePlanTimeline(points: readonly QuotaPoint[], fallbackPlan: string | null): string | null {
  let latestSpecific: string | null = null;
  for (const p of points) {
    const pl = p.plan?.trim().toLowerCase();
    if (pl && pl !== "max") latestSpecific = pl;
  }
  return latestSpecific ?? fallbackPlan?.trim().toLowerCase() ?? null;
}

/**
 * Walks an account's merged chronological weekly quota observations to detect
 * mid-window bonus resets (e.g. Claude full-reset / Fable givebacks) and early
 * resets (e.g. Codex resetting before its 7-day deadline), and computes the
 * exact cost per 100% weekly quota for each billing cycle.
 */
export function analyzeBillingCycles(
  points: readonly QuotaPoint[],
  opts: {
    provider: string;
    billingDay: number | null;
    explicitMonthlyCost: number | null;
    explicitPlan: string | null;
    ignored: boolean;
  },
): Map<string, CyclePricing> {
  const sorted = filterGlitchSamples(points);
  const resolvedFallback = resolvePlanTimeline(sorted, opts.explicitPlan);

  const cycleBonuses = new Map<string, { cycle: BillingCycle; resets: DetectedReset[]; plan: string | null }>();
  const touchCycle = (tsMs: number, plan: string | null) => {
    const cycle = billingCycleFor(tsMs, opts.billingDay);
    let entry = cycleBonuses.get(cycle.key);
    if (!entry) {
      entry = { cycle, resets: [], plan };
      cycleBonuses.set(cycle.key, entry);
    } else if (plan && (!entry.plan || entry.plan === "max")) {
      entry.plan = plan;
    } else if (plan && plan !== "max") {
      entry.plan = plan;
    }
    return entry;
  };

  let hw: number | null = null;
  let curResetAtMs: number | null = null;
  let lastPlan = "";
  let lastMidResetAtMs = -Infinity;
  let lastPreResetHw = 0;

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    const pPlan = (p.plan?.trim().toLowerCase() || "");
    const effectivePlan = pPlan === "max" && resolvedFallback?.startsWith("max") ? resolvedFallback : (pPlan || lastPlan || resolvedFallback);
    touchCycle(p.tsMs, effectivePlan);

    // Ignore stale in-flight headers from an older window.
    if (curResetAtMs !== null && p.resetAtMs !== null && p.resetAtMs < curResetAtMs - RESET_MERGE_MS) {
      if (pPlan) lastPlan = pPlan;
      continue;
    }
    // Ignore a single stale bounce-back right after a mid-window reset.
    if (p.tsMs - lastMidResetAtMs <= STALE_POST_RESET_MS && hw !== null && p.usedPct >= lastPreResetHw - 2 && p.usedPct > hw + 10) {
      if (pPlan) lastPlan = pPlan;
      continue;
    }

    const raAdvanced = curResetAtMs !== null && p.resetAtMs !== null && p.resetAtMs > curResetAtMs + RESET_MERGE_MS;
    const drop = hw !== null ? hw - p.usedPct : 0;
    const tierChanged = isPlanTierChange(lastPlan, pPlan);

    if (raAdvanced) {
      if (drop >= RESET_DROP_THRESHOLD && !tierChanged && curResetAtMs !== null && p.tsMs < curResetAtMs - EARLY_RESET_MARGIN_MS) {
        const elapsedFrac = Math.max(0, 1 - (curResetAtMs - p.tsMs) / WEEK_MS);
        const bonusWeeks = Math.max(0, drop / 100 - elapsedFrac);
        if (bonusWeeks >= 0.03) {
          const entry = touchCycle(p.tsMs, effectivePlan);
          entry.resets.push({
            tsMs: p.tsMs,
            kind: "early",
            fromPct: hw!,
            toPct: p.usedPct,
            bonusWeeks,
            cycleKey: entry.cycle.key,
          });
        }
      }
      hw = p.usedPct;
      curResetAtMs = p.resetAtMs;
    } else if (hw !== null && drop >= RESET_DROP_THRESHOLD) {
      if (!isTransientDrop(sorted, i, hw)) {
        if (!tierChanged) {
          const entry = touchCycle(p.tsMs, effectivePlan);
          entry.resets.push({
            tsMs: p.tsMs,
            kind: "mid-window",
            fromPct: hw,
            toPct: p.usedPct,
            bonusWeeks: drop / 100,
            cycleKey: entry.cycle.key,
          });
        }
        lastMidResetAtMs = p.tsMs;
        lastPreResetHw = hw;
        hw = p.usedPct;
      }
    } else {
      hw = hw === null ? p.usedPct : Math.max(hw, p.usedPct);
      if (curResetAtMs === null && p.resetAtMs !== null) curResetAtMs = p.resetAtMs;
    }
    if (pPlan) lastPlan = pPlan;
  }

  const out = new Map<string, CyclePricing>();
  for (const [key, entry] of cycleBonuses) {
    const bonusWeeks = entry.resets.reduce((s, r) => s + r.bonusWeeks, 0);
    const effectiveWeeks = entry.cycle.scheduledWeeks + bonusWeeks;
    const plan = opts.explicitPlan?.trim().toLowerCase() || entry.plan || resolvedFallback;
    const monthlyCostUsd = opts.ignored
      ? 0
      : opts.explicitMonthlyCost !== null
        ? opts.explicitMonthlyCost
        : defaultPlanMonthlyCost(opts.provider, plan);
    const costPerWeek = monthlyCostUsd !== null && effectiveWeeks > 0 ? monthlyCostUsd / effectiveWeeks : null;
    out.set(key, {
      cycle: entry.cycle,
      plan,
      monthlyCostUsd,
      bonusWeeks,
      effectiveWeeks,
      costPerWeek,
      resets: entry.resets,
    });
  }
  return out;
}

// ------------------------------------------------------------ empirical model weighting

export interface QuotaChunk {
  dqWeeks: number;
  byModelApiUsd: Map<string, number>;
  /** Effective token volume (input + 0.1*cacheRead + 1.25*cacheWrite + 5*output) for unpriced models like Antigravity. */
  byModelEffTokens?: Map<string, number>;
}

export interface ModelWeights {
  /** Baseline weekly-quota fraction per API list dollar (e.g. 1 / 3000 for Claude Max20). */
  baselineRate: number;
  /** Baseline weekly-quota fraction per effective token (fallback when API list prices are absent, e.g. Antigravity). */
  tokenBaselineRate: number;
  /** Per-model multiplier relative to baselineRate (models absent here use 1.0). */
  multipliers: Map<string, number>;
  /** Per-model multiplier relative to tokenBaselineRate for unpriced/mixed providers (e.g. Antigravity). */
  tokenMultipliers?: Map<string, number>;
}

/** Solves A * x = b via Gaussian elimination with partial pivoting; returns null if singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[col]!;
      M[col] = M[pivot]!;
      M[pivot] = tmp;
    }
    const diag = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c]! /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}

function fitRelativeMultipliers(
  chunks: readonly QuotaChunk[],
  volumeOf: (ch: QuotaChunk) => Map<string, number> | undefined,
  baselineRate: number,
  totalVolume: number,
  modelTotals: ReadonlyMap<string, number>,
): Map<string, number> {
  const multipliers = new Map<string, number>();
  if (baselineRate <= 0 || totalVolume <= 0 || chunks.length < 6) return multipliers;

  // Include models accounting for at least 5% of total volume (up to 12 models).
  const major = [...modelTotals.entries()]
    .filter(([, vol]) => vol / totalVolume >= 0.05)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([m]) => m);

  if (major.length < 2) return multipliers;

  const k = major.length;
  const idxOf = new Map(major.map((m, i) => [m, i]));
  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xtr: number[] = new Array<number>(k).fill(0);

  for (const ch of chunks) {
    if (!(ch.dqWeeks > 0)) continue;
    const byModel = volumeOf(ch);
    if (!byModel || byModel.size === 0) continue;
    const x = new Array<number>(k).fill(0);
    let minorVol = 0;
    for (const [m, vol] of byModel) {
      if (!(vol > 0)) continue;
      const idx = idxOf.get(m);
      if (idx !== undefined) x[idx]! += vol;
      else minorVol += vol;
    }
    // Solve for delta where w_m = baselineRate * (1 + delta_m).
    // Residual: y - baselineRate * (sum(x) + minorVol) = baselineRate * sum(x_m * delta_m).
    const majorSum = x.reduce((s, v) => s + v, 0);
    if (majorSum <= 0) continue;
    const residual = ch.dqWeeks / baselineRate - (majorSum + minorVol);
    for (let i = 0; i < k; i++) {
      if (x[i] === 0) continue;
      Xtr[i]! += x[i]! * residual;
      for (let j = 0; j < k; j++) {
        XtX[i]![j]! += x[i]! * x[j]!;
      }
    }
  }

  // Scale-invariant per-column ridge (1% of each model's own diagonal) so heavy-quota
  // models with smaller raw totals are not over-shrunk relative to larger ones.
  for (let i = 0; i < k; i++) {
    if (!(XtX[i]![i]! > 0)) return multipliers;
    XtX[i]![i]! *= 1.01;
  }

  const delta = solveLinear(XtX, Xtr);
  if (!delta) return multipliers;

  for (let i = 0; i < k; i++) {
    const mult = Math.min(10, Math.max(0.1, 1 + delta[i]!));
    if (Number.isFinite(mult)) multipliers.set(major[i]!, mult);
  }
  return multipliers;
}

/**
 * Fits relative quota-burn multipliers per model from observed interior ~5%
 * quota chunks using ridge-regularized least squares shrunk gently toward 1.0.
 * Fits both API-dollar multipliers (e.g. Claude Fable vs Opus) and
 * effective-token multipliers (for unpriced providers like Antigravity).
 */
export function fitModelWeights(chunks: readonly QuotaChunk[]): ModelWeights {
  let totalDq = 0;
  let totalUsd = 0;
  let totalTokenDq = 0;
  let totalEffTokens = 0;
  const modelTotals = new Map<string, number>();
  const modelTokTotals = new Map<string, number>();

  for (const ch of chunks) {
    if (!(ch.dqWeeks > 0)) continue;
    let sum = 0;
    for (const [m, usd] of ch.byModelApiUsd) {
      if (!(usd > 0)) continue;
      sum += usd;
      modelTotals.set(m, (modelTotals.get(m) ?? 0) + usd);
    }
    if (sum > 0) {
      totalDq += ch.dqWeeks;
      totalUsd += sum;
    }
    if (ch.byModelEffTokens) {
      let tokSum = 0;
      for (const [m, tok] of ch.byModelEffTokens) {
        if (!(tok > 0)) continue;
        tokSum += tok;
        modelTokTotals.set(m, (modelTokTotals.get(m) ?? 0) + tok);
      }
      if (tokSum > 0) {
        totalTokenDq += ch.dqWeeks;
        totalEffTokens += tokSum;
      }
    }
  }

  const baselineRate = totalUsd > 0 ? totalDq / totalUsd : 0;
  const tokenBaselineRate = totalEffTokens > 0 ? totalTokenDq / totalEffTokens : 0;
  const multipliers = fitRelativeMultipliers(chunks, (ch) => ch.byModelApiUsd, baselineRate, totalUsd, modelTotals);
  const tokenMultipliers = fitRelativeMultipliers(
    chunks,
    (ch) => ch.byModelEffTokens,
    tokenBaselineRate,
    totalEffTokens,
    modelTokTotals,
  );
  return { baselineRate, tokenBaselineRate, multipliers, tokenMultipliers };
}

// ------------------------------------------------------------ tick-by-tick attribution

export interface AttrEvent {
  eventId: string;
  tsMs: number;
  model: string;
  apiCostUsd: number | null;
  totalTokens: number;
  /** Token cost proxy (input + 0.1*cacheRead + 1.25*cacheWrite + 5*output) for unpriced/mixed batches. */
  effectiveTokens?: number;
  failed: boolean;
  quotaUsedPct: number | null;
  quotaResetAtMs: number | null;
}

export interface AttrResult {
  quotaWeeks: number | null;
  subCostUsd: number | null;
}

type StreamItem =
  | { kind: "event"; tsMs: number; usedPct: number | null; resetAtMs: number | null; ev: AttrEvent }
  | { kind: "sample"; tsMs: number; usedPct: number; resetAtMs: number | null };

function mergeStream(events: readonly AttrEvent[], samples: readonly QuotaPoint[]): StreamItem[] {
  const cleanSamples = filterGlitchSamples(samples);
  const items: StreamItem[] = [];
  for (const ev of events) {
    items.push({ kind: "event", tsMs: ev.tsMs, usedPct: ev.quotaUsedPct, resetAtMs: ev.quotaResetAtMs, ev });
  }
  for (const s of cleanSamples) {
    items.push({ kind: "sample", tsMs: s.tsMs, usedPct: s.usedPct, resetAtMs: s.resetAtMs });
  }
  items.sort((a, b) => {
    if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
    if (a.kind === "event" && b.kind === "event") return a.ev.eventId.localeCompare(b.ev.eventId);
    return 0;
  });
  return items;
}

function isTransientStreamDrop(items: readonly StreamItem[], index: number, highWater: number): boolean {
  const cur = items[index]!;
  if (cur.usedPct === null) return false;
  let checked = 0;
  for (let j = index + 1; j < items.length && checked < 5; j++) {
    const nxt = items[j]!;
    if (nxt.usedPct === null) continue;
    if (nxt.tsMs - cur.tsMs > STALE_POST_RESET_MS) break;
    checked++;
    if (nxt.usedPct >= highWater - 1.0) return true;
    if (nxt.usedPct <= cur.usedPct + 2.0) return false;
  }
  return false;
}

function effectiveTokensOf(ev: AttrEvent): number {
  if (ev.effectiveTokens !== undefined && ev.effectiveTokens > 0) return ev.effectiveTokens;
  return ev.totalTokens > 0 ? ev.totalTokens : 0;
}

/**
 * First pass over one account's stream: collects interior ~5% quota chunks
 * (for empirical model-weight fitting across all accounts of the same plan).
 */
export function collectQuotaChunks(
  events: readonly AttrEvent[],
  samples: readonly QuotaPoint[],
): QuotaChunk[] {
  const items = mergeStream(events, samples);
  const chunks: QuotaChunk[] = [];

  let hw: number | null = null;
  let curResetAtMs: number | null = null;
  let lastMidResetAtMs = -Infinity;
  let lastPreResetHw = 0;

  let chunkDq = 0;
  let chunkByModel = new Map<string, number>();
  let chunkByModelTok = new Map<string, number>();
  let batchEvents: AttrEvent[] = [];

  const resetSegment = (newHw: number | null, newResetAt: number | null) => {
    chunkDq = 0;
    chunkByModel = new Map();
    chunkByModelTok = new Map();
    batchEvents = [];
    hw = newHw;
    if (newResetAt !== null) curResetAtMs = newResetAt;
  };

  const absorbDelta = (dq: number) => {
    // Skip huge single jumps (> 10%) as they usually indicate an unrecorded gap.
    if (dq > 0 && dq <= 0.1) {
      let batchAllPriced = true;
      const batchByModel = new Map<string, number>();
      const batchByModelTok = new Map<string, number>();
      for (const ev of batchEvents) {
        const tok = effectiveTokensOf(ev);
        if (tok > 0) {
          batchByModelTok.set(ev.model, (batchByModelTok.get(ev.model) ?? 0) + tok);
          if (ev.apiCostUsd !== null && ev.apiCostUsd > 0) {
            batchByModel.set(ev.model, (batchByModel.get(ev.model) ?? 0) + ev.apiCostUsd);
          } else {
            batchAllPriced = false;
          }
        }
      }
      chunkDq += dq;
      if (batchAllPriced) {
        for (const [m, usd] of batchByModel) {
          chunkByModel.set(m, (chunkByModel.get(m) ?? 0) + usd);
        }
      }
      for (const [m, tok] of batchByModelTok) {
        chunkByModelTok.set(m, (chunkByModelTok.get(m) ?? 0) + tok);
      }
      if (chunkDq >= 0.045) {
        chunks.push({ dqWeeks: chunkDq, byModelApiUsd: chunkByModel, byModelEffTokens: chunkByModelTok });
        chunkDq = 0;
        chunkByModel = new Map();
        chunkByModelTok = new Map();
      }
    } else {
      chunkDq = 0;
      chunkByModel = new Map();
      chunkByModelTok = new Map();
    }
    batchEvents = [];
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const staleReset = curResetAtMs !== null && it.resetAtMs !== null && it.resetAtMs < curResetAtMs - RESET_MERGE_MS;
    const staleBounce =
      it.tsMs - lastMidResetAtMs <= STALE_POST_RESET_MS &&
      hw !== null &&
      it.usedPct !== null &&
      it.usedPct >= lastPreResetHw - 2 &&
      it.usedPct > hw + 10;

    if (staleReset || staleBounce) {
      if (it.kind === "event") batchEvents.push(it.ev);
      continue;
    }

    const raAdvanced = curResetAtMs !== null && it.resetAtMs !== null && it.resetAtMs > curResetAtMs + RESET_MERGE_MS;
    const drop = hw !== null && it.usedPct !== null ? hw - it.usedPct : 0;

    if (raAdvanced) {
      const boundaryMs = curResetAtMs!;
      const postResetEvents = batchEvents.filter((ev) => ev.tsMs >= boundaryMs);
      resetSegment(0, it.resetAtMs);
      batchEvents = postResetEvents;
      if (it.kind === "event") batchEvents.push(it.ev);
      if (it.usedPct !== null && it.usedPct > 0) {
        if (batchEvents.length > 0) absorbDelta(it.usedPct / 100);
        hw = it.usedPct;
      }
      continue;
    }

    if (hw !== null && drop >= RESET_DROP_THRESHOLD && !isTransientStreamDrop(items, i, hw)) {
      lastMidResetAtMs = it.tsMs;
      lastPreResetHw = hw;
      resetSegment(it.usedPct, it.resetAtMs);
      if (it.kind === "event") batchEvents.push(it.ev);
      continue;
    }

    if (it.kind === "event") batchEvents.push(it.ev);
    if (curResetAtMs === null && it.resetAtMs !== null) curResetAtMs = it.resetAtMs;

    if (it.usedPct !== null) {
      if (hw === null) {
        hw = it.usedPct;
        batchEvents = [];
      } else if (it.usedPct > hw) {
        absorbDelta((it.usedPct - hw) / 100);
        hw = it.usedPct;
      }
    }
  }
  return chunks;
}

/**
 * Attributes weekly quota (`quotaWeeks`) and real subscription spend (`subCostUsd`)
 * to every event of one `(provider, source)` account.
 *
 * Guarantees exact conservation: across any completed tick with jump `Δq`,
 * the attributed `quotaWeeks` of the events in that tick sum to `Δq` identically.
 */
export function attributeAccountEvents(
  events: readonly AttrEvent[],
  samples: readonly QuotaPoint[],
  opts: {
    weights: ModelWeights;
    costPerWeekAt: (tsMs: number) => number | null;
    ignored: boolean;
  },
): Map<string, AttrResult> {
  const out = new Map<string, AttrResult>();
  if (events.length === 0) return out;

  const hasEventHeaders = events.some((e) => e.quotaUsedPct !== null);
  const items = mergeStream(events, samples);
  let hw: number | null = null;
  let curResetAtMs: number | null = null;
  let lastMidResetAtMs = -Infinity;
  let lastPreResetHw = 0;
  let batch: AttrEvent[] = [];

  const priceOf = (tsMs: number, quotaWeeks: number | null): number | null => {
    if (opts.ignored) return 0;
    if (quotaWeeks === null) return null;
    const cpw = opts.costPerWeekAt(tsMs);
    return cpw === null ? null : quotaWeeks * cpw;
  };

  const apiWeight = (ev: AttrEvent): number => {
    const api = ev.apiCostUsd ?? 0;
    if (api <= 0) return 0;
    return api * (opts.weights.multipliers.get(ev.model) ?? 1);
  };

  const tokenWeight = (ev: AttrEvent): number => {
    const tok = effectiveTokensOf(ev);
    if (tok <= 0) return 0;
    return tok * (opts.weights.tokenMultipliers?.get(ev.model) ?? 1);
  };

  const batchCanUseApiCost = (evs: readonly AttrEvent[]): boolean => {
    let anyPriced = false;
    for (const ev of evs) {
      const hasTokens = effectiveTokensOf(ev) > 0;
      const hasPrice = ev.apiCostUsd !== null && ev.apiCostUsd > 0;
      if (hasTokens && !hasPrice) return false;
      if (hasPrice) anyPriced = true;
    }
    return anyPriced;
  };

  const distribute = (dqWeeks: number) => {
    if (batch.length === 0) return;
    if (!(dqWeeks > 0)) {
      for (const ev of batch) out.set(ev.eventId, { quotaWeeks: 0, subCostUsd: priceOf(ev.tsMs, 0) });
      batch = [];
      return;
    }
    // Only weight by API list cost when every token-bearing event in the batch has a list
    // price; mixed or unpriced batches (e.g. Antigravity) use effectiveTokens so unpriced
    // models still receive their fair share of the observed quota burn.
    const useApiCost = batchCanUseApiCost(batch);
    let totalW = 0;
    for (const ev of batch) {
      totalW += useApiCost ? apiWeight(ev) : tokenWeight(ev);
    }
    if (totalW > 0) {
      for (const ev of batch) {
        const w = useApiCost ? apiWeight(ev) : tokenWeight(ev);
        const q = dqWeeks * (w / totalW);
        out.set(ev.eventId, { quotaWeeks: q, subCostUsd: priceOf(ev.tsMs, q) });
      }
    } else {
      const nonFailed = batch.filter((e) => !e.failed);
      const targets = nonFailed.length > 0 ? nonFailed : batch;
      const each = dqWeeks / targets.length;
      const targetSet = new Set(targets.map((e) => e.eventId));
      for (const ev of batch) {
        const q = targetSet.has(ev.eventId) ? each : 0;
        out.set(ev.eventId, { quotaWeeks: q, subCostUsd: priceOf(ev.tsMs, q) });
      }
    }
    batch = [];
  };

  const estimateBatchQuota = (evs: readonly AttrEvent[]): number => {
    if (batchCanUseApiCost(evs) && opts.weights.baselineRate > 0) {
      let sum = 0;
      for (const ev of evs) sum += apiWeight(ev) * opts.weights.baselineRate;
      return sum;
    }
    if (opts.weights.tokenBaselineRate > 0) {
      let sum = 0;
      for (const ev of evs) sum += tokenWeight(ev) * opts.weights.tokenBaselineRate;
      return sum;
    }
    return 0;
  };

  const flushTrailing = () => {
    if (batch.length === 0) return;
    if (hw === null) {
      // No quota observations exist for this account yet; fall back to calibrated plan rate if available.
      const est = estimateBatchQuota(batch);
      if (est > 0) {
        distribute(est);
      } else {
        for (const ev of batch) {
          out.set(ev.eventId, { quotaWeeks: null, subCostUsd: opts.ignored ? 0 : null });
        }
        batch = [];
      }
      return;
    }
    if (hw >= 100) {
      // Account is already at 100% weekly utilization (e.g. overage credits); no weekly quota left to attribute.
      distribute(0);
      return;
    }
    const estDq = estimateBatchQuota(batch);
    if (estDq > 0) {
      const maxUnseen = hasEventHeaders ? 0.0099 : 0.05;
      const cap = Math.min(maxUnseen, Math.max(0, (100 - hw) / 100));
      distribute(Math.min(estDq, cap));
    } else {
      distribute(0);
    }
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const staleReset = curResetAtMs !== null && it.resetAtMs !== null && it.resetAtMs < curResetAtMs - RESET_MERGE_MS;
    const staleBounce =
      it.tsMs - lastMidResetAtMs <= STALE_POST_RESET_MS &&
      hw !== null &&
      it.usedPct !== null &&
      it.usedPct >= lastPreResetHw - 2 &&
      it.usedPct > hw + 10;

    if (staleReset || staleBounce) {
      if (it.kind === "event") batch.push(it.ev);
      continue;
    }

    const raAdvanced = curResetAtMs !== null && it.resetAtMs !== null && it.resetAtMs > curResetAtMs + RESET_MERGE_MS;
    const drop = hw !== null && it.usedPct !== null ? hw - it.usedPct : 0;

    if (raAdvanced) {
      // A scheduled weekly reset always refills the new window to 0%. Split any
      // buffered events around the old reset boundary so headerless events that
      // arrived in the new window (e.g. Antigravity between polls) receive the
      // new window's initial nonzero utilization.
      const boundaryMs = curResetAtMs!;
      const preReset = batch.filter((ev) => ev.tsMs < boundaryMs);
      const postReset = batch.filter((ev) => ev.tsMs >= boundaryMs);
      batch = preReset;
      flushTrailing();
      batch = postReset;
      hw = 0;
      curResetAtMs = it.resetAtMs;
      if (it.kind === "event") batch.push(it.ev);
      if (it.usedPct !== null && it.usedPct > 0) {
        if (batch.length > 0) distribute(it.usedPct / 100);
        hw = it.usedPct;
      }
      continue;
    }

    if (hw !== null && drop >= RESET_DROP_THRESHOLD && !isTransientStreamDrop(items, i, hw)) {
      // Mid-window reset (e.g. full reset or partial Fable giveback): the new floor
      // is the post-reset utilization, not 0%, so remaining non-reset usage is not re-billed.
      flushTrailing();
      lastMidResetAtMs = it.tsMs;
      lastPreResetHw = hw;
      hw = it.usedPct;
      if (it.resetAtMs !== null) curResetAtMs = it.resetAtMs;
      if (it.kind === "event") batch.push(it.ev);
      continue;
    }

    if (it.kind === "event") batch.push(it.ev);
    if (curResetAtMs === null && it.resetAtMs !== null) curResetAtMs = it.resetAtMs;

    if (it.usedPct !== null) {
      if (hw === null) {
        // Flush events that predated the very first poll sample so they use the
        // calibrated baseline rate instead of distorting the first observed interval.
        if (it.kind === "sample" && batch.length > 0) flushTrailing();
        hw = it.usedPct;
      } else if (it.usedPct > hw) {
        const dq = (it.usedPct - hw) / 100;
        distribute(dq);
        hw = it.usedPct;
      }
    }
  }
  flushTrailing();
  return out;
}

// ------------------------------------------------------------ database sync & recomputation

export interface QuotaSyncResult {
  enabled: boolean;
  accounts: number;
  samplesStored: number;
}

/**
 * Pulls quota history from CLIProxyAPI `/v8/management/quota/history` and
 * upserts it into `quota_samples`. On the first run it fetches the maximum
 * 45-day window; afterwards it fetches with a 2-day overlap so late samples
 * or plan updates are never missed.
 */
export async function syncQuotaHistory(sql: Db, proxy: ProxyClient): Promise<QuotaSyncResult> {
  const lastSync = await getMeta<string>(sql, LAST_SYNC_KEY);
  const nowMs = Date.now();
  const lastMs = lastSync ? Date.parse(lastSync) : Number.NaN;
  const fromMs = Number.isFinite(lastMs)
    ? Math.max(nowMs - PROXY_HISTORY_MAX_DAYS * DAY_MS, lastMs - 2 * DAY_MS)
    : nowMs - PROXY_HISTORY_MAX_DAYS * DAY_MS;

  const history: QuotaHistoryResponse = await proxy.getQuotaHistory(fromMs, nowMs);
  if (!history.enabled) {
    return { enabled: false, accounts: 0, samplesStored: 0 };
  }

  interface SampleRow {
    provider: string;
    source: string;
    window_id: string;
    ts: string;
    used_pct: number;
    reset_at: string | null;
    plan: string | null;
  }

  const rows: SampleRow[] = [];
  for (const acc of history.accounts) {
    const provider = acc.provider?.trim().toLowerCase();
    const source = (acc.email || acc.label || acc.auth_id || "").trim();
    if (!provider || !source) continue;

    // Resolve plan active at each sample timestamp from `acc.plans` (oldest first).
    const planChanges = Array.isArray(acc.plans)
      ? [...acc.plans].filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "string").sort((a, b) => a[0] - b[0])
      : [];
    const fallbackPlan = acc.plan?.trim().toLowerCase() || null;

    const planAt = (tMs: number): string | null => {
      if (planChanges.length === 0) return fallbackPlan;
      let cur = planChanges[0]![1].trim().toLowerCase() || fallbackPlan;
      for (const [ct, cp] of planChanges) {
        if (ct <= tMs) cur = cp.trim().toLowerCase() || cur;
        else break;
      }
      return cur;
    };

    for (const win of acc.windows ?? []) {
      if (!win.id || !Array.isArray(win.points)) continue;
      for (const pt of win.points) {
        if (!Array.isArray(pt) || typeof pt[0] !== "number" || typeof pt[1] !== "number") continue;
        const tMs = pt[0];
        const usedPct = Math.min(100, Math.max(0, pt[1]));
        const resetMs = typeof pt[2] === "number" && pt[2] > 0 ? pt[2] : null;
        rows.push({
          provider,
          source,
          window_id: win.id,
          ts: new Date(tMs).toISOString(),
          used_pct: usedPct,
          reset_at: resetMs !== null ? new Date(resetMs).toISOString() : null,
          plan: planAt(tMs),
        });
      }
    }
  }

  // Deduplicate by primary key (last wins).
  const deduped = new Map<string, SampleRow>();
  for (const r of rows) {
    deduped.set(`${r.provider}\0${r.source}\0${r.window_id}\0${r.ts}`, r);
  }
  const unique = [...deduped.values()];

  let stored = 0;
  if (unique.length > 0) {
    await sql.begin(async (tx) => {
      for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500);
        const res = await tx`
          insert into quota_samples ${tx(chunk)}
          on conflict (provider, source, window_id, ts) do update set
            used_pct = excluded.used_pct,
            reset_at = coalesce(excluded.reset_at, quota_samples.reset_at),
            plan = coalesce(excluded.plan, quota_samples.plan)
          where quota_samples.used_pct is distinct from excluded.used_pct
             or quota_samples.reset_at is distinct from excluded.reset_at
             or quota_samples.plan is distinct from excluded.plan
          returning ts`;
        stored += res.length;
      }
    });
  }

  await setMeta(sql, LAST_SYNC_KEY, new Date(nowMs).toISOString());
  return { enabled: true, accounts: history.accounts.length, samplesStored: stored };
}

export interface SubscriptionRow {
  provider: string;
  source: string;
  plan: string | null;
  monthly_cost_usd: number | null;
  billing_day: number | null;
  ignored: boolean;
  note: string | null;
}

export interface RecomputeResult {
  accounts: number;
  eventsChecked: number;
  eventsUpdated: number;
}

export interface AccountSummary {
  provider: string;
  source: string;
  plan: string | null;
  configured: boolean;
  ignored: boolean;
  monthlyCostUsd: number | null;
  billingDay: number | null;
  currentCycle: CyclePricing | null;
  events: number;
  quotaWeeks: number;
  subCostUsd: number | null;
  apiCostUsd: number | null;
}

function accountKey(provider: string, source: string): string {
  return `${provider.toLowerCase()}\0${source}`;
}

function approxEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= 1e-9;
}

/**
 * Recomputes `quota_weeks` and `sub_cost_usd` on `events` for all accounts
 * (or a single account when filtered), using stored `subscriptions`,
 * `quota_samples`, and per-event `quota_used_pct` / `quota_reset_at`.
 */
export async function recomputeSubscriptionCosts(sql: Db): Promise<RecomputeResult> {
  const [subRows, sampleRows, eventRows] = await Promise.all([
    sql<Record<string, unknown>[]>`
      select provider, source, plan, monthly_cost_usd::float8 as monthly_cost_usd, billing_day, ignored, note
      from subscriptions`,
    sql<Record<string, unknown>[]>`
      select provider, source, ts, used_pct, reset_at, plan
      from quota_samples
      where window_id = ${SEVEN_DAY_WINDOW}
      order by provider, source, ts`,
    sql<Record<string, unknown>[]>`
      select event_id, provider, source, ts, model, api_cost_usd, total_tokens::float8 as total_tokens,
             (input_tokens + 0.1 * cache_read_tokens + 1.25 * cache_write_tokens + 5.0 * output_tokens + unclassified_tokens)::float8 as eff_tokens,
             failed, quota_used_pct, quota_reset_at, quota_weeks, sub_cost_usd
      from events_v
      where source is not null
      order by provider, source, ts, event_id`,
  ]);

  const subs = new Map<string, SubscriptionRow>();
  for (const r of subRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    subs.set(accountKey(provider, source), {
      provider,
      source,
      plan: r.plan ? String(r.plan) : null,
      monthly_cost_usd: numOrNull(r.monthly_cost_usd),
      billing_day: r.billing_day === null || r.billing_day === undefined ? null : num(r.billing_day),
      ignored: r.ignored === true,
      note: r.note ? String(r.note) : null,
    });
  }

  const samplesByAccount = new Map<string, QuotaPoint[]>();
  const planByAccount = new Map<string, string>();
  for (const r of sampleRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = accountKey(provider, source);
    let list = samplesByAccount.get(key);
    if (!list) samplesByAccount.set(key, (list = []));
    const plan = r.plan ? String(r.plan).toLowerCase() : null;
    if (plan && (plan !== "max" || !planByAccount.has(key))) planByAccount.set(key, plan);
    list.push({
      tsMs: toMs(r.ts),
      usedPct: num(r.used_pct),
      resetAtMs: toMsOrNull(r.reset_at),
      plan,
    });
  }

  interface StoredEvent extends AttrEvent {
    provider: string;
    source: string;
    prevQuotaWeeks: number | null;
    prevSubCostUsd: number | null;
  }

  const eventsByAccount = new Map<string, StoredEvent[]>();
  for (const r of eventRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = accountKey(provider, source);
    let list = eventsByAccount.get(key);
    if (!list) eventsByAccount.set(key, (list = []));
    list.push({
      eventId: String(r.event_id),
      provider,
      source,
      tsMs: toMs(r.ts),
      model: String(r.model),
      apiCostUsd: numOrNull(r.api_cost_usd),
      totalTokens: num(r.total_tokens),
      effectiveTokens: num(r.eff_tokens),
      failed: r.failed === true,
      quotaUsedPct: numOrNull(r.quota_used_pct),
      quotaResetAtMs: toMsOrNull(r.quota_reset_at),
      prevQuotaWeeks: numOrNull(r.quota_weeks),
      prevSubCostUsd: numOrNull(r.sub_cost_usd),
    });
  }

  // Identify every account that has events.
  const accountKeys = [...eventsByAccount.keys()];

  // Step 1: Collect ~5% quota chunks per (provider, planGroup) so empirical model
  // weights can be pooled across accounts on the same tier (e.g. all 5 Claude Max20x accounts).
  const planGroupOf = (key: string, provider: string): string => {
    const sub = subs.get(key);
    const plan = (sub?.plan || planByAccount.get(key) || "").toLowerCase();
    return `${provider}\0${plan}`;
  };

  const chunksByGroup = new Map<string, QuotaChunk[]>();
  for (const key of accountKeys) {
    const evs = eventsByAccount.get(key)!;
    const provider = evs[0]!.provider;
    const samples = samplesByAccount.get(key) ?? [];
    const group = planGroupOf(key, provider);
    const chunks = collectQuotaChunks(evs, samples);
    if (chunks.length > 0) {
      let arr = chunksByGroup.get(group);
      if (!arr) chunksByGroup.set(group, (arr = []));
      arr.push(...chunks);
    }
  }

  const weightsByGroup = new Map<string, ModelWeights>();
  for (const [group, chunks] of chunksByGroup) {
    weightsByGroup.set(group, fitModelWeights(chunks));
  }

  // Step 2: Analyze billing cycles & attribute quota + real USD per account.
  const updateIds: string[] = [];
  const updateWeeks: (number | null)[] = [];
  const updateCosts: (number | null)[] = [];

  for (const key of accountKeys) {
    const evs = eventsByAccount.get(key)!;
    const provider = evs[0]!.provider;
    const sub = subs.get(key) ?? null;
    const samples = samplesByAccount.get(key) ?? [];

    // Merge quota_samples and event header points for complete billing-cycle reset analysis.
    const mergedPoints: QuotaPoint[] = [...samples];
    for (const ev of evs) {
      if (ev.quotaUsedPct !== null) {
        mergedPoints.push({ tsMs: ev.tsMs, usedPct: ev.quotaUsedPct, resetAtMs: ev.quotaResetAtMs, plan: null });
      }
    }

    const billingDay = sub?.billing_day ?? null;
    const explicitPlan = sub?.plan ?? null;
    const explicitMonthlyCost = sub ? sub.monthly_cost_usd : null;
    const ignored = sub?.ignored ?? false;

    const cycles = analyzeBillingCycles(mergedPoints, {
      provider,
      billingDay,
      explicitMonthlyCost,
      explicitPlan,
      ignored,
    });

    const fallbackPlan = explicitPlan ?? planByAccount.get(key) ?? null;
    const fallbackMonthly = ignored
      ? 0
      : explicitMonthlyCost !== null
        ? explicitMonthlyCost
        : defaultPlanMonthlyCost(provider, fallbackPlan);

    // Compact plan timeline from quota_samples so mid-cycle tier upgrades (e.g. Pro -> Max5)
    // price historical events at the tier active when they ran instead of retroactively
    // applying the newer tier's fee to earlier smaller quotas.
    const planPoints: { tsMs: number; plan: string }[] = [];
    for (const s of samples) {
      const p = s.plan?.trim().toLowerCase();
      if (!p) continue;
      if (planPoints.length === 0 || planPoints[planPoints.length - 1]!.plan !== p) {
        planPoints.push({ tsMs: s.tsMs, plan: p });
      }
    }
    const planAtTs = (tsMs: number): string | null => {
      if (planPoints.length === 0) return null;
      let cur = planPoints[0]!.plan;
      for (let i = 0; i < planPoints.length; i++) {
        if (planPoints[i]!.tsMs <= tsMs) cur = planPoints[i]!.plan;
        else break;
      }
      return cur;
    };

    const costPerWeekAt = (tsMs: number): number | null => {
      if (ignored) return 0;
      const cycle = billingCycleFor(tsMs, billingDay);
      const found = cycles.get(cycle.key);
      const effectiveWeeks = found ? found.effectiveWeeks : cycle.scheduledWeeks;
      const activePlan = planAtTs(tsMs);
      if (activePlan && fallbackPlan && isPlanTierChange(activePlan, fallbackPlan)) {
        const historicalMonthly = defaultPlanMonthlyCost(provider, activePlan);
        if (historicalMonthly !== null && effectiveWeeks > 0) {
          return historicalMonthly / effectiveWeeks;
        }
      }
      if (found) return found.costPerWeek;
      return fallbackMonthly !== null && effectiveWeeks > 0 ? fallbackMonthly / effectiveWeeks : null;
    };

    const group = planGroupOf(key, provider);
    const weights = weightsByGroup.get(group) ?? { baselineRate: 0, tokenBaselineRate: 0, multipliers: new Map() };

    const attributed = attributeAccountEvents(evs, samples, { weights, costPerWeekAt, ignored });

    for (const ev of evs) {
      const res = attributed.get(ev.eventId) ?? { quotaWeeks: null, subCostUsd: null };
      if (!approxEqual(ev.prevQuotaWeeks, res.quotaWeeks) || !approxEqual(ev.prevSubCostUsd, res.subCostUsd)) {
        updateIds.push(ev.eventId);
        updateWeeks.push(res.quotaWeeks);
        updateCosts.push(res.subCostUsd);
      }
    }
  }

  // Serialize concurrent recomputes (e.g. CLI + daemon) via a transaction-scoped
  // advisory lock so bulk updates never contend on row-level transactionid locks.
  if (updateIds.length > 0) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('slopboard_subscriptions_recompute'))`;
      for (let i = 0; i < updateIds.length; i += 5000) {
        const ids = updateIds.slice(i, i + 5000);
        const weeks = updateWeeks.slice(i, i + 5000);
        const costs = updateCosts.slice(i, i + 5000);
        await tx.unsafe(
          `update events e
           set quota_weeks = v.q,
               sub_cost_usd = v.c
           from unnest($1::text[], $2::double precision[], $3::double precision[]) as v(id, q, c)
           where e.event_id = v.id`,
          [ids, weeks, costs],
        );
      }
    });
  }

  return { accounts: accountKeys.length, eventsChecked: eventRows.length, eventsUpdated: updateIds.length };
}

// ------------------------------------------------------------ admin helpers

export async function upsertSubscription(
  sql: Db,
  input: {
    provider: string;
    source: string;
    monthlyCostUsd: number | null;
    billingDay?: number | null;
    plan?: string | null;
    ignored?: boolean;
    note?: string | null;
  },
): Promise<SubscriptionRow> {
  const provider = input.provider.trim().toLowerCase();
  const source = input.source.trim();
  if (!provider) throw new Error("provider is required");
  if (!source) throw new Error("account is required");
  if (input.monthlyCostUsd !== null && (!Number.isFinite(input.monthlyCostUsd) || input.monthlyCostUsd < 0)) {
    throw new Error("monthly cost must be a non-negative number");
  }
  const billingDay = input.billingDay ?? null;
  if (billingDay !== null && (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31)) {
    throw new Error("billing day must be an integer between 1 and 31");
  }
  const plan = input.plan?.trim().toLowerCase() || null;
  const ignored = input.ignored ?? false;
  const note = input.note?.trim() || null;

  const [row] = await sql<Record<string, unknown>[]>`
    insert into subscriptions (provider, source, plan, monthly_cost_usd, billing_day, ignored, note, updated_at)
    values (${provider}, ${source}, ${plan}, ${input.monthlyCostUsd}, ${billingDay}, ${ignored}, ${note}, now())
    on conflict (provider, source) do update set
      plan = coalesce(excluded.plan, subscriptions.plan),
      monthly_cost_usd = coalesce(excluded.monthly_cost_usd, subscriptions.monthly_cost_usd),
      billing_day = coalesce(excluded.billing_day, subscriptions.billing_day),
      ignored = excluded.ignored,
      note = coalesce(excluded.note, subscriptions.note),
      updated_at = now()
    returning provider, source, plan, monthly_cost_usd::float8 as monthly_cost_usd, billing_day, ignored, note`;

  return {
    provider: String(row!.provider),
    source: String(row!.source),
    plan: row!.plan ? String(row!.plan) : null,
    monthly_cost_usd: numOrNull(row!.monthly_cost_usd),
    billing_day: row!.billing_day === null ? null : num(row!.billing_day),
    ignored: row!.ignored === true,
    note: row!.note ? String(row!.note) : null,
  };
}

export async function setSubscriptionIgnored(
  sql: Db,
  provider: string,
  source: string,
  ignored: boolean,
): Promise<SubscriptionRow> {
  const p = provider.trim().toLowerCase();
  const s = source.trim();
  if (!p || !s) throw new Error("provider and account are required");
  const existing = await sql<Record<string, unknown>[]>`
    select provider, source, plan, monthly_cost_usd::float8 as monthly_cost_usd, billing_day, ignored, note
    from subscriptions where provider = ${p} and source = ${s}`;
  if (existing.length > 0) {
    const [row] = await sql<Record<string, unknown>[]>`
      update subscriptions set ignored = ${ignored}, updated_at = now()
      where provider = ${p} and source = ${s}
      returning provider, source, plan, monthly_cost_usd::float8 as monthly_cost_usd, billing_day, ignored, note`;
    return {
      provider: String(row!.provider),
      source: String(row!.source),
      plan: row!.plan ? String(row!.plan) : null,
      monthly_cost_usd: numOrNull(row!.monthly_cost_usd),
      billing_day: row!.billing_day === null ? null : num(row!.billing_day),
      ignored: row!.ignored === true,
      note: row!.note ? String(row!.note) : null,
    };
  }
  // Leave monthly_cost_usd null so unignoring later automatically resolves the discovered plan default.
  return await upsertSubscription(sql, { provider: p, source: s, monthlyCostUsd: null, ignored });
}

export async function deleteSubscription(sql: Db, provider: string, source: string): Promise<boolean> {
  const p = provider.trim().toLowerCase();
  const s = source.trim();
  const res = await sql`delete from subscriptions where provider = ${p} and source = ${s} returning source`;
  return res.length > 0;
}

/** Lists every configured or observed account with its current billing cycle pricing and spend. */
export async function listSubscriptions(sql: Db, nowMs = Date.now()): Promise<AccountSummary[]> {
  const [subRows, sampleRows, eventAggRows] = await Promise.all([
    sql<Record<string, unknown>[]>`
      select provider, source, plan, monthly_cost_usd::float8 as monthly_cost_usd, billing_day, ignored
      from subscriptions`,
    sql<Record<string, unknown>[]>`
      select provider, source, ts, used_pct, reset_at, plan
      from quota_samples
      where window_id = ${SEVEN_DAY_WINDOW}
      order by provider, source, ts`,
    sql<Record<string, unknown>[]>`
      select lower(provider) as provider, source,
             count(*)::int as events,
             coalesce(sum(quota_weeks), 0)::float8 as quota_weeks,
             sum(sub_cost_usd)::float8 as sub_cost_usd,
             sum(api_cost_usd)::float8 as api_cost_usd
      from events_v
      where source is not null
      group by 1, 2`,
  ]);

  const subs = new Map<string, { provider: string; source: string; plan: string | null; cost: number | null; billingDay: number | null; ignored: boolean }>();
  const allKeys = new Map<string, { provider: string; source: string }>();

  for (const r of subRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = accountKey(provider, source);
    subs.set(key, {
      provider,
      source,
      plan: r.plan ? String(r.plan) : null,
      cost: numOrNull(r.monthly_cost_usd),
      billingDay: r.billing_day === null ? null : num(r.billing_day),
      ignored: r.ignored === true,
    });
    allKeys.set(key, { provider, source });
  }

  const samplesByAccount = new Map<string, QuotaPoint[]>();
  for (const r of sampleRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = accountKey(provider, source);
    allKeys.set(key, { provider, source });
    let list = samplesByAccount.get(key);
    if (!list) samplesByAccount.set(key, (list = []));
    list.push({
      tsMs: toMs(r.ts),
      usedPct: num(r.used_pct),
      resetAtMs: toMsOrNull(r.reset_at),
      plan: r.plan ? String(r.plan) : null,
    });
  }

  const aggByAccount = new Map<string, { events: number; quotaWeeks: number; subCostUsd: number | null; apiCostUsd: number | null }>();
  for (const r of eventAggRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = accountKey(provider, source);
    allKeys.set(key, { provider, source });
    aggByAccount.set(key, {
      events: num(r.events),
      quotaWeeks: num(r.quota_weeks),
      subCostUsd: numOrNull(r.sub_cost_usd),
      apiCostUsd: numOrNull(r.api_cost_usd),
    });
  }

  const out: AccountSummary[] = [];
  for (const [key, { provider, source }] of allKeys) {
    const sub = subs.get(key);
    const samples = samplesByAccount.get(key) ?? [];
    const agg = aggByAccount.get(key);
    const billingDay = sub?.billingDay ?? null;
    const cycles = analyzeBillingCycles(samples, {
      provider,
      billingDay,
      explicitMonthlyCost: sub ? sub.cost : null,
      explicitPlan: sub?.plan ?? null,
      ignored: sub?.ignored ?? false,
    });
    const curCycleKey = billingCycleFor(nowMs, billingDay).key;
    let currentCycle = cycles.get(curCycleKey) ?? null;
    if (!currentCycle) {
      const cycle = billingCycleFor(nowMs, billingDay);
      const plan = sub?.plan ?? resolvePlanTimeline(samples, null);
      const monthly = sub?.ignored
        ? 0
        : sub?.cost !== null && sub?.cost !== undefined
          ? sub.cost
          : defaultPlanMonthlyCost(provider, plan);
      currentCycle = {
        cycle,
        plan,
        monthlyCostUsd: monthly,
        bonusWeeks: 0,
        effectiveWeeks: cycle.scheduledWeeks,
        costPerWeek: monthly !== null ? monthly / cycle.scheduledWeeks : null,
        resets: [],
      };
    }
    out.push({
      provider,
      source,
      plan: currentCycle.plan,
      configured: sub !== undefined,
      ignored: sub?.ignored ?? false,
      monthlyCostUsd: currentCycle.monthlyCostUsd,
      billingDay,
      currentCycle,
      events: agg?.events ?? 0,
      quotaWeeks: agg?.quotaWeeks ?? 0,
      subCostUsd: agg?.subCostUsd ?? null,
      apiCostUsd: agg?.apiCostUsd ?? null,
    });
  }

  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source));
}

// ------------------------------------------------------------ background scheduler

export interface SubscriptionSyncHandle {
  /** Trigger a recomputation soon (debounced), e.g. after new events land. */
  nudge: () => void;
  stop: () => void;
}

/**
 * Periodically pulls quota history from the proxy (when available) and
 * recomputes per-event subscription costs. Also supports debounced nudges
 * whenever the collector stores new events.
 */
export function scheduleSubscriptionSync(
  sql: Db,
  proxy: ProxyClient | null,
  everySeconds: number,
  log: (message: string) => void = (m) => console.log(`[subscriptions] ${m}`),
): SubscriptionSyncHandle {
  let busy = false;
  let pendingNudge = false;
  let stopped = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  const run = async (withProxySync: boolean) => {
    if (stopped) return;
    if (busy) {
      if (!withProxySync) pendingNudge = true;
      return;
    }
    busy = true;
    try {
      if (withProxySync && proxy) {
        const synced = await syncQuotaHistory(sql, proxy);
        if (synced.enabled && synced.samplesStored > 0) {
          log(`synced ${synced.samplesStored} quota samples across ${synced.accounts} accounts`);
        }
      }
      const res = await recomputeSubscriptionCosts(sql);
      if (res.eventsUpdated > 0) {
        log(`updated subscription costs for ${res.eventsUpdated} / ${res.eventsChecked} events (${res.accounts} accounts)`);
      }
    } catch (error) {
      log(`sync failed: ${(error as Error).message}`);
    } finally {
      busy = false;
      if (pendingNudge && !stopped) {
        pendingNudge = false;
        void run(false);
      }
    }
  };

  void run(true);
  const timer = setInterval(() => void run(true), Math.max(10, everySeconds) * 1000);

  return {
    nudge: () => {
      if (stopped || nudgeTimer) return;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        void run(false);
      }, 15_000);
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (nudgeTimer) {
        clearTimeout(nudgeTimer);
        nudgeTimer = null;
      }
    },
  };
}
