// Runtime check that a value has exactly the shape of `Board` in src/shared/api.ts.
// TypeScript checks the code that builds a board; this checks what is on the wire.

import type { Board } from "../../shared/api.ts";

type Spec = string | readonly [Spec] | { readonly [key: string]: Spec };

const TOKENS = { input: "int", cacheRead: "int", cacheWrite: "int", output: "int", reasoning: "int", total: "int" } as const;

const BOARD: Spec = {
  generatedAt: "iso",
  range: "range",
  rangeStart: "iso?",
  timezone: "string",
  costMode: "costMode",
  providers: "providerList?",
  availableProviders: "providerList",
  pools: [
    {
      provider: "string",
      accounts: "int",
      remaining: "number",
      capacity: "number",
      burnPerHour: "number?",
      nextResetAt: "iso?",
      nextResetAmount: "number?",
      emptyAt: "iso?",
      recorded: [{ at: "iso", remaining: "number" }],
      projected: [{ at: "iso", remaining: "number" }],
    },
  ],
  lastEventAt: "iso?",
  collectorLagSeconds: "number?",
  totals: {
    requests: "int",
    failedRequests: "int",
    tokens: TOKENS,
    costUsd: "number?",
    listCostUsd: "number?",
    threads: "int",
    subagents: "int",
    people: "int",
    tokensPerMinuteNow: "number",
  },
  people: [
    {
      id: "slug",
      name: "string",
      unassigned: "boolean",
      rank: "int",
      previousRank: "int?",
      requests: "int",
      failedRequests: "int",
      tokens: TOKENS,
      costUsd: "number?",
      listCostUsd: "number?",
      threads: "int",
      subagents: "int",
      subagentTokenShare: "fraction",
      cacheHitRate: "fraction",
      topModel: "string?",
      activeDays: "int",
      streakDays: "int",
      peakHour: "hour?",
      lastSeenAt: "iso?",
      spark: ["int"],
    },
  ],
  models: [
    {
      model: "string",
      displayName: "string",
      provider: "string",
      requests: "int",
      tokens: TOKENS,
      costUsd: "number?",
      listCostUsd: "number?",
      priced: "boolean",
      topPersonId: "string?",
    },
  ],
  timeline: { unit: "unit", buckets: ["iso"], series: "series" },
  heatmap: [{ weekday: "weekday", hour: "hour", tokens: "int", requests: "int" }],
  awards: [{ id: "slug", title: "string", emoji: "string", blurb: "string", winnerId: "string?", value: "string?", runnerUpId: "string?" }],
  records: [{ id: "slug", title: "string", emoji: "string", value: "string", detail: "string", personId: "string?", at: "iso?" }],
  recent: [{ at: "iso", personId: "string", model: "string", modelName: "string", totalTokens: "int", costUsd: "number?", subagent: "boolean", failed: "boolean" }],
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isIso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);

const SCALARS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string" && v.length > 0,
  number: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  boolean: (v) => typeof v === "boolean",
  int: isInt,
  iso: isIso,
  slug: (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v),
  fraction: (v) => typeof v === "number" && v >= 0 && v <= 1,
  hour: (v) => isInt(v) && v <= 23,
  weekday: (v) => isInt(v) && v <= 6,
  range: (v) => ["today", "7d", "30d", "all"].includes(v as string),
  costMode: (v) => v === "subscription" || v === "list",
  providerList: (v) =>
    Array.isArray(v) && v.every((s) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)),
  unit: (v) => v === "hour" || v === "day",
  series: (v) =>
    typeof v === "object" && v !== null && Object.values(v).every((s) => Array.isArray(s) && s.every(isInt)),
};

function check(value: unknown, spec: Spec, path: string, problems: string[]): void {
  if (typeof spec === "string") {
    const optional = spec.endsWith("?");
    const name = optional ? spec.slice(0, -1) : spec;
    if (value === null && optional) return;
    if (!SCALARS[name]!(value)) problems.push(`${path}: expected ${spec}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) return void problems.push(`${path}: expected an array`);
    value.forEach((item, i) => check(item, spec[0] as Spec, `${path}[${i}]`, problems));
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return void problems.push(`${path}: expected an object`);
  }
  const shape = spec as { readonly [key: string]: Spec };
  const have = Object.keys(value).sort().join(",");
  const want = Object.keys(shape).sort().join(",");
  if (have !== want) problems.push(`${path}: keys are [${have}], contract says [${want}]`);
  for (const [key, sub] of Object.entries(shape)) {
    if (key in value) check((value as Record<string, unknown>)[key], sub, `${path}.${key}`, problems);
  }
}

/** Throws with every deviation from the contract, including the invariants its comments state. */
export function assertBoard(value: unknown): asserts value is Board {
  const problems: string[] = [];
  check(value, BOARD, "board", problems);
  if (problems.length === 0) {
    const b = value as Board;
    const sum = (t: Board["totals"]["tokens"]) => t.input + t.cacheRead + t.cacheWrite + t.output;
    const tokenSets: [string, Board["totals"]["tokens"]][] = [
      ["totals", b.totals.tokens],
      ...b.people.map((p) => [`person ${p.id}`, p.tokens] as [string, Board["totals"]["tokens"]]),
      ...b.models.map((m) => [`model ${m.model}`, m.tokens] as [string, Board["totals"]["tokens"]]),
    ];
    for (const [where, t] of tokenSets) {
      if (t.total !== sum(t)) problems.push(`${where}: total ${t.total} is not the sum of its parts ${sum(t)}`);
      if (t.reasoning > t.output) problems.push(`${where}: reasoning exceeds output`);
    }
    const assigned = b.people.filter((p) => !p.unassigned);
    b.people.forEach((p, i) => {
      // Assigned people first, ranked 1..n by tokens; unassigned rows last and unranked.
      if (p.unassigned) {
        if (i < assigned.length) problems.push(`person ${p.id}: unassigned row before an assigned one`);
        if (p.rank !== 0) problems.push(`person ${p.id}: unassigned but ranked ${p.rank}`);
        if (p.previousRank !== null) problems.push(`person ${p.id}: unassigned but has a previous rank`);
      } else {
        if (p.rank !== i + 1) problems.push(`person ${p.id}: rank ${p.rank} at position ${i}`);
        if (i > 0 && p.tokens.total > b.people[i - 1]!.tokens.total) problems.push(`people are not sorted by tokens at ${p.id}`);
        if (p.previousRank !== null && (p.previousRank < 1 || p.previousRank > assigned.length)) {
          problems.push(`person ${p.id}: previous rank ${p.previousRank} is not a rank among assigned people`);
        }
      }
      if (b.range === "all" && p.previousRank !== null) problems.push(`person ${p.id}: previous rank in range all`);
      if (p.tokens.total === 0 && p.costUsd !== 0) problems.push(`person ${p.id}: no tokens but cost ${p.costUsd}`);
      if (p.spark.length !== b.timeline.buckets.length) problems.push(`person ${p.id}: spark is not aligned with the buckets`);
      if (JSON.stringify(b.timeline.series[p.id]) !== JSON.stringify(p.spark)) problems.push(`person ${p.id}: series differs from spark`);
      if (p.failedRequests > p.requests) problems.push(`person ${p.id}: more failures than requests`);
      if (p.unassigned !== (p.id === "shared")) problems.push(`person ${p.id}: unassigned flag`);
    });
    const previous = assigned.map((p) => p.previousRank).filter((r): r is number => r !== null);
    if (new Set(previous).size !== previous.length) problems.push("two people share a previous rank");
    if (b.totals.people !== assigned.filter((p) => p.requests > 0).length) problems.push("totals.people is not the assigned people with requests");
    if (b.totals.tokens.total === 0 && b.totals.costUsd !== 0) problems.push("totals: no tokens but a cost");
    // Every person id used anywhere resolves in people.
    const known = new Set(b.people.map((p) => p.id));
    const used = [
      ...b.recent.map((e) => e.personId),
      ...b.records.map((r) => r.personId),
      ...b.models.map((m) => m.topPersonId),
      ...b.awards.flatMap((a) => [a.winnerId, a.runnerUpId]),
    ];
    for (const id of used) if (id !== null && !known.has(id)) problems.push(`person id ${id} is used but not listed in people`);
    if (Object.keys(b.timeline.series).length !== b.people.length) problems.push("timeline.series has other ids than people");
    b.models.forEach((m, i) => {
      if (i > 0 && m.tokens.total > b.models[i - 1]!.tokens.total) problems.push(`models are not sorted by tokens at ${m.model}`);
      if (!m.priced && m.costUsd !== null) problems.push(`model ${m.model}: unpriced but has a cost`);
    });
    if ([...b.timeline.buckets].sort().join() !== b.timeline.buckets.join()) problems.push("buckets are not oldest first");
    if (b.timeline.unit !== (b.range === "today" ? "hour" : "day")) problems.push("timeline unit does not match the range");
    if ((b.rangeStart === null) !== (b.range === "all")) problems.push("rangeStart must be null exactly for range all");
    if (b.recent.length > 30) problems.push("more than 30 recent events");
    if ([...b.recent].sort((x, y) => y.at.localeCompare(x.at)).map((e) => e.at).join() !== b.recent.map((e) => e.at).join()) {
      problems.push("recent is not newest first");
    }
    const ids = new Set(b.people.map((p) => p.id));
    for (const a of b.awards) {
      if (a.winnerId === "shared" || a.runnerUpId === "shared") problems.push(`award ${a.id}: the shared key won`);
      if ((a.winnerId === null) !== (a.value === null)) problems.push(`award ${a.id}: winner and value disagree`);
      if (a.winnerId !== null && !ids.has(a.winnerId)) problems.push(`award ${a.id}: winner is not on the board`);
      if (a.winnerId === null && a.runnerUpId !== null) problems.push(`award ${a.id}: runner-up without winner`);
    }
    if (b.awards.length < 10) problems.push(`only ${b.awards.length} awards`);
  }
  if (problems.length > 0) throw new Error(`board does not match the contract:\n  ${problems.join("\n  ")}`);
}
