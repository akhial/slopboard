// Weekly quota pool availability, 6-hour burn rate, and short-horizon projection
// built from stored `quota_samples` and `subscriptions`.
//
// Mirrors CLIProxyAPI Management Center's pool math (weighted by subscription tier
// relative to the largest tier in the pool, e.g. Claude Pro = 0.1x, Max5 = 0.5x,
// Max20 = 1.0x), while stripping transient wrong-pool glitch spikes via
// `filterGlitchSamples` and never exposing account identifiers.

import type { PoolPoint, PoolStatus } from "../shared/api.ts";
import { filterGlitchSamples, isPlanTierChange, type QuotaPoint } from "./subscriptions.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const BURN_WINDOW_HOURS = 6;
const RECORDED_WINDOW_DAYS = 3;
const PROJECTED_WINDOW_DAYS = 4;
const HORIZON_DAYS = 7;
const ACTIVE_SAMPLE_MAX_AGE_MS = 7 * DAY_MS;
const MIN_BURN_SPAN_MS = 10 * MINUTE_MS;
const RESET_MERGE_MS = 60_000;
const STALE_AFTER_RESET_MS = 30 * MINUTE_MS;
const SOURCE_NOISE_PERCENT = 2;
const EPSILON = 1e-6;
/** Maximum recorded points sent per provider to keep the board payload compact. */
const MAX_RECORDED_POINTS = 48;

const PLAN_WEEKLY_UNITS: Record<string, Record<string, number>> = {
  claude: { pro: 1, max5: 5, max20: 10, max: 10 },
};

const PROVIDER_ORDER = ["claude", "codex", "antigravity"];

interface SeriesPoint {
  t: number;
  v: number;
}

export interface PoolAccountInput {
  provider: string;
  source: string;
  /** Explicit plan from `subscriptions`, or null. */
  explicitPlan: string | null;
  ignored: boolean;
  /** Raw seven_day samples for this account. */
  samples: QuotaPoint[];
}

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

function defaultPlanWeights(provider: string, currentPlans: readonly string[], pastPlans: readonly string[]): Map<string, number> {
  const units = PLAN_WEEKLY_UNITS[provider] ?? {};
  const known = currentPlans.map((p) => units[p]).filter((v): v is number => v !== undefined);
  const reference = known.length > 0 ? Math.max(...known) : 1;
  const out = new Map<string, number>();
  for (const plan of [...pastPlans, ...currentPlans]) {
    if (!plan) continue;
    out.set(plan, units[plan] !== undefined ? units[plan]! / reference : 1);
  }
  return out;
}

function buildRecordedSeries(samples: readonly QuotaPoint[], from: number, to: number): SeriesPoint[] {
  const series: SeriesPoint[] = [];
  if (samples.length === 0 || to <= from) return series;

  const remOf = (p: QuotaPoint) => clampPct(100 - p.usedPct);
  const first = samples[0]!;
  if (first.tsMs > from) series.push({ t: from, v: remOf(first) });

  let prev: QuotaPoint | null = null;
  for (const s of samples) {
    const rem = remOf(s);
    if (!prev) {
      series.push({ t: s.tsMs, v: rem });
      prev = s;
      continue;
    }
    const prevRem = remOf(prev);
    const resetAt = prev.resetAtMs;
    if (resetAt !== null && resetAt > prev.tsMs && resetAt <= s.tsMs) {
      series.push({ t: resetAt, v: prevRem });
      series.push({ t: resetAt, v: 100 });
      const stale = s.tsMs - resetAt <= STALE_AFTER_RESET_MS && Math.abs(rem - prevRem) < 0.5 && rem < 100;
      if (stale) {
        series.push({ t: s.tsMs, v: 100 });
        prev = { tsMs: s.tsMs, usedPct: 0, resetAtMs: s.resetAtMs };
        continue;
      }
      series.push({ t: s.tsMs, v: rem });
    } else if (rem > prevRem + 0.5) {
      const sameWindow =
        prev.resetAtMs === null || s.resetAtMs === null || Math.abs(s.resetAtMs - prev.resetAtMs) <= RESET_MERGE_MS;
      if (sameWindow && rem - prevRem < SOURCE_NOISE_PERCENT) {
        series.push({ t: s.tsMs, v: prevRem });
        prev = { ...s, usedPct: prev.usedPct };
        continue;
      }
      series.push({ t: s.tsMs, v: prevRem });
      series.push({ t: s.tsMs, v: rem });
    } else {
      series.push({ t: s.tsMs, v: rem });
    }
    prev = s;
  }

  const last = prev ?? samples[samples.length - 1]!;
  const lastRem = remOf(last);
  if (last.tsMs < to) {
    if (last.resetAtMs !== null && last.resetAtMs > last.tsMs && last.resetAtMs <= to) {
      series.push({ t: last.resetAtMs, v: lastRem });
      series.push({ t: last.resetAtMs, v: 100 });
      series.push({ t: to, v: 100 });
    } else {
      series.push({ t: to, v: lastRem });
    }
  }

  return clipSeries(series, from, to);
}

function valueAt(series: readonly SeriesPoint[], t: number, side: "pre" | "post" = "post"): number {
  if (series.length === 0) return 0;
  if (t < series[0]!.t) return series[0]!.v;
  const last = series[series.length - 1]!;
  if (t > last.t) return last.v;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  if (series[lo]!.t === t) {
    if (side === "pre") return series[lo]!.v;
    let end = lo;
    while (end + 1 < series.length && series[end + 1]!.t === t) end += 1;
    return series[end]!.v;
  }
  const a = series[lo - 1]!;
  const b = series[lo]!;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

function clipSeries(series: readonly SeriesPoint[], from: number, to: number): SeriesPoint[] {
  if (series.length === 0 || to < from) return [];
  const out: SeriesPoint[] = [];
  if (series[0]!.t < from) out.push({ t: from, v: valueAt(series, from, "post") });
  for (const pt of series) {
    if (pt.t >= from && pt.t <= to) out.push(pt);
  }
  if (series[series.length - 1]!.t > to && (out.length === 0 || out[out.length - 1]!.t < to)) {
    out.push({ t: to, v: valueAt(series, to, "pre") });
  }
  return out;
}

function weighSeries(
  series: readonly SeriesPoint[],
  weight: number,
  earlierWeights: readonly { until: number; weight: number }[],
): SeriesPoint[] {
  if (series.length === 0 || earlierWeights.length === 0) {
    return series.map((pt) => ({ t: pt.t, v: weight * pt.v }));
  }
  const weightAt = (t: number, side: "pre" | "post") =>
    earlierWeights.find((e) => (side === "pre" ? t <= e.until : t < e.until))?.weight ?? weight;
  const first = series[0]!.t;
  const last = series[series.length - 1]!.t;
  const changes = new Set(earlierWeights.map((e) => e.until).filter((t) => t > first && t <= last));
  const jumps = new Set(
    series.filter((pt, idx) => idx > 0 && series[idx - 1]!.t === pt.t).map((pt) => pt.t),
  );
  const times = Array.from(new Set([...series.map((pt) => pt.t), ...changes])).sort((a, b) => a - b);
  return times.flatMap((t) => {
    const after = { t, v: weightAt(t, "post") * valueAt(series, t, "post") };
    if (!changes.has(t) && !jumps.has(t)) return [after];
    return [{ t, v: weightAt(t, "pre") * valueAt(series, t, "pre") }, after];
  });
}

function sumSeries(inputs: readonly SeriesPoint[][]): SeriesPoint[] {
  const active = inputs.filter((s) => s.length > 0);
  if (active.length === 0) return [];
  const times = new Set<number>();
  const jumpTimes = new Set<number>();
  for (const series of active) {
    for (let i = 0; i < series.length; i++) {
      const pt = series[i]!;
      times.add(pt.t);
      if (i > 0 && series[i - 1]!.t === pt.t) jumpTimes.add(pt.t);
    }
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const total = (t: number, side: "pre" | "post") =>
    active.reduce((sum, s) => sum + valueAt(s, t, side), 0);
  const out: SeriesPoint[] = [];
  for (const t of sorted) {
    if (jumpTimes.has(t)) {
      out.push({ t, v: total(t, "pre") });
      out.push({ t, v: total(t, "post") });
    } else {
      out.push({ t, v: total(t, "post") });
    }
  }
  return out;
}

function consumedBetween(series: readonly SeriesPoint[], a: number, b: number): number {
  if (series.length < 2 || b <= a) return 0;
  let consumed = 0;
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1]!;
    const q = series[i]!;
    if (q.t <= a || p.t >= b || q.t === p.t) continue;
    const start = Math.max(a, p.t);
    const end = Math.min(b, q.t);
    const slope = (q.v - p.v) / (q.t - p.t);
    const drop = -slope * (end - start);
    if (drop > 0) consumed += drop;
  }
  return consumed;
}

function upcomingReset(resetAtMs: number | null, nowMs: number): number | null {
  if (resetAtMs === null) return null;
  if (resetAtMs > nowMs) return resetAtMs;
  return resetAtMs + Math.ceil((nowMs - resetAtMs + 1) / WEEK_MS) * WEEK_MS;
}

interface SimAccount {
  weight: number;
  remaining: number;
  share: number;
  nextReset: number | null;
}

function projectPool(
  accounts: readonly { weight: number; remaining: number; burnRate: number | null; nextReset: number | null }[],
  poolRate: number,
  start: number,
  end: number,
): {
  series: SeriesPoint[];
  nextReset: { t: number; amount: number } | null;
  emptyAt: number | null;
} {
  const sim: SimAccount[] = accounts.map((a) => ({
    weight: a.weight,
    remaining: clampPct(a.remaining),
    share: Math.max(0, a.burnRate ?? 0) * a.weight,
    nextReset: a.nextReset !== null && a.nextReset > start ? a.nextReset : null,
  }));
  const poolValue = () => sim.reduce((s, a) => s + a.weight * a.remaining, 0);
  const series: SeriesPoint[] = [{ t: start, v: poolValue() }];
  let nextReset: { t: number; amount: number } | null = null;
  let emptyAt: number | null = poolValue() <= EPSILON ? start : null;

  const rate = Math.max(0, poolRate);
  let t = start;

  for (let guard = 0; guard < 1000 && t < end; guard++) {
    const nonEmpty = sim.filter((a) => a.remaining > EPSILON);
    const ownRate = new Map<SimAccount, number>();
    if (rate > 0 && nonEmpty.length > 0) {
      const withShare = nonEmpty.filter((a) => a.share > 0);
      const carriers = withShare.length > 0 ? withShare : nonEmpty;
      const total = carriers.reduce((s, a) => s + (withShare.length > 0 ? a.share : a.weight), 0);
      if (total > 0) {
        for (const a of carriers) {
          const share = withShare.length > 0 ? a.share : a.weight;
          ownRate.set(a, (rate * share) / total / a.weight);
        }
      }
    }

    let flowing = 0;
    for (const [a, own] of ownRate) {
      flowing += own * a.weight;
      if (own > 0 && a.nextReset === null) a.nextReset = t + WEEK_MS;
    }

    let next = end;
    for (const a of sim) {
      if (a.nextReset !== null && a.nextReset < next) next = a.nextReset;
    }
    for (const [a, own] of ownRate) {
      if (own <= 0) continue;
      const eAt = t + (a.remaining / own) * HOUR_MS;
      if (eAt < next) next = eAt;
    }
    next = Math.max(next, t);

    const hours = (next - t) / HOUR_MS;
    for (const [a, own] of ownRate) {
      a.remaining = Math.max(0, a.remaining - own * hours);
      if (a.remaining < 1e-4) a.remaining = 0;
    }
    t = next;
    series.push({ t, v: poolValue() });

    if (emptyAt === null && flowing > 0 && poolValue() <= EPSILON) {
      emptyAt = t;
    }

    const due = sim.filter((a) => a.nextReset !== null && a.nextReset <= t + 1);
    if (due.length > 0) {
      let amount = 0;
      for (const a of due) {
        amount += a.weight * (100 - a.remaining);
        a.remaining = 100;
        let following = (a.nextReset as number) + WEEK_MS;
        while (following <= t) following += WEEK_MS;
        a.nextReset = following;
      }
      series.push({ t, v: poolValue() });
      if (amount > 0.5) {
        if (nextReset === null) {
          nextReset = { t, amount };
        } else if (t - nextReset.t <= RESET_MERGE_MS) {
          nextReset.amount += amount;
        }
      }
    }
  }

  return { series, nextReset, emptyAt };
}

/**
 * Downsamples a piecewise-linear series to at most `maxPoints` while always
 * keeping endpoints and every instantaneous reset jump (duplicate-`t` pairs).
 */
function compactSeries(series: readonly SeriesPoint[], maxPoints: number): PoolPoint[] {
  if (series.length <= maxPoints) {
    return series.map((pt) => ({ at: new Date(pt.t).toISOString(), remaining: round2(Math.max(0, pt.v)) }));
  }

  // Split into continuous segments between instantaneous jumps so jumps stay crisp.
  const kept = new Set<number>([0, series.length - 1]);
  for (let i = 1; i < series.length; i++) {
    if (series[i]!.t === series[i - 1]!.t) {
      kept.add(i - 1);
      kept.add(i);
    }
  }

  const budget = Math.max(0, maxPoints - kept.size);
  if (budget > 0) {
    const startT = series[0]!.t;
    const endT = series[series.length - 1]!.t;
    const span = endT - startT;
    if (span > 0) {
      const step = span / (budget + 1);
      let cursor = 0;
      for (let k = 1; k <= budget; k++) {
        const target = startT + step * k;
        while (cursor + 1 < series.length && series[cursor + 1]!.t < target) cursor++;
        kept.add(cursor);
      }
    }
  }

  return Array.from(kept)
    .sort((a, b) => a - b)
    .map((idx) => {
      const pt = series[idx]!;
      return { at: new Date(pt.t).toISOString(), remaining: round2(Math.max(0, pt.v)) };
    });
}

function resolvePlans(samples: readonly QuotaPoint[], explicitPlan: string | null): {
  currentPlan: string;
  planChanges: { t: number; plan: string }[];
} {
  let latestSpecific = "";
  for (const s of samples) {
    const pl = s.plan?.trim().toLowerCase() || "";
    if (pl && pl !== "max") latestSpecific = pl;
  }
  const explicit = explicitPlan?.trim().toLowerCase() || "";
  const currentPlan = explicit || latestSpecific || (samples[samples.length - 1]?.plan?.trim().toLowerCase() ?? "");

  const planChanges: { t: number; plan: string }[] = [];
  for (const s of samples) {
    const raw = s.plan?.trim().toLowerCase() || "";
    if (!raw) continue;
    const normalized = raw === "max" && currentPlan.startsWith("max") ? currentPlan : raw;
    const prev = planChanges[planChanges.length - 1];
    if (!prev) {
      planChanges.push({ t: s.tsMs, plan: normalized });
    } else if (isPlanTierChange(prev.plan, normalized)) {
      planChanges.push({ t: s.tsMs, plan: normalized });
    }
  }
  return { currentPlan, planChanges };
}

/**
 * Computes compact weekly quota pool summaries (available %, 6h burn %/h,
 * next refill, projected empty time, and recorded + projected sparklines)
 * grouped by provider.
 */
export function buildPoolStatuses(
  inputs: readonly PoolAccountInput[],
  nowMs: number,
  providersFilter: readonly string[] | null = null,
): PoolStatus[] {
  const filterSet = providersFilter ? new Set(providersFilter.map((p) => p.toLowerCase())) : null;
  const byProvider = new Map<string, { clean: QuotaPoint[]; currentPlan: string; planChanges: { t: number; plan: string }[] }[]>();

  for (const acc of inputs) {
    if (acc.ignored) continue;
    const provider = acc.provider.trim().toLowerCase();
    if (!provider) continue;
    if (filterSet && !filterSet.has(provider)) continue;

    const clean = filterGlitchSamples(acc.samples);
    if (clean.length === 0) continue;
    const latest = clean[clean.length - 1]!;
    if (nowMs - latest.tsMs > ACTIVE_SAMPLE_MAX_AGE_MS) continue;

    const { currentPlan, planChanges } = resolvePlans(clean, acc.explicitPlan);
    let list = byProvider.get(provider);
    if (!list) byProvider.set(provider, (list = []));
    list.push({ clean, currentPlan, planChanges });
  }

  const recordedFrom = nowMs - RECORDED_WINDOW_DAYS * DAY_MS;
  const historyFrom = Math.min(recordedFrom, nowMs - BURN_WINDOW_HOURS * HOUR_MS);
  const projectedTo = nowMs + PROJECTED_WINDOW_DAYS * DAY_MS;
  const horizonEnd = nowMs + HORIZON_DAYS * DAY_MS;

  const out: PoolStatus[] = [];
  const providers = [...byProvider.keys()].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a);
    const ib = PROVIDER_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });

  for (const provider of providers) {
    const accounts = byProvider.get(provider)!;
    const weights = defaultPlanWeights(
      provider,
      accounts.map((a) => a.currentPlan),
      accounts.flatMap((a) => a.planChanges.map((c) => c.plan)),
    );
    const weightOf = (plan: string) => weights.get(plan) ?? 1;

    const prepared = accounts.map((acc) => {
      const weight = weightOf(acc.currentPlan);
      const earlierWeights = acc.planChanges.slice(1).map((next, idx) => ({
        until: next.t,
        weight: weightOf(acc.planChanges[idx]!.plan),
      }));
      const series = buildRecordedSeries(acc.clean, historyFrom, nowMs);
      const pooled = weighSeries(series, weight, earlierWeights);
      const remaining = series.length > 0 ? valueAt(series, nowMs, "post") : 0;

      const latest = acc.clean[acc.clean.length - 1]!;
      const burnEnd = Math.min(nowMs, latest.tsMs);
      const burnStart = Math.max(nowMs - BURN_WINDOW_HOURS * HOUR_MS, acc.clean[0]!.tsMs);
      const pooledBurn =
        burnEnd - burnStart >= MIN_BURN_SPAN_MS
          ? consumedBetween(pooled, burnStart, burnEnd) / ((burnEnd - burnStart) / HOUR_MS)
          : null;
      const burnRate = pooledBurn === null ? null : pooledBurn / weight;
      const nextReset = upcomingReset(latest.resetAtMs, nowMs);
      return { weight, pooled, remaining, burnRate, nextReset };
    });

    const capacity = prepared.reduce((s, a) => s + a.weight * 100, 0);
    const remaining = prepared.reduce((s, a) => s + a.weight * a.remaining, 0);
    const rated = prepared.filter((a) => a.burnRate !== null);
    const burnRate =
      rated.length > 0 ? rated.reduce((s, a) => s + a.weight * (a.burnRate as number), 0) : null;

    const recordedRaw = sumSeries(prepared.map((a) => clipSeries(a.pooled, recordedFrom, nowMs)));
    const proj = projectPool(
      prepared.map((a) => ({
        weight: a.weight,
        remaining: a.remaining,
        burnRate: a.burnRate,
        nextReset: a.nextReset,
      })),
      burnRate ?? 0,
      nowMs,
      horizonEnd,
    );
    const projectedVisible = clipSeries(proj.series, nowMs, projectedTo);

    out.push({
      provider,
      accounts: prepared.length,
      remaining: round2(Math.max(0, remaining)),
      capacity: round2(capacity),
      burnPerHour: burnRate === null ? null : round2(Math.max(0, burnRate)),
      nextResetAt: proj.nextReset ? new Date(proj.nextReset.t).toISOString() : null,
      nextResetAmount: proj.nextReset ? round2(proj.nextReset.amount) : null,
      emptyAt: proj.emptyAt !== null ? new Date(proj.emptyAt).toISOString() : null,
      recorded: compactSeries(recordedRaw, MAX_RECORDED_POINTS),
      projected: compactSeries(projectedVisible, MAX_RECORDED_POINTS),
    });
  }

  return out;
}
