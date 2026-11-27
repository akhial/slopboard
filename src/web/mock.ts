// Demo data. Used by the page when opened with ?mock=1 and by src/web/dev-server.ts.
//
// Rather than inventing totals, this simulates the request log the real server stores (people
// opening threads, threads spawning subagents, context growing and hitting the prompt cache) and
// then aggregates it the way the contract in src/shared/api.ts describes. Every number on the
// page therefore agrees with every other number, and the log is deterministic: the same moment
// in time always produces the same board, and as the clock moves new requests "arrive".

import type {
  Award,
  Board,
  HeatCell,
  LiveEvent,
  ModelRow,
  PersonRow,
  RangeKey,
  RecordCard,
  TokenCounts,
} from "../shared/api.ts";
import { clockFor, compact, duration, full, pct, usd } from "./format.ts";

export type Scenario = "normal" | "quiet" | "empty" | "never" | "sharedonly" | "lagging" | "stale" | "error" | "flaky";

export const SCENARIOS: readonly { key: Scenario; label: string; hint: string }[] = [
  { key: "normal", label: "Busy week", hint: "Normal chaos, plus one holdout who never touched their key" },
  { key: "quiet", label: "Quiet today", hint: "History on file, zero activity today (open the Today range)" },
  { key: "empty", label: "Day one", hint: "Keys handed out, nobody has blinked yet" },
  { key: "never", label: "No sync", hint: "Empty store and a collector that has never phoned home" },
  { key: "sharedonly", label: "Shared key only", hint: "Traffic exists, all on the mystery shared key" },
  { key: "lagging", label: "Lagging", hint: "Collector running two minutes behind" },
  { key: "stale", label: "Stale", hint: "Collector 47 minutes behind" },
  { key: "flaky", label: "Flaky server", hint: "Loads once, then drops every refresh" },
  { key: "error", label: "Server down", hint: "Dead on arrival" },
];

export function parseScenario(value: string | null | undefined): Scenario {
  return SCENARIOS.find((s) => s.key === value)?.key ?? "normal";
}

const TZ = "Europe/Paris";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HISTORY_DAYS = 64;
const STALE_LAG_SECONDS = 47 * 60 + 12;
const LAGGING_SECONDS = 2 * 60 + 20;

// ---------------------------------------------------------------------------------------------
// Models. Prices are USD per million tokens: [input, cache read, cache write, output].
// The Claude rows follow the public price list (cache write taken as 1.25x input); the Codex row
// is a placeholder and the preview model is deliberately unpriced.

interface ModelDef {
  id: string;
  name: string;
  provider: string;
  price: readonly [number, number, number, number] | null;
  /** Providers without explicit cache writes report uncached input instead. */
  writesCache: boolean;
  reasoning: number;
}

const MODELS: readonly ModelDef[] = [
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", provider: "anthropic", price: [8, 0.2, 10, 40], writesCache: true, reasoning: 0.45 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", price: [4, 0.2, 5, 20], writesCache: true, reasoning: 0.35 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", price: [2, 0.1, 2.5, 10], writesCache: true, reasoning: 0.25 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", price: [0.1, 0.01, 0.125, 0.5], writesCache: true, reasoning: 0.1 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai", price: [1.5, 0.15, 0, 12], writesCache: false, reasoning: 0.6 },
  { id: "codex-nightly-preview", name: "Codex Nightly (preview)", provider: "openai", price: null, writesCache: false, reasoning: 0.5 },
];
const M = { fable: 0, opus: 1, sonnet: 2, haiku: 3, codex: 4, preview: 5 } as const;

// ---------------------------------------------------------------------------------------------
// People.

interface Profile {
  id: string;
  name: string;
  unassigned: boolean;
  /** Mean threads on a normal working day. */
  threads: number;
  /** Relative chance of starting a thread in each hour of the day. */
  hours: readonly number[];
  weekend: number;
  /** [model index, weight] */
  models: readonly (readonly [number, number])[];
  subModels: readonly (readonly [number, number])[];
  /** Chance that any one request spawns a subagent. */
  subRate: number;
  /** Median requests per thread. */
  length: number;
  failRate: number;
  cacheSkill: number;
  /** First day with traffic, in days before today. */
  joined: number;
  /** Forced active for this many days up to today and off for the two days before. -1: leave it to chance. */
  streak: number;
  /** Multiplier on thread count by days-ago, for rank changes between windows. */
  trend: (daysAgo: number) => number;
}

function hours(spec: Record<string, number>, base = 0): number[] {
  const out = new Array<number>(24).fill(base);
  for (const [span, weight] of Object.entries(spec)) {
    const [a, b] = span.split("-").map(Number);
    const from = a ?? 0;
    const to = b ?? from;
    for (let h = from; h <= to; h++) out[h] = weight;
  }
  return out;
}

const PEOPLE: readonly Profile[] = [
  {
    id: "mira",
    name: "Mira",
    unassigned: false,
    threads: 5.2,
    hours: hours({ "0-2": 7, "3-3": 3, "10-12": 1, "13-18": 2, "19-20": 4, "21-23": 9 }, 0.05),
    weekend: 0.45,
    models: [[M.fable, 8], [M.opus, 2]],
    subModels: [[M.haiku, 5], [M.sonnet, 4], [M.fable, 1]],
    subRate: 0.034,
    length: 46,
    failRate: 0.012,
    cacheSkill: 0.985,
    joined: HISTORY_DAYS,
    streak: 23,
    trend: () => 1,
  },
  {
    id: "tobias",
    name: "Tobias",
    unassigned: false,
    threads: 5.6,
    hours: hours({ "8-8": 3, "9-12": 9, "13-13": 3, "14-17": 8, "18-18": 2 }, 0.02),
    weekend: 0.3,
    models: [[M.opus, 6], [M.sonnet, 3], [M.fable, 1]],
    subModels: [[M.haiku, 7], [M.sonnet, 3]],
    subRate: 0.02,
    length: 40,
    failRate: 0.006,
    cacheSkill: 0.997,
    joined: HISTORY_DAYS,
    streak: 31,
    trend: () => 1,
  },
  {
    id: "yuki",
    name: "Yuki",
    unassigned: false,
    threads: 4.6,
    hours: hours({ "6-6": 4, "7-11": 9, "12-14": 4, "15-16": 1 }, 0.03),
    weekend: 1.5,
    models: [[M.codex, 7], [M.preview, 2], [M.sonnet, 1]],
    subModels: [[M.codex, 1]],
    subRate: 0.008,
    length: 36,
    failRate: 0.018,
    cacheSkill: 0.8,
    joined: HISTORY_DAYS,
    streak: 9,
    trend: () => 1,
  },
  {
    id: "rafa",
    name: "Rafa",
    unassigned: false,
    threads: 2.6,
    hours: hours({ "11-13": 3, "14-19": 8, "20-22": 5 }, 0.05),
    weekend: 0.6,
    models: [[M.sonnet, 5], [M.fable, 3], [M.haiku, 2]],
    subModels: [[M.haiku, 8], [M.sonnet, 2]],
    subRate: 0.075,
    length: 30,
    failRate: 0.04,
    cacheSkill: 0.95,
    joined: 51,
    streak: 12,
    // Discovered subagents last week and has not been the same since.
    trend: (d) => (d < 7 ? 2.4 : 1),
  },
  {
    id: "nadia",
    name: "Nadia",
    unassigned: false,
    threads: 4.2,
    hours: hours({ "9-11": 6, "12-13": 2, "14-18": 7, "19-21": 2 }, 0.04),
    weekend: 0.25,
    models: [[M.fable, 5], [M.opus, 4], [M.sonnet, 1]],
    subModels: [[M.sonnet, 6], [M.haiku, 4]],
    subRate: 0.04,
    length: 52,
    failRate: 0.01,
    cacheSkill: 0.975,
    joined: 19,
    streak: 2,
    // A monster week right after joining, then a holiday.
    trend: (d) => (d < 7 ? 0.42 : d < 14 ? 2.1 : 1),
  },
  {
    // Was given a key on day one and has not sent a single request with it.
    id: "bram",
    name: "Bram",
    unassigned: false,
    threads: 0,
    hours: hours({}, 1),
    weekend: 0,
    models: [[M.sonnet, 1]],
    subModels: [[M.haiku, 1]],
    subRate: 0,
    length: 1,
    failRate: 0,
    cacheSkill: 0.9,
    joined: 0,
    streak: -1,
    trend: () => 1,
  },
  {
    id: "shared",
    name: "Shared key",
    unassigned: true,
    threads: 1.3,
    // A forgotten cron job in the small hours, plus the odd lunchtime mystery.
    hours: hours({ "3-3": 8, "12-12": 2 }, 0.1),
    weekend: 1,
    // Whatever the CI job was pointed at last. Nobody has priced it.
    models: [[M.preview, 1]],
    subModels: [[M.preview, 1]],
    subRate: 0.01,
    length: 12,
    failRate: 0.03,
    cacheSkill: 0.7,
    joined: HISTORY_DAYS,
    streak: -1,
    trend: () => 1,
  },
];

// ---------------------------------------------------------------------------------------------
// Timezone arithmetic for the mock's board timezone.

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});
const offsetCache = new Map<number, number>();

/** Milliseconds to add to a UTC instant to get board wall-clock time. */
function offsetAt(ms: number): number {
  const slot = Math.floor(ms / HOUR);
  const hit = offsetCache.get(slot);
  if (hit !== undefined) return hit;
  const at = slot * HOUR;
  const p: Record<string, number> = {};
  for (const part of partsFmt.formatToParts(new Date(at))) p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  const off = wall - at;
  offsetCache.set(slot, off);
  return off;
}
const localDay = (ms: number) => Math.floor((ms + offsetAt(ms)) / DAY);
const localHour = (ms: number) => Math.floor((ms + offsetAt(ms)) / HOUR) % 24;
/** 0 = Monday. The epoch began on a Thursday. */
const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;
function dayStart(day: number): number {
  const guess = day * DAY - offsetAt(day * DAY);
  return day * DAY - offsetAt(guess);
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness.

function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed || 1;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  between(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.between(a, b + 1));
  }
  normal(): number {
    return Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
  }
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit && k < 60);
    return k - 1;
  }
  weighted<T>(options: readonly (readonly [T, number])[], fallback: T): T {
    let sum = 0;
    for (const [, w] of options) sum += w;
    let roll = this.next() * sum;
    for (const [value, w] of options) {
      roll -= w;
      if (roll <= 0) return value;
    }
    return fallback;
  }
  index(weights: readonly number[]): number {
    let sum = 0;
    for (const w of weights) sum += w;
    let roll = this.next() * sum;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The simulated request log.

interface Ev {
  t: number;
  /** Index into PEOPLE. */
  p: number;
  /** Index into MODELS. */
  m: number;
  inp: number;
  cr: number;
  cw: number;
  out: number;
  rs: number;
  total: number;
  cost: number | null;
  thread: number;
  /** 0 for the root session, otherwise a subagent session id. */
  sub: number;
  failed: boolean;
}

let nextSession = 1;

function session(
  rng: Rng,
  out: Ev[],
  pi: number,
  who: Profile,
  start: number,
  mi: number,
  requests: number,
  thread: number,
  sub: number,
): void {
  const model = MODELS[mi];
  if (!model) return;
  const root = sub === 0;
  let t = start;
  let context = root ? rng.between(16_000, 44_000) : rng.between(7_000, 24_000);
  let cached = 0;
  const compactAt = root ? rng.between(320_000, 880_000) : rng.between(90_000, 180_000);
  for (let i = 0; i < requests; i++) {
    let gap = 5_000 + rng.exp(root ? 34_000 : 14_000);
    if (root && rng.next() < 0.03) gap += rng.between(6, 28) * 60_000; // went for coffee
    t += gap;
    if (rng.next() < who.failRate) {
      out.push({ t, p: pi, m: mi, inp: 0, cr: 0, cw: 0, out: 0, rs: 0, total: 0, cost: model.price ? 0 : null, thread, sub, failed: true });
      continue;
    }
    if (i > 0) context += rng.next() < 0.06 ? rng.between(18_000, 70_000) : rng.between(300, 6_500);
    if (context > compactAt) {
      context = rng.between(38_000, 90_000);
      cached = 0;
    }
    const expired = gap > 5 * 60_000;
    const cr = expired ? 0 : Math.round(Math.min(cached, context) * who.cacheSkill * rng.between(0.97, 1));
    const fresh = Math.max(0, context - cr);
    const tail = Math.min(fresh, Math.round(rng.between(20, 2_400)));
    const cw = model.writesCache ? Math.round(fresh - tail) : 0;
    const inp = Math.round(model.writesCache ? tail : fresh);
    const output = Math.round(Math.min(24_000, rng.logNormal(root ? 620 : 380, 1.05)) + 40);
    const rs = Math.round(Math.min(output * 0.92, output * model.reasoning * rng.between(0.4, 1.5)));
    const total = inp + cr + cw + output;
    const price = model.price;
    const cost = price ? (inp * price[0] + cr * price[1] + cw * price[2] + output * price[3]) / 1e6 : null;
    out.push({ t, p: pi, m: mi, inp, cr, cw, out: output, rs, total, cost, thread, sub, failed: false });
    cached = context;
    context += output;
    if (root && i < requests - 1 && rng.next() < who.subRate) {
      // Rafa-style fan-out: sometimes one request launches a whole swarm.
      const swarm = rng.next() < who.subRate * 1.6 ? rng.int(3, 9) : 1;
      for (let k = 0; k < swarm; k++) {
        const subModel = rng.weighted(who.subModels, mi);
        const length = Math.max(3, Math.min(60, Math.round(rng.logNormal(11, 0.7))));
        session(rng, out, pi, who, t + rng.between(500, 4_000), subModel, length, thread, nextSession++);
      }
    }
  }
}

function simulateDay(out: Ev[], pi: number, who: Profile, day: number, daysAgo: number): void {
  if (daysAgo >= who.joined) return;
  const rng = new Rng(hashSeed("day", who.id, day));
  const wd = weekdayOf(day);
  const weekend = wd >= 5 ? who.weekend : 1;
  const forcedOn = daysAgo < who.streak;
  // Two days off, because a night owl's thread happily runs past midnight into the next day.
  if (who.streak >= 0 && (daysAgo === who.streak || daysAgo === who.streak + 1)) return;
  if (!forcedOn && rng.next() < 0.07) return;
  let count = rng.poisson(who.threads * weekend * who.trend(daysAgo));
  if (forcedOn && count === 0) count = 1;
  const start = dayStart(day);
  for (let i = 0; i < count; i++) {
    const hour = rng.index(who.hours);
    const at = start + hour * HOUR + rng.between(0, HOUR);
    const length = Math.max(2, Math.min(420, Math.round(rng.logNormal(who.length, 0.95))));
    session(rng, out, pi, who, at, rng.weighted(who.models, 0), length, nextSession++, 0);
  }
  // Demo mode never sleeps: for the two most recent days somebody is always poking at something,
  // so the live feed and the tokens-per-minute gauge move whenever the page is opened.
  if (daysAgo <= 1 && !who.unassigned) {
    for (let slot = 0; slot < 288; slot++) {
      const drip = new Rng(hashSeed("drip", day, slot));
      const pick = drip.int(0, PEOPLE.length - 2);
      if (pick !== pi || drip.next() > 0.85) continue;
      const at = start + slot * 5 * 60_000 + drip.between(0, 2 * 60_000);
      // All of one person's pokes within two hours belong to the same thread.
      const thread = 1e9 + pi * 1e6 + (day % 1000) * 100 + Math.floor(slot / 24);
      session(drip, out, pi, who, at, drip.weighted(who.models, 0), drip.int(4, 11), thread, 0);
    }
  }
}

interface World {
  today: number;
  events: Ev[];
  /** The same log with only the unassigned traffic, for the "shared key only" scenario. */
  sharedOnly?: Ev[];
}
let world: World | null = null;

function getWorld(now: number): World {
  const today = localDay(now);
  if (world && world.today === today) return world;
  const events: Ev[] = [];
  nextSession = 1;
  // The whole of today is simulated up front; boards only ever look at requests up to "now".
  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
    PEOPLE.forEach((who, pi) => simulateDay(events, pi, who, today - daysAgo, daysAgo));
  }
  events.sort((a, b) => a.t - b.t);
  world = { today, events };
  return world;
}

/** First index with t >= ms. */
function lowerBound(events: readonly Ev[], ms: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid]?.t ?? Infinity) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// Aggregation, mirroring what the server computes.

interface Agg {
  requests: number;
  failed: number;
  inp: number;
  cr: number;
  cw: number;
  out: number;
  rs: number;
  total: number;
  cost: number;
  priced: boolean;
  threads: Set<number>;
  subs: Set<number>;
  subTokens: number;
  byModel: number[];
  days: Set<number>;
  byHour: number[];
  night: number;
  weekend: number;
  last: number;
  spark: number[];
}

function newAgg(buckets: number): Agg {
  return {
    requests: 0,
    failed: 0,
    inp: 0,
    cr: 0,
    cw: 0,
    out: 0,
    rs: 0,
    total: 0,
    cost: 0,
    priced: false,
    threads: new Set(),
    subs: new Set(),
    subTokens: 0,
    byModel: new Array<number>(MODELS.length).fill(0),
    days: new Set(),
    byHour: new Array<number>(24).fill(0),
    night: 0,
    weekend: 0,
    last: 0,
    spark: new Array<number>(buckets).fill(0),
  };
}

function tokensOf(a: { inp: number; cr: number; cw: number; out: number; rs: number; total: number }): TokenCounts {
  return { input: a.inp, cacheRead: a.cr, cacheWrite: a.cw, output: a.out, reasoning: a.rs, total: a.total };
}

function argMax(values: readonly number[]): number | null {
  let best = -1;
  let bestValue = 0;
  values.forEach((v, i) => {
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  });
  return best < 0 ? null : best;
}

interface ThreadAgg {
  tokens: number;
  requests: number;
  first: number;
  last: number;
  p: number;
  byModel: number[];
  subs: Set<number>;
}

const ZERO: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };

interface Window {
  start: number | null;
  startDay: number;
  unit: "hour" | "day";
  buckets: string[];
  previous: [number, number] | null;
}

function windowFor(range: RangeKey, w: World, cut: number): Window {
  const today = w.today;
  if (range === "today") {
    const start = dayStart(today);
    const count = Math.max(1, Math.min(25, Math.floor((cut - start) / HOUR) + 1));
    const buckets = Array.from({ length: count }, (_, i) => new Date(start + i * HOUR).toISOString());
    return { start, startDay: today, unit: "hour", buckets, previous: [dayStart(today - 1), start] };
  }
  let startDay: number;
  let previous: [number, number] | null = null;
  if (range === "all") {
    const first = w.events[0];
    startDay = first ? localDay(first.t) : today;
  } else {
    const days = range === "7d" ? 7 : 30;
    startDay = today - days + 1;
    previous = [dayStart(startDay - days), dayStart(startDay)];
  }
  const buckets: string[] = [];
  for (let d = startDay; d <= today; d++) buckets.push(new Date(dayStart(d)).toISOString());
  return { start: range === "all" ? null : dayStart(startDay), startDay, unit: "day", buckets, previous };
}

function emptyAwards(): Award[] {
  return AWARDS.map((a) => ({ id: a.id, title: a.title, emoji: a.emoji, blurb: a.blurb, winnerId: null, value: null, runnerUpId: null }));
}

interface AwardDef {
  id: string;
  title: string;
  emoji: string;
  blurb: string;
  /** Score for one person, or null when they do not qualify. */
  score: (a: Agg, streak: number) => number | null;
  format: (score: number) => string;
}

const AWARDS: readonly AwardDef[] = [
  {
    id: "furnace",
    title: "The Incinerator",
    emoji: "🔥",
    blurb: "Burned more tokens than anyone else. The proxy fan has a personal vendetta.",
    score: (a) => a.total || null,
    format: (v) => `${compact(v)} tokens`,
  },
  {
    id: "middle-manager",
    title: "Swivel-Chair CTO",
    emoji: "📋",
    blurb: "Spawned the most subagents and supervised them from a safe emotional distance.",
    score: (a) => a.subs.size || null,
    format: (v) => `${full(v)} ${v === 1 ? "subagent" : "subagents"}`,
  },
  {
    id: "night-owl",
    title: "Circadian Felony",
    emoji: "🦇",
    blurb: "Largest share of tokens between midnight and 5am, when normal people sleep.",
    score: (a) => (a.total > 1e6 && a.night / a.total > 0.05 ? a.night / a.total : null),
    format: (v) => `${pct(v)} past midnight`,
  },
  {
    id: "cache-goblin",
    title: "Broken Record",
    emoji: "📼",
    blurb: "Highest share of prompt tokens served straight from cache. Refuses to change the subject.",
    score: (a) => (a.requests >= 20 && a.inp + a.cr + a.cw > 0 ? a.cr / (a.inp + a.cr + a.cw) : null),
    format: (v) => `${(v * 100).toFixed(1)}% from cache`,
  },
  {
    id: "big-spender",
    title: "Why Plans Have Caps",
    emoji: "🧾",
    blurb: "Burned the biggest share of the team's subscription budget. Single-handedly justifying the next tier upgrade.",
    score: (a) => (a.priced && a.cost > 0 ? a.cost / 50 : null),
    format: (v) => `${usd(v)} real spend`,
  },
  {
    id: "yapper",
    title: "The Paper Mill",
    emoji: "🖨️",
    blurb: "Most output tokens per request. Good luck reviewing that PR.",
    score: (a) => (a.requests - a.failed >= 20 ? a.out / (a.requests - a.failed) : null),
    format: (v) => `${compact(v)} out / req`,
  },
  {
    id: "error-magnet",
    title: "Walking Outage",
    emoji: "🧯",
    blurb: "Ended the most requests in a flat-out error. Whatever they're asking, the API is scared.",
    score: (a) => (a.failed >= 3 ? a.failed : null),
    format: (v) => `${full(v)} failed requests`,
  },
  {
    id: "marathon",
    title: "Daily Dependency",
    emoji: "🔗",
    blurb: "Longest unbroken streak of days sending prompts. Medically concerning.",
    score: (_a, streak) => (streak >= 3 ? streak : null),
    format: (v) => `${v} days straight`,
  },
  {
    id: "weekend-warrior",
    title: "No Weekend Plans",
    emoji: "☀️",
    blurb: "Burned the most tokens on Saturday and Sunday. The outdoors remains theoretical.",
    score: (a) => (a.weekend > 1e6 ? a.weekend : null),
    format: (v) => `${compact(v)} weekend tokens`,
  },
  {
    id: "clean-sheet",
    title: "Teacher's Pet",
    emoji: "🧼",
    blurb: "500 requests or more without a single error. Suspiciously polite prompts.",
    score: (a) => (a.requests >= 500 && a.failed === 0 ? a.requests : null),
    format: (v) => `${full(v)} clean requests`,
  },
];

/** A row for someone with no activity in the range. */
function idleRow(who: Profile, rank: number, buckets: number): PersonRow {
  return {
    id: who.id,
    name: who.name,
    unassigned: who.unassigned,
    rank,
    previousRank: null,
    requests: 0,
    failedRequests: 0,
    tokens: { ...ZERO },
    costUsd: 0,
    listCostUsd: 0,
    threads: 0,
    subagents: 0,
    subagentTokenShare: 0,
    cacheHitRate: 0,
    topModel: null,
    activeDays: 0,
    streakDays: 0,
    peakHour: null,
    lastSeenAt: null,
    spark: new Array<number>(buckets).fill(0),
  };
}

/** Nothing stored yet. With `registered`, keys have been handed out; without, nobody exists. */
function emptyBoard(range: RangeKey, now: number, registered: boolean, providers: string[] | null = null): Board {
  const w = getWorld(now);
  const win = windowFor(range, { today: w.today, events: [] }, now);
  const people = registered
    ? PEOPLE.filter((who) => !who.unassigned)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((who, i) => idleRow(who, i + 1, win.buckets.length))
    : [];
  const series: Record<string, number[]> = {};
  for (const row of people) series[row.id] = row.spark;
  return {
    generatedAt: new Date(now).toISOString(),
    range,
    rangeStart: win.start === null ? null : new Date(win.start).toISOString(),
    timezone: TZ,
    costMode: "subscription",
    availableProviders: [],
    providers,
    lastEventAt: null,
    collectorLagSeconds: registered ? 4 : null,
    totals: { requests: 0, failedRequests: 0, tokens: { ...ZERO }, costUsd: 0, listCostUsd: 0, threads: 0, subagents: 0, people: 0, tokensPerMinuteNow: 0 },
    people,
    models: [],
    timeline: { unit: win.unit, buckets: win.buckets, series },
    heatmap: [],
    awards: emptyAwards(),
    records: [],
    recent: [],
  };
}

/** The board as the server would compute it at `now`. */
export function mockBoard(
  range: RangeKey,
  scenario: Scenario = "normal",
  providers: readonly string[] | null = null,
  now: number = Date.now(),
): Board {
  const activeProviders =
    providers && providers.length > 0 ? [...new Set(providers.map((p) => p.trim().toLowerCase()).filter(Boolean))].sort() : null;
  if (scenario === "empty" || scenario === "never") return emptyBoard(range, now, scenario === "empty", activeProviders);
  const w = getWorld(now);
  const clock = clockFor(TZ);
  const lag = scenario === "stale" ? STALE_LAG_SECONDS : scenario === "lagging" ? LAGGING_SECONDS : 0;
  // "quiet" pretends the latest request was yesterday evening, so a today window is empty.
  const cut = lag ? now - lag * 1000 : scenario === "quiet" ? dayStart(w.today) - 5 * HOUR : now;
  if (scenario === "sharedonly") w.sharedOnly ??= w.events.filter((e) => PEOPLE[e.p]?.unassigned);
  const baseEvents = scenario === "sharedonly" ? (w.sharedOnly ?? []) : w.events;
  const availableProviders = [...new Set(MODELS.map((m) => m.provider.toLowerCase()))].sort();
  const events = activeProviders
    ? baseEvents.filter((e) => {
        const prov = MODELS[e.m]?.provider.toLowerCase();
        return prov !== undefined && activeProviders.includes(prov);
      })
    : baseEvents;
  const end = lowerBound(events, cut + 1);
  const win = windowFor(range, { today: w.today, events }, scenario === "quiet" ? now : cut);
  const begin = win.start === null ? 0 : lowerBound(events, win.start);
  const bucketCount = win.buckets.length;

  const aggs = PEOPLE.map(() => newAgg(bucketCount));
  const team = newAgg(0);
  const modelAggs = MODELS.map(() => ({ requests: 0, inp: 0, cr: 0, cw: 0, out: 0, rs: 0, total: 0, cost: 0, byPerson: new Array<number>(PEOPLE.length).fill(0) }));
  const threads = new Map<number, ThreadAgg>();
  const hourSlots = new Map<number, { tokens: number; requests: number; people: Set<number> }>();
  let fattest: Ev | null = null;
  let priciest: Ev | null = null;

  for (let i = begin; i < end; i++) {
    const e = events[i];
    if (!e) continue;
    const a = aggs[e.p];
    const ma = modelAggs[e.m];
    if (!a || !ma) continue;
    const day = localDay(e.t);
    const hour = localHour(e.t);
    const bucket = win.unit === "hour" ? Math.floor((e.t - (win.start ?? 0)) / HOUR) : day - win.startDay;
    for (const target of [a, team]) {
      target.requests++;
      if (e.failed) target.failed++;
      target.inp += e.inp;
      target.cr += e.cr;
      target.cw += e.cw;
      target.out += e.out;
      target.rs += e.rs;
      target.total += e.total;
      if (e.cost !== null) {
        target.cost += e.cost;
        target.priced = true;
      }
      target.threads.add(e.thread);
      if (e.sub) {
        target.subs.add(e.sub);
        target.subTokens += e.total;
      }
    }
    a.byModel[e.m] = (a.byModel[e.m] ?? 0) + e.total;
    a.days.add(day);
    a.byHour[hour] = (a.byHour[hour] ?? 0) + e.total;
    if (hour < 5) a.night += e.total;
    if (weekdayOf(day) >= 5) a.weekend += e.total;
    a.last = e.t;
    if (bucket >= 0 && bucket < bucketCount) a.spark[bucket] = (a.spark[bucket] ?? 0) + e.total;

    ma.requests++;
    ma.inp += e.inp;
    ma.cr += e.cr;
    ma.cw += e.cw;
    ma.out += e.out;
    ma.rs += e.rs;
    ma.total += e.total;
    if (e.cost !== null) ma.cost += e.cost;
    ma.byPerson[e.p] = (ma.byPerson[e.p] ?? 0) + e.total;

    let th = threads.get(e.thread);
    if (!th) {
      th = { tokens: 0, requests: 0, first: e.t, last: e.t, p: e.p, byModel: new Array<number>(MODELS.length).fill(0), subs: new Set() };
      threads.set(e.thread, th);
    }
    th.tokens += e.total;
    th.requests++;
    th.last = e.t;
    th.byModel[e.m] = (th.byModel[e.m] ?? 0) + e.total;
    if (e.sub) th.subs.add(e.sub);

    const slot = Math.floor(e.t / HOUR);
    let hs = hourSlots.get(slot);
    if (!hs) {
      hs = { tokens: 0, requests: 0, people: new Set() };
      hourSlots.set(slot, hs);
    }
    hs.tokens += e.total;
    hs.requests++;
    hs.people.add(e.p);

    if (!fattest || e.total > fattest.total) fattest = e;
    if (e.cost !== null && (!priciest || e.cost > (priciest.cost ?? 0))) priciest = e;
  }

  // Rank in the preceding window of the same length: assigned people who had tokens then.
  const previousRank = new Map<number, number>();
  if (win.previous) {
    const totals = new Array<number>(PEOPLE.length).fill(0);
    const hi = Math.min(end, lowerBound(events, win.previous[1]));
    for (let i = lowerBound(events, win.previous[0]); i < hi; i++) {
      const e = events[i];
      if (e) totals[e.p] = (totals[e.p] ?? 0) + e.total;
    }
    totals
      .map((total, p) => ({ total, p }))
      .filter((x) => x.total > 0 && !PEOPLE[x.p]?.unassigned)
      .sort((x, y) => y.total - x.total)
      .forEach((x, i) => previousRank.set(x.p, i + 1));
  }

  // Streaks and the heatmap look at all time and the last 28 days, whatever the range.
  const activeDays = PEOPLE.map(() => new Set<number>());
  const lastSeen = new Array<number>(PEOPLE.length).fill(0);
  const heatFrom = dayStart(w.today - 27);
  const heat = new Map<number, HeatCell>();
  for (let i = 0; i < end; i++) {
    const e = events[i];
    if (!e) continue;
    const day = localDay(e.t);
    activeDays[e.p]?.add(day);
    lastSeen[e.p] = e.t;
    if (e.t >= heatFrom) {
      const weekday = weekdayOf(day);
      const hour = localHour(e.t);
      const key = weekday * 24 + hour;
      const cell = heat.get(key) ?? { weekday, hour, tokens: 0, requests: 0 };
      cell.tokens += e.total;
      cell.requests++;
      heat.set(key, cell);
    }
  }
  const streaks = PEOPLE.map((_, p) => {
    let n = 0;
    while (activeDays[p]?.has(w.today - n)) n++;
    return n;
  });

  // Every registered person gets a row, active or not: assigned people in rank order, then the
  // shared key if it has ever had traffic. Only assigned people are ranked.
  const byTokens = (x: number, y: number) =>
    (aggs[y]?.total ?? 0) - (aggs[x]?.total ?? 0) || (aggs[y]?.requests ?? 0) - (aggs[x]?.requests ?? 0) || (PEOPLE[x]?.id ?? "").localeCompare(PEOPLE[y]?.id ?? "");
  const assigned = PEOPLE.map((_, p) => p)
    .filter((p) => !PEOPLE[p]?.unassigned)
    .sort(byTokens);
  const unassigned = PEOPLE.map((_, p) => p).filter((p) => PEOPLE[p]?.unassigned && (lastSeen[p] ?? 0) > 0);

  const row = (p: number, rank: number): PersonRow => {
    const who = PEOPLE[p];
    const a = aggs[p] ?? newAgg(bucketCount);
    const top = argMax(a.byModel);
    const denominator = a.inp + a.cr + a.cw;
    const seen = lastSeen[p] ?? 0;
    return {
      id: who?.id ?? "unknown",
      name: who?.name ?? "Unknown",
      unassigned: who?.unassigned ?? true,
      rank,
      previousRank: rank === 0 || range === "all" ? null : (previousRank.get(p) ?? null),
      requests: a.requests,
      failedRequests: a.failed,
      tokens: tokensOf(a),
      // 0 when there was nothing to price; null only for tokens nobody has a price for.
      costUsd: a.total === 0 ? 0 : a.priced ? a.cost / 50 : null,
      listCostUsd: a.total === 0 ? 0 : a.priced ? a.cost : null,
      threads: a.threads.size,
      subagents: a.subs.size,
      subagentTokenShare: a.total ? a.subTokens / a.total : 0,
      cacheHitRate: denominator ? a.cr / denominator : 0,
      topModel: top === null ? null : (MODELS[top]?.name ?? null),
      activeDays: a.days.size,
      streakDays: streaks[p] ?? 0,
      peakHour: argMax(a.byHour),
      // Over all time, so somebody idle in this range still has a "last seen".
      lastSeenAt: seen ? new Date(seen).toISOString() : null,
      spark: a.spark,
    };
  };
  const people: PersonRow[] = [...assigned.map((p, i) => row(p, i + 1)), ...unassigned.map((p) => row(p, 0))];

  const models: ModelRow[] = modelAggs
    .map((ma, m) => ({ ma, m }))
    .filter((x) => x.ma.requests > 0)
    .sort((x, y) => y.ma.total - x.ma.total)
    .map(({ ma, m }) => {
      const def = MODELS[m];
      const top = argMax(ma.byPerson);
      return {
        model: def?.id ?? "unknown",
        displayName: def?.name ?? "Unknown",
        provider: def?.provider ?? "unknown",
        requests: ma.requests,
        tokens: tokensOf(ma),
        costUsd: def?.price ? ma.cost / 50 : null,
        listCostUsd: def?.price ? ma.cost : null,
        priced: Boolean(def?.price),
        topPersonId: top === null ? null : (PEOPLE[top]?.id ?? null),
      };
    });

  const series: Record<string, number[]> = {};
  for (const person of people) series[person.id] = person.spark;

  // Awards go to real people who did something in the range.
  const contenders = assigned.map((p) => ({ p, a: aggs[p] ?? newAgg(0) })).filter((x) => x.a.requests > 0);
  const awards: Award[] = AWARDS.map((def) => {
    const scored = contenders
      .map((x) => ({ id: PEOPLE[x.p]?.id ?? null, score: def.score(x.a, streaks[x.p] ?? 0) }))
      .filter((x): x is { id: string; score: number } => x.id !== null && x.score !== null && x.score > 0)
      .sort((x, y) => y.score - x.score);
    const winner = scored[0];
    return {
      id: def.id,
      title: def.title,
      emoji: def.emoji,
      blurb: def.blurb,
      winnerId: winner?.id ?? null,
      value: winner ? def.format(winner.score) : null,
      runnerUpId: scored[1]?.id ?? null,
    };
  });

  const records: RecordCard[] = [];
  const modelOfThread = (th: { byModel: number[] }) => MODELS[argMax(th.byModel) ?? 0]?.name ?? "unknown model";
  let biggest: ThreadAgg | null = null;
  let longest: ThreadAgg | null = null;
  let swarm: ThreadAgg | null = null;
  for (const th of threads.values()) {
    if (!biggest || th.tokens > biggest.tokens) biggest = th;
    // A thread left open over lunch is not a marathon: only count threads that kept going.
    if (th.requests >= 20 && (!longest || th.last - th.first > longest.last - longest.first)) longest = th;
    if (th.subs.size > 0 && (!swarm || th.subs.size > swarm.subs.size)) swarm = th;
  }
  if (biggest && biggest.tokens > 0) {
    records.push({
      id: "biggest-thread",
      title: "One Thread Too Far",
      emoji: "🧵",
      value: `${compact(biggest.tokens)} tokens`,
      detail: `${modelOfThread(biggest)} · ${full(biggest.requests)} requests · ${clock.dayTime(biggest.first)}`,
      personId: PEOPLE[biggest.p]?.id ?? null,
      at: new Date(biggest.first).toISOString(),
    });
  }
  if (fattest && fattest.total > 0) {
    records.push({
      id: "fattest-request",
      title: "Single-Prompt Felony",
      emoji: "🏋️",
      value: `${compact(fattest.total)} tokens`,
      detail: `${MODELS[fattest.m]?.name ?? "unknown model"} · ${pct(fattest.cr / fattest.total)} from cache · ${clock.dayTime(fattest.t)}`,
      personId: PEOPLE[fattest.p]?.id ?? null,
      at: new Date(fattest.t).toISOString(),
    });
  }
  let busiest: { slot: number; tokens: number; requests: number; people: Set<number> } | null = null;
  for (const [slot, hs] of hourSlots) {
    if (!busiest || hs.tokens > busiest.tokens) busiest = { slot, ...hs };
  }
  if (busiest && busiest.tokens > 0) {
    const at = busiest.slot * HOUR;
    records.push({
      id: "busiest-hour",
      title: "Most Unhinged Hour",
      emoji: "⚡",
      value: `${compact(busiest.tokens)} tokens`,
      detail: `${busiest.people.size} ${busiest.people.size === 1 ? "suspect" : "suspects"} · ${full(busiest.requests)} requests · ${clock.dayTime(at)}`,
      personId: null,
      at: new Date(at).toISOString(),
    });
  }
  if (swarm) {
    records.push({
      id: "biggest-swarm",
      title: "Pyramid Scheme",
      emoji: "🐝",
      value: `${swarm.subs.size} ${swarm.subs.size === 1 ? "subagent" : "subagents"}`,
      detail: `one thread · ${compact(swarm.tokens)} tokens · ${clock.dayTime(swarm.first)}`,
      personId: PEOPLE[swarm.p]?.id ?? null,
      at: new Date(swarm.first).toISOString(),
    });
  }
  if (longest) {
    records.push({
      id: "longest-thread",
      title: "Hostage Situation",
      emoji: "⏳",
      value: duration((longest.last - longest.first) / 1000),
      detail: `${modelOfThread(longest)} · ${full(longest.requests)} requests · started ${clock.dayTime(longest.first)}`,
      personId: PEOPLE[longest.p]?.id ?? null,
      at: new Date(longest.first).toISOString(),
    });
  }
  if (priciest && priciest.cost) {
    records.push({
      id: "priciest-request",
      title: "Priciest Enter Key",
      emoji: "💸",
      value: usd(priciest.cost / 50),
      detail: `${MODELS[priciest.m]?.name ?? "unknown model"} · ${compact(priciest.total)} tokens · ${clock.dayTime(priciest.t)}`,
      personId: PEOPLE[priciest.p]?.id ?? null,
      at: new Date(priciest.t).toISOString(),
    });
  }

  const recent: LiveEvent[] = [];
  for (let i = end - 1; i >= 0 && recent.length < 30; i--) {
    const e = events[i];
    if (!e) continue;
    recent.push({
      at: new Date(e.t).toISOString(),
      personId: PEOPLE[e.p]?.id ?? "unknown",
      model: MODELS[e.m]?.id ?? "unknown",
      modelName: MODELS[e.m]?.name ?? "Unknown",
      totalTokens: e.total,
      costUsd: e.cost === null ? null : e.cost / 50,
      subagent: e.sub !== 0,
      failed: e.failed,
    });
  }

  let lastTen = 0;
  for (let i = lowerBound(events, now - 10 * 60_000); i < end; i++) lastTen += events[i]?.total ?? 0;
  const lastEvent = baseEvents[lowerBound(baseEvents, cut + 1) - 1];

  return {
    generatedAt: new Date(now).toISOString(),
    range,
    rangeStart: win.start === null ? null : new Date(win.start).toISOString(),
    timezone: TZ,
    costMode: "subscription",
    availableProviders,
    providers: activeProviders,
    lastEventAt: lastEvent ? new Date(lastEvent.t).toISOString() : null,
    collectorLagSeconds: lag || 2 + (Math.floor(now / 1000) % 5),
    totals: {
      requests: team.requests,
      failedRequests: team.failed,
      tokens: tokensOf(team),
      costUsd: team.total === 0 ? 0 : team.priced ? team.cost / 50 : null,
      listCostUsd: team.total === 0 ? 0 : team.priced ? team.cost : null,
      threads: team.threads.size,
      subagents: team.subs.size,
      people: assigned.filter((p) => (aggs[p]?.requests ?? 0) > 0).length,
      tokensPerMinuteNow: Math.round(lastTen / 10),
    },
    people,
    models,
    timeline: { unit: win.unit, buckets: win.buckets, series },
    heatmap: [...heat.values()],
    awards,
    records,
    recent,
  };
}

let flakyLoads = 0;

/** What the page calls in demo mode instead of fetch: latency and failures included. */
export function loadMockBoard(
  range: RangeKey,
  scenario: Scenario,
  providers: readonly string[] | null = null,
  signal?: AbortSignal,
): Promise<Board> {
  return new Promise((resolve, reject) => {
    if (scenario !== "flaky") flakyLoads = 0;
    const timer = setTimeout(() => {
      if (scenario === "error" || (scenario === "flaky" && flakyLoads++ > 0)) {
        reject(new Error(MOCK_ERROR));
        return;
      }
      try {
        resolve(mockBoard(range, scenario, providers));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 180);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/** The message the mock uses for failed requests, shaped like the server's `{ error }` body. */
export const MOCK_ERROR = "database is not reachable: connect ECONNREFUSED 10.0.0.12:5432";
