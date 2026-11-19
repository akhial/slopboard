// Awards (one winner each, per-person superlatives) and records (single
// record-setting things). The wording lives here, not in the UI.

import type { Award, PersonRow, RecordCard } from "../shared/api.ts";
import { num, numOrNull } from "./db.ts";
import { fmtCount, fmtDay, fmtDuration, fmtPct, fmtUsd, fmtWhen, plural } from "./format.ts";

type Row = Record<string, unknown>;

/** A PersonRow plus the numbers only awards need. */
export interface PersonStats {
  person: PersonRow;
  nightTokens: number;
  dawnTokens: number;
  weekendTokens: number;
  rateLimits: number;
  modelsUsed: number;
  avgTtftMs: number | null;
  biggestPrompt: number;
}

interface AwardDef {
  id: string;
  emoji: string;
  title: string;
  blurb: string;
  /** The number people are ranked by, or null when this person does not qualify. */
  score: (s: PersonStats, extra: Extra) => number | null;
  /** Scores below this win nothing, so nobody is crowned for trivial numbers. */
  min: number;
  format: (score: number) => string;
}

interface Extra {
  /** person id -> tokens of their biggest thread in the range. */
  biggestThread: Map<string, number>;
}

const inputSide = (p: PersonRow) => p.tokens.input + p.tokens.cacheRead + p.tokens.cacheWrite;

export const AWARDS: readonly AwardDef[] = [
  {
    id: "vampire-shift",
    emoji: "🦇",
    title: "Circadian Felony",
    blurb: "Most tokens between midnight and 5am, when normal people have dreams instead of diffs.",
    score: (s) => s.nightTokens,
    min: 50_000,
    format: (n) => `${fmtCount(n)} tokens past midnight`,
  },
  {
    id: "middle-manager",
    emoji: "📋",
    title: "Swivel-Chair CTO",
    blurb: "Spawned the most subagents and supervised them from a safe emotional distance.",
    score: (s) => s.person.subagents,
    min: 5,
    format: (n) => plural(n, "subagent"),
  },
  {
    id: "cache-me-if-you-can",
    emoji: "📼",
    title: "Broken Record",
    blurb: "Highest share of prompt tokens served straight from cache. Refuses to change the subject.",
    score: (s) => (inputSide(s.person) >= 500_000 ? s.person.cacheHitRate : null),
    min: 0.01,
    format: (n) => `${fmtPct(n)} from cache`,
  },
  {
    id: "crash-test-dummy",
    emoji: "🧯",
    title: "Walking Outage",
    blurb: "Ended the most requests in a flat-out error. Whatever they're asking for, the API is scared of it.",
    score: (s) => s.person.failedRequests,
    min: 5,
    format: (n) => plural(n, "failed request"),
  },
  {
    id: "429-enjoyer",
    emoji: "🛑",
    title: "Cut Off at the Bar",
    blurb: "Hit the most 429 rate limits. The API literally asked them to drink some water and sit down.",
    score: (s) => s.rateLimits,
    min: 3,
    format: (n) => plural(n, "rate limit"),
  },
  {
    id: "war-and-peace",
    emoji: "🧶",
    title: "Refuses to /clear",
    blurb: "Owned the single heaviest thread. Should have opened a new chat four hours ago.",
    score: (s, x) => x.biggestThread.get(s.person.id) ?? null,
    min: 1_000_000,
    format: (n) => `${fmtCount(n)} tokens in one thread`,
  },
  {
    id: "series-a-burn-rate",
    emoji: "🧾",
    title: "Why Plans Have Caps",
    blurb: "Would owe the most at public API rates. Single-handedly ruining flat-rate pricing for the rest of us.",
    score: (s) => s.person.costUsd,
    min: 5,
    format: (n) => `${fmtUsd(n)} at list`,
  },
  {
    id: "wall-of-text",
    emoji: "🖨️",
    title: "The Paper Mill",
    blurb: "Made the models print the most output tokens. Good luck reviewing that PR.",
    score: (s) => s.person.tokens.output,
    min: 100_000,
    format: (n) => `${fmtCount(n)} tokens out`,
  },
  {
    id: "galaxy-brain",
    emoji: "💭",
    title: "Staring at the Ceiling",
    blurb: "Biggest share of output spent reasoning to itself instead of answering the question.",
    score: (s) => (s.person.tokens.output >= 100_000 ? s.person.tokens.reasoning / s.person.tokens.output : null),
    min: 0.01,
    format: (n) => `${fmtPct(n)} thinking`,
  },
  {
    id: "not-my-job",
    emoji: "💼",
    title: "Shell Company",
    blurb: "Highest share of tokens burned by subagents. Barely even talks to the main model anymore.",
    score: (s) => (s.person.tokens.total >= 500_000 && s.person.subagents >= 3 ? s.person.subagentTokenShare : null),
    min: 0.01,
    format: (n) => `${fmtPct(n)} outsourced`,
  },
  {
    id: "model-sommelier",
    emoji: "🎰",
    title: "Blaming the Model",
    blurb: "Tried the widest range of models, firmly convinced the next one will fix it.",
    score: (s) => s.modelsUsed,
    min: 3,
    format: (n) => `${plural(n, "model")} tried`,
  },
  {
    id: "touch-grass-declined",
    emoji: "☀️",
    title: "No Weekend Plans",
    blurb: "Burned the most tokens on Saturday and Sunday. The outdoors remains theoretical.",
    score: (s) => s.weekendTokens,
    min: 50_000,
    format: (n) => `${fmtCount(n)} weekend tokens`,
  },
  {
    id: "dawn-patrol",
    emoji: "☕",
    title: "5am Menace",
    blurb: "Most tokens between 5am and 9am. Either up disgustingly early or never went to bed.",
    score: (s) => s.dawnTokens,
    min: 50_000,
    format: (n) => `${fmtCount(n)} tokens before 9am`,
  },
  {
    id: "context-sardine",
    emoji: "🧳",
    title: "Checked Baggage",
    blurb: "Crammed the most tokens into a single prompt. Sat on the context window to zip it shut.",
    score: (s) => s.biggestPrompt,
    min: 100_000,
    format: (n) => `${fmtCount(n)} tokens in one prompt`,
  },
  {
    id: "watching-paint-dry",
    emoji: "🐢",
    title: "The Waiting Room",
    blurb: "Longest average wait for the first token to arrive. Has watched the spinner forty times.",
    score: (s) => (s.person.requests >= 20 ? s.avgTtftMs : null),
    min: 500,
    format: (n) => `${fmtDuration(n)} avg wait`,
  },
  {
    id: "no-days-off",
    emoji: "🔥",
    title: "Daily Dependency",
    blurb: "Longest unbroken streak of days with at least one request. Medically concerning.",
    score: (s) => s.person.streakDays,
    min: 3,
    format: (n) => `${plural(n, "day")} straight`,
  },
];

/** Every award, in a fixed order, with nobody as winner where nobody qualifies. */
export function buildAwards(stats: PersonStats[], threadRows: Row[]): Award[] {
  const biggestThread = new Map<string, number>();
  for (const t of threadRows) {
    if (num(t.rn_tokens) === 1) biggestThread.set(String(t.person_id), num(t.tokens));
  }
  const extra: Extra = { biggestThread };
  // The shared key is not a person and never wins.
  const eligible = stats.filter((s) => !s.person.unassigned);

  return AWARDS.map((def) => {
    const ranked = eligible
      .map((s) => ({ id: s.person.id, score: def.score(s, extra) }))
      .filter((c): c is { id: string; score: number } => c.score !== null && Number.isFinite(c.score) && c.score >= def.min)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const winner = ranked[0];
    return {
      id: def.id,
      title: def.title,
      emoji: def.emoji,
      blurb: def.blurb,
      winnerId: winner?.id ?? null,
      value: winner ? def.format(winner.score) : null,
      runnerUpId: ranked[1]?.id ?? null,
    };
  });
}

export interface RecordInputs {
  tz: string;
  withDate: boolean;
  /** Per person, their top thread by tokens, by duration and by subagents (rn_* = 1). */
  threads: Row[];
  biggestRequest: Row | undefined;
  priciestRequest: Row | undefined;
  slowestRequest: Row | undefined;
  busiestHour: Row | undefined;
  biggestDay: Row | undefined;
}

function when(row: Row, key: string, inputs: RecordInputs): { at: string | null; label: string } {
  const value = row[key];
  const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return { at: null, label: "" };
  return { at: d.toISOString(), label: fmtWhen(d, inputs.tz, inputs.withDate) };
}

function best(rows: Row[], flag: string, metric: string): Row | undefined {
  let top: Row | undefined;
  for (const r of rows) {
    if (num(r[flag]) !== 1 || num(r[metric]) <= 0) continue;
    if (!top || num(r[metric]) > num(top[metric])) top = r;
  }
  return top;
}

const join = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");

/** Records that exist in this range; a card is left out when there is nothing to put on it. */
export function buildRecords(inputs: RecordInputs): RecordCard[] {
  const cards: RecordCard[] = [];
  const person = (row: Row) => (row.person_id == null ? null : String(row.person_id));

  const bigThread = best(inputs.threads, "rn_tokens", "tokens");
  if (bigThread) {
    const w = when(bigThread, "started_at", inputs);
    cards.push({
      id: "biggest-thread",
      title: "One Thread Too Far",
      emoji: "🧵",
      value: `${fmtCount(num(bigThread.tokens))} tokens`,
      detail: join(
        String(bigThread.model),
        plural(num(bigThread.requests), "request"),
        num(bigThread.subagents) > 0 && plural(num(bigThread.subagents), "subagent"),
        w.label,
      ),
      personId: person(bigThread),
      at: w.at,
    });
  }

  const longThread = best(inputs.threads, "rn_duration", "duration_ms");
  if (longThread && num(longThread.duration_ms) >= 60_000) {
    const w = when(longThread, "started_at", inputs);
    cards.push({
      id: "longest-thread",
      title: "Hostage Situation",
      emoji: "⏳",
      value: fmtDuration(num(longThread.duration_ms)),
      detail: join(
        String(longThread.model),
        plural(num(longThread.requests), "request"),
        `${fmtCount(num(longThread.tokens))} tokens`,
        w.label && `started ${w.label}`,
      ),
      personId: person(longThread),
      at: w.at,
    });
  }

  const hydra = best(inputs.threads, "rn_subagents", "subagents");
  if (hydra) {
    const w = when(hydra, "started_at", inputs);
    cards.push({
      id: "most-subagents",
      title: "Pyramid Scheme",
      emoji: "🐝",
      value: plural(num(hydra.subagents), "subagent"),
      detail: join(String(hydra.model), `${fmtCount(num(hydra.tokens))} tokens`, "one thread", w.label),
      personId: person(hydra),
      at: w.at,
    });
  }

  const big = inputs.biggestRequest;
  if (big) {
    const w = when(big, "ts", inputs);
    const prompt = num(big.prompt);
    cards.push({
      id: "biggest-request",
      title: "Single-Prompt Felony",
      emoji: "🏋️",
      value: `${fmtCount(num(big.tokens))} tokens`,
      detail: join(
        String(big.model),
        "one request",
        prompt > 0 && `${fmtPct(num(big.cache_read) / prompt)} from cache`,
        w.label,
      ),
      personId: person(big),
      at: w.at,
    });
  }

  const pricey = inputs.priciestRequest;
  const priceyCost = numOrNull(pricey?.cost_usd);
  if (pricey && priceyCost !== null) {
    const w = when(pricey, "ts", inputs);
    cards.push({
      id: "priciest-request",
      title: "Priciest Enter Key",
      emoji: "💸",
      value: fmtUsd(priceyCost),
      detail: join(String(pricey.model), "one request", `${fmtCount(num(pricey.tokens))} tokens`, w.label),
      personId: person(pricey),
      at: w.at,
    });
  }

  const slowest = inputs.slowestRequest;
  if (slowest) {
    const w = when(slowest, "ts", inputs);
    cards.push({
      id: "slowest-request",
      title: "Longest Cursor Blink",
      emoji: "⌛",
      value: fmtDuration(num(slowest.latency_ms)),
      detail: join(String(slowest.model), "one request", `${fmtCount(num(slowest.tokens))} tokens`, w.label),
      personId: person(slowest),
      at: w.at,
    });
  }

  const hour = inputs.busiestHour;
  if (hour && num(hour.tokens) > 0) {
    const w = when(hour, "bucket", inputs);
    cards.push({
      id: "busiest-hour",
      title: "Most Unhinged Hour",
      emoji: "⚡",
      value: `${fmtCount(num(hour.tokens))} tokens`,
      detail: join("one person, one hour", plural(num(hour.requests), "request"), w.label),
      personId: person(hour),
      at: w.at,
    });
  }

  const day = inputs.biggestDay;
  if (day && num(day.tokens) > 0) {
    const value = day.bucket;
    const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
    cards.push({
      id: "biggest-day",
      title: "Welfare Check Needed",
      emoji: "🚑",
      value: `${fmtCount(num(day.tokens))} tokens`,
      detail: join("one person, one day", plural(num(day.requests), "request"), d && fmtDay(d, inputs.tz)),
      personId: person(day),
      at: d ? d.toISOString() : null,
    });
  }

  return cards;
}
