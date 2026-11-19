import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Board, PersonRow, RangeKey } from "../../shared/api.ts";
import { AWARDS, buildAwards, type PersonStats } from "../awards.ts";
import { BoardCache, buildBoard, RANGES, resetBoardCaches, streakDays } from "../board.ts";
import { hashApiKey, insertEvents, normalizeRecord, type EventRow } from "../ingest.ts";
import { refreshPrices } from "../prices.ts";
import { usageRecord, type SyntheticRecord } from "../synthetic.ts";
import { assertBoard } from "./contract.ts";
import { createTestDb, SETUP_TIMEOUT, type TestDb } from "./pg.ts";

// Talks to Postgres (and may be the file that starts its container).
setDefaultTimeout(30_000);

// A zone far from UTC, so a board that ignored BOARD_TZ would put events in the wrong day and hour.
const TZ = "Asia/Tokyo";
const TZ_OFFSET_MS = 9 * 3_600_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const KEY_ALICE = "sk-test-alice";
const KEY_BOB = "sk-test-bob";
const KEY_SHARED = "sk-test-old-shared";

let db: TestDb;
let prices: ReturnType<typeof Bun.serve>;

const now = Date.now();
/** Midnight at the start of today in TZ. */
const midnight = Math.floor((now + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
/** A moment that is certainly today and certainly in the past. */
const today = midnight + Math.floor((now - midnight) / 2);
const threeDaysAgo3am = midnight - 3 * DAY + 3 * HOUR;
const tenDaysAgoNoon = midnight - 10 * DAY + 12 * HOUR;
const fortyDaysAgoNoon = midnight - 40 * DAY + 12 * HOUR;

const S1 = randomUUID();
const S1_SUB = randomUUID();
const S2 = randomUUID();
const S3 = randomUUID();

function row(o: Partial<SyntheticRecord> & Pick<SyntheticRecord, "apiKey">): EventRow {
  return normalizeRecord(usageRecord({ kind: "claude", at: new Date(today), model: "priced-model", ...o }))!;
}

async function board(range: RangeKey): Promise<Board> {
  resetBoardCaches(db.sql);
  const b = await buildBoard(db.sql, TZ, range, 7);
  // Through JSON, as the UI receives it.
  const wire: unknown = JSON.parse(JSON.stringify(b));
  assertBoard(wire);
  return wire;
}

const person = (b: Board, id: string): PersonRow => {
  const p = b.people.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id} on the board`);
  return p;
};

beforeAll(async () => {
  db = await createTestDb("board");
  prices = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(`${import.meta.dir}/fixtures/prices.json`)) });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await prices.stop(true);
  await db.close();
});

describe("board", () => {
  test("an empty store gives an empty, well-formed board", async () => {
    for (const range of RANGES) {
      const b = await board(range);
      expect(b.people).toEqual([]);
      expect(b.models).toEqual([]);
      expect(b.records).toEqual([]);
      expect(b.recent).toEqual([]);
      expect(b.heatmap).toEqual([]);
      expect(b.lastEventAt).toBeNull();
      // Nothing used costs nothing, which is not the same as "could not be priced".
      expect(b.totals).toMatchObject({ requests: 0, costUsd: 0, people: 0, tokensPerMinuteNow: 0 });
      expect(b.awards.every((a) => a.winnerId === null && a.value === null)).toBe(true);
      expect(b.timeline.buckets.length).toBeGreaterThan(0);
      expect(b.collectorLagSeconds).toBe(7);
      expect(b.timezone).toBe(TZ);
    }
  });

  test("numbers on the board are the numbers in the events", async () => {
    await refreshPrices(db.sql, prices.url.href);
    await db.sql`insert into people (id, name) values ('alice', 'Alice'), ('bob', 'Bob')`;
    await db.sql`insert into api_keys (key_hash, person_id) values (${hashApiKey(KEY_ALICE)}, 'alice'), (${hashApiKey(KEY_BOB)}, 'bob')`;
    await db.sql`insert into model_price_overrides (model, litellm_id) values ('weird-model', 'priced-model')`;

    const retried = randomUUID();
    const doomed = randomUUID();
    await insertEvents(db.sql, [
      // Alice, today. A1: main conversation, with every kind of token.
      row({ apiKey: KEY_ALICE, sessionId: S1, latencyMs: 9000, ttftMs: 1000, usage: { input: 1000, cacheRead: 8000, cacheWrite: 1000, cacheWrite1h: 400, answer: 500, reasoning: 500 } }),
      // A2: a subagent of S1.
      row({ apiKey: KEY_ALICE, sessionId: S1_SUB, parentSessionId: S1, at: new Date(today + 1), usage: { input: 2000, cacheRead: 0, cacheWrite: 0, answer: 1000, reasoning: 0 } }),
      // A3: refused once, then served, on a model nobody has a price for.
      row({ apiKey: KEY_ALICE, sessionId: S2, model: "mystery", requestId: retried, at: new Date(today + 2), failedStatus: 429 }),
      row({ apiKey: KEY_ALICE, sessionId: S2, model: "mystery", requestId: retried, at: new Date(today + 3), usage: { input: 100, cacheRead: 0, cacheWrite: 0, answer: 100, reasoning: 0 } }),
      // A4: failed twice and gave up.
      row({ apiKey: KEY_ALICE, sessionId: S2, model: "mystery", requestId: doomed, at: new Date(today + 4), failedStatus: 500 }),
      row({ apiKey: KEY_ALICE, sessionId: S2, model: "mystery", requestId: doomed, at: new Date(today + 5), failedStatus: 500 }),
      // Bob, three days ago at 03:00 board time, asking for a thinking variant of an aliased model.
      row({ apiKey: KEY_BOB, kind: "codex", model: "weird-model", alias: "weird-model(high)", sessionId: S3, at: new Date(threeDaysAgo3am), usage: { input: 5000, cacheRead: 0, cacheWrite: 0, answer: 2000, reasoning: 3000 } }),
      // The old shared key, ten days ago, on a model LiteLLM lists under a provider prefix.
      row({ apiKey: KEY_SHARED, kind: "gemini", model: "gem-x", at: new Date(tenDaysAgoNoon), usage: { input: 10_000, cacheRead: 0, cacheWrite: 0, answer: 1000, reasoning: 0 } }),
      // Bob again, long ago.
      row({ apiKey: KEY_BOB, at: new Date(fortyDaysAgoNoon), usage: { input: 7, cacheRead: 0, cacheWrite: 0, answer: 3, reasoning: 0 } }),
    ]);

    // ---- today
    const t = await board("today");
    expect(t.rangeStart).toBe(new Date(midnight).toISOString());
    // Both registered people, and the shared row because that key has had traffic (ten days ago).
    expect(t.people.map((p) => [p.id, p.rank])).toEqual([["alice", 1], ["bob", 2], ["shared", 0]]);
    expect(person(t, "shared")).toMatchObject({ unassigned: true, previousRank: null, requests: 0, costUsd: 0, tokens: { total: 0 }, topModel: null });
    const alice = person(t, "alice");
    expect(alice).toMatchObject({
      name: "Alice",
      unassigned: false,
      rank: 1,
      previousRank: null,
      // A1, A2, the retried A3 once, the doomed A4 once.
      requests: 4,
      failedRequests: 1,
      tokens: { input: 3100, cacheRead: 8000, cacheWrite: 1000, output: 2100, reasoning: 500, total: 14_200 },
      threads: 2,
      subagents: 1,
      topModel: "Priced Model",
      activeDays: 1,
      streakDays: 1,
      peakHour: new Date(today + TZ_OFFSET_MS).getUTCHours(),
      lastSeenAt: new Date(today + 5).toISOString(),
    });
    // A1: 1000*1e-6 + 8000*1e-7 + 600*2e-6 + 400*3e-6 + 1000*1e-5 = 0.0142; A2: 2000*1e-6 + 1000*1e-5 = 0.012.
    expect(alice.costUsd).toBeCloseTo(0.0262, 10);
    expect(alice.subagentTokenShare).toBeCloseTo(3000 / 14_200, 10);
    expect(alice.cacheHitRate).toBeCloseTo(8000 / 12_100, 10);
    expect(alice.spark.reduce((a, n) => a + n, 0)).toBe(14_200);
    // Registered, but nothing today: zero cost (not "unpriced"), no previous rank.
    expect(person(t, "bob")).toMatchObject({ rank: 2, previousRank: null, requests: 0, costUsd: 0, topModel: null, peakHour: null, streakDays: 0, tokens: { total: 0 } });
    expect(person(t, "bob").spark.every((n) => n === 0)).toBe(true);
    expect(person(t, "bob").lastSeenAt).toBe(new Date(threeDaysAgo3am).toISOString());

    expect(t.totals).toMatchObject({ requests: 4, failedRequests: 1, threads: 2, subagents: 1, people: 1, tokens: { total: 14_200 } });
    expect(t.totals.costUsd).toBeCloseTo(0.0262, 10);
    expect(t.totals.tokensPerMinuteNow).toBeGreaterThanOrEqual(0);

    expect(t.models.map((m) => [m.model, m.displayName, m.requests, m.priced, m.topPersonId, m.tokens.total])).toEqual([
      ["priced-model", "Priced Model", 2, true, "alice", 14_000],
      ["mystery", "Mystery", 2, false, "alice", 200],
    ]);
    expect(t.models[0]!.costUsd).toBeCloseTo(0.0262, 10);
    expect(t.models[1]!.costUsd).toBeNull();
    expect(t.lastEventAt).toBe(new Date(today + 5).toISOString());
    expect(t.recent[0]).toMatchObject({ personId: "alice", model: "mystery", modelName: "Mystery", failed: true, totalTokens: 0 });
    expect(t.recent.find((e) => e.model === "weird-model")).toMatchObject({ personId: "bob", modelName: "Weird Model" });
    expect(t.recent).toHaveLength(9);
    expect(t.recent.find((e) => e.subagent)).toMatchObject({ personId: "alice", totalTokens: 3000 });
    expect(t.recent.find((e) => e.subagent)!.costUsd).toBeCloseTo(0.012, 10);

    const thread = t.records.find((r) => r.id === "biggest-thread")!;
    expect(thread).toMatchObject({ value: "14K tokens", personId: "alice", at: new Date(today).toISOString() });
    expect(thread.detail).toContain("priced-model · 2 requests · 1 subagent");
    expect(t.records.find((r) => r.id === "biggest-request")).toMatchObject({ value: "11K tokens", personId: "alice" });
    expect(t.records.find((r) => r.id === "priciest-request")).toMatchObject({ value: "$0.01", personId: "alice" });
    expect(t.records.find((r) => r.id === "slowest-request")).toMatchObject({ value: "9.0s", personId: "alice" });

    // ---- 7 days: Bob's night session comes into view
    const w = await board("7d");
    expect(w.rangeStart).toBe(new Date(midnight - 6 * DAY).toISOString());
    expect(w.timeline.buckets).toHaveLength(7);
    expect(w.people.map((p) => [p.id, p.rank, p.tokens.total])).toEqual([["alice", 1, 14_200], ["bob", 2, 10_000], ["shared", 0, 0]]);
    const bob = person(w, "bob");
    expect(bob).toMatchObject({
      requests: 1,
      tokens: { input: 5000, cacheRead: 0, cacheWrite: 0, output: 5000, reasoning: 3000, total: 10_000 },
      // 03:00 in Tokyo is 18:00 UTC of the day before.
      peakHour: 3,
      topModel: "Weird Model",
      activeDays: 1,
    });
    // Priced through the manual alias: 5000*1e-6 + 5000*1e-5.
    expect(bob.costUsd).toBeCloseTo(0.055, 10);
    expect(bob.spark[3]).toBe(10_000);
    // The preceding seven days hold only the shared key's traffic, which ranks nobody.
    expect(w.people.map((p) => p.previousRank)).toEqual([null, null, null]);
    // The thinking suffix is not a different model.
    expect(w.models.find((m) => m.model === "weird-model")).toMatchObject({ requests: 1, priced: true, provider: "codex", topPersonId: "bob" });
    expect(w.models.some((m) => m.model.includes("("))).toBe(false);

    // ---- 30 days: the shared key shows up, as nobody
    const m = await board("30d");
    expect(m.timeline.buckets).toHaveLength(30);
    // The shared row has more tokens than Bob, but it is not ranked and comes last.
    expect(m.people.map((p) => [p.id, p.rank])).toEqual([["alice", 1], ["bob", 2], ["shared", 0]]);
    const shared = person(m, "shared");
    expect(shared).toMatchObject({ name: "Shared key", unassigned: true, rank: 0, previousRank: null, requests: 1, tokens: { total: 11_000 } });
    // Found as LiteLLM's "gemini/gem-x": 10000*2e-6 + 1000*4e-6.
    expect(shared.costUsd).toBeCloseTo(0.024, 10);
    expect(m.totals.people).toBe(2);
    expect(m.totals.tokens.total).toBe(35_200);
    expect(m.totals.costUsd).toBeCloseTo(0.0262 + 0.055 + 0.024, 10);

    // ---- all time
    const a = await board("all");
    expect(a.rangeStart).toBeNull();
    expect(a.timeline.buckets).toHaveLength(41);
    expect(a.timeline.buckets[0]).toBe(new Date(midnight - 40 * DAY).toISOString());
    expect(person(a, "bob").tokens.total).toBe(10_010);
    expect(a.people.every((p) => p.previousRank === null)).toBe(true);
    for (const p of a.people) expect(p.spark.reduce((x, n) => x + n, 0)).toBe(p.tokens.total);

    // ---- the heatmap covers 28 days whatever the range
    for (const b of [t, w, m, a]) expect(b.heatmap).toEqual(t.heatmap);
    const tokyo = (ms: number) => new Date(ms + TZ_OFFSET_MS);
    const cell = (ms: number) => ({ weekday: (tokyo(ms).getUTCDay() + 6) % 7, hour: tokyo(ms).getUTCHours() });
    const find = (ms: number) => t.heatmap.find((c) => c.weekday === cell(ms).weekday && c.hour === cell(ms).hour)!;
    expect(find(threeDaysAgo3am)).toMatchObject({ hour: 3, tokens: 10_000, requests: 1 });
    expect(find(tenDaysAgoNoon)).toMatchObject({ hour: 12, tokens: 11_000, requests: 1 });
    expect(t.heatmap.reduce((sum, c) => sum + c.tokens, 0)).toBe(35_200);
  });

  test("ranks are among assigned people only, now and in the window before", async () => {
    // Yesterday Bob was ahead of Alice, and the shared key was ahead of both.
    await insertEvents(db.sql, [
      row({ apiKey: KEY_BOB, at: new Date(midnight - 2 * HOUR), usage: { input: 900, cacheRead: 0, cacheWrite: 0, answer: 0, reasoning: 0 } }),
      row({ apiKey: KEY_ALICE, at: new Date(midnight - 3 * HOUR), usage: { input: 100, cacheRead: 0, cacheWrite: 0, answer: 0, reasoning: 0 } }),
      row({ apiKey: KEY_SHARED, at: new Date(midnight - 4 * HOUR), model: "mystery", usage: { input: 5000, cacheRead: 0, cacheWrite: 0, answer: 0, reasoning: 0 } }),
    ]);
    // Carol is registered and has never sent a request.
    await db.sql`insert into people (id, name) values ('carol', 'Carol')`;

    const t = await board("today");
    // The shared key's bigger yesterday does not push Bob to 2 and Alice to 3.
    expect(t.people.map((p) => [p.id, p.rank, p.previousRank])).toEqual([
      ["alice", 1, 2],
      ["bob", 2, 1],
      ["carol", 3, null],
      ["shared", 0, null],
    ]);
    // Bob and Carol are tied on zero tokens today: the order is by name, and
    // neither gets a previous rank that it did not earn.
    expect(person(t, "carol")).toMatchObject({
      name: "Carol",
      unassigned: false,
      requests: 0,
      costUsd: 0,
      threads: 0,
      topModel: null,
      peakHour: null,
      lastSeenAt: null,
      streakDays: 0,
      activeDays: 0,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
    });
    expect(t.totals.people).toBe(1);

    // Yesterday's shared traffic was on a model without a price: tokens, but
    // none priced, is the one case where the cost is unknown rather than zero.
    const w = await board("7d");
    expect(person(w, "carol")).toMatchObject({ rank: 3, previousRank: null, costUsd: 0 });
    expect(person(w, "shared")).toMatchObject({ rank: 0, requests: 1, costUsd: null, tokens: { total: 5000 } });

    // Active yesterday and today.
    expect(person(t, "alice").streakDays).toBe(2);
    // Active yesterday, not yet today: the streak is still alive.
    expect(person(t, "bob").streakDays).toBe(1);
    await db.sql`delete from people where id = 'carol'`;
    await db.sql`delete from events where key_hash = ${hashApiKey(KEY_SHARED)} and model = 'mystery'`;
  });

  test("assigning a key re-attributes everything it ever did", async () => {
    await db.sql`insert into api_keys (key_hash, person_id) values (${hashApiKey(KEY_SHARED)}, 'bob')`;
    const m = await board("30d");
    expect(m.people.map((p) => p.id)).toEqual(["bob", "alice"]);
    expect(person(m, "bob").tokens.total).toBe(10_000 + 11_000 + 900);
    expect(m.people.some((p) => p.unassigned)).toBe(false);
    await db.sql`delete from api_keys where key_hash = ${hashApiKey(KEY_SHARED)}`;
  });

  test("prices: fast mode, unclassified tokens and manual prices", async () => {
    const cost = async (id: string) => (await db.sql`select cost_usd, price_source from events_v where event_id = ${id}`)[0]!;
    const usage = { input: 1000, cacheRead: 0, cacheWrite: 0, answer: 100, reasoning: 0 };
    const fast = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), speed: "fast", usage });
    const upper = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), model: "Mixed-Case-Model", usage });
    const image = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), model: "image-only", usage });
    const manual = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), model: "house-model", usage: { ...usage, cacheRead: 500 } });
    const unclassified = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), usage });
    unclassified.unclassified_tokens = 50;
    const thinking = row({ apiKey: KEY_ALICE, at: new Date(fortyDaysAgoNoon), kind: "gemini", model: "gem-x", usage: { ...usage, reasoning: 200 } });
    await insertEvents(db.sql, [fast, upper, image, manual, unclassified, thinking]);
    await db.sql`
      insert into model_price_overrides (model, input_cost_per_token, output_cost_per_token, cache_read_cost_per_token)
      values ('house-model', 3e-6, 9e-6, 1e-6)`;

    // LiteLLM's "fast" multiplier of 2 applies: (1000*1e-6 + 100*1e-5) * 2.
    expect(Number((await cost(fast.event_id)).cost_usd)).toBeCloseTo(0.004, 10);
    // Ids match whatever their case: 1100 * 5e-6.
    expect(await cost(upper.event_id)).toMatchObject({ price_source: "exact" });
    expect(Number((await cost(upper.event_id)).cost_usd)).toBeCloseTo(0.0055, 10);
    // A LiteLLM entry without token prices is no price.
    expect(await cost(image.event_id)).toEqual({ cost_usd: null, price_source: null });
    // Manual prices: 1000*3e-6 + 500*1e-6 + 100*9e-6.
    expect(await cost(manual.event_id)).toMatchObject({ price_source: "manual" });
    expect(Number((await cost(manual.event_id)).cost_usd)).toBeCloseTo(0.0044, 10);
    // Tokens that could not be classified are never priced.
    expect((await cost(unclassified.event_id)).cost_usd).toBeNull();
    // Reasoning has its own rate where LiteLLM gives one: 1000*2e-6 + 100*4e-6 + 200*6e-6.
    expect(await cost(thinking.event_id)).toMatchObject({ price_source: "provider-prefix" });
    expect(Number((await cost(thinking.event_id)).cost_usd)).toBeCloseTo(0.0036, 10);

    // Refreshing an unchanged list rewrites nothing.
    expect(await refreshPrices(db.sql, prices.url.href)).toEqual({ models: 5, changed: 0 });
    const all = await board("all");
    expect(all.models.find((x) => x.model === "image-only")).toMatchObject({ priced: false, costUsd: null });
    // Unclassified tokens still count, as input.
    expect(person(all, "alice").tokens.total).toBe(14_200 + 100 + 6 * 1100 + 500 + 50 + 200);
  });

  test("the cache serves one build to many callers", async () => {
    let builds = 0;
    const cache = new BoardCache(async (range) => {
      builds++;
      await Bun.sleep(20);
      return await buildBoard(db.sql, TZ, range, null);
    }, 60_000);
    const boards = await Promise.all(Array.from({ length: 8 }, () => cache.get("7d")));
    expect(builds).toBe(1);
    expect(new Set(boards.map((b) => b.generatedAt)).size).toBe(1);
    await cache.get("7d");
    await cache.get("today");
    expect(builds).toBe(2);
  });
});

describe("awards", () => {
  const stat = (id: string, over: Partial<PersonRow>, extra: Partial<PersonStats> = {}): PersonStats => ({
    person: {
      id,
      name: id,
      unassigned: id === "shared",
      rank: 1,
      previousRank: null,
      requests: 100,
      failedRequests: 0,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
      costUsd: null,
      threads: 1,
      subagents: 0,
      subagentTokenShare: 0,
      cacheHitRate: 0,
      topModel: null,
      activeDays: 1,
      streakDays: 0,
      peakHour: null,
      lastSeenAt: null,
      spark: [],
      ...over,
    },
    nightTokens: 0,
    dawnTokens: 0,
    weekendTokens: 0,
    rateLimits: 0,
    modelsUsed: 1,
    avgTtftMs: null,
    biggestPrompt: 0,
    ...extra,
  });
  const award = (stats: PersonStats[], id: string, threads: Record<string, unknown>[] = []) =>
    buildAwards(stats, threads).find((a) => a.id === id)!;

  test("there are plenty, each with its own wording", () => {
    expect(AWARDS.length).toBeGreaterThanOrEqual(10);
    for (const key of ["id", "title", "blurb", "emoji"] as const) {
      expect(new Set(AWARDS.map((a) => a[key])).size).toBe(AWARDS.length);
    }
    for (const a of AWARDS) expect(a.min).toBeGreaterThan(0);
  });

  test("the shared key never wins, however far ahead it is", () => {
    const stats = [
      stat("shared", { subagents: 500, failedRequests: 900, costUsd: 9999 }, { nightTokens: 9e9, rateLimits: 999 }),
      stat("ann", { subagents: 12, failedRequests: 7, costUsd: 40 }, { nightTokens: 2_000_000, rateLimits: 9 }),
      stat("ben", { subagents: 30, failedRequests: 6, costUsd: 12 }, { nightTokens: 900_000, rateLimits: 4 }),
    ];
    expect(award(stats, "middle-manager")).toMatchObject({ winnerId: "ben", runnerUpId: "ann", value: "30 subagents" });
    expect(award(stats, "crash-test-dummy")).toMatchObject({ winnerId: "ann", runnerUpId: "ben", value: "7 failed requests" });
    expect(award(stats, "429-enjoyer")).toMatchObject({ winnerId: "ann", value: "9 rate limits" });
    expect(award(stats, "vampire-shift")).toMatchObject({ winnerId: "ann", value: "2M tokens past midnight" });
    expect(award(stats, "series-a-burn-rate")).toMatchObject({ winnerId: "ann", value: "$40.00 at list" });
    for (const a of buildAwards(stats, [])) expect([a.winnerId, a.runnerUpId]).not.toContain("shared");
  });

  test("nobody wins on trivial numbers", () => {
    const stats = [stat("ann", { subagents: 4, failedRequests: 4, costUsd: 4.99 }, { nightTokens: 49_999, rateLimits: 2 })];
    for (const id of ["middle-manager", "crash-test-dummy", "429-enjoyer", "vampire-shift", "series-a-burn-rate"]) {
      expect(award(stats, id)).toMatchObject({ winnerId: null, value: null, runnerUpId: null });
    }
    // One step over the line is enough, and a lone qualifier has no runner-up.
    const over = [stat("ann", { subagents: 5 }), stat("ben", { subagents: 4 })];
    expect(award(over, "middle-manager")).toMatchObject({ winnerId: "ann", runnerUpId: null });
  });

  test("rates need volume behind them", () => {
    const tokens = (input: number, cacheRead: number) => ({ input, cacheRead, cacheWrite: 0, output: 0, reasoning: 0, total: input + cacheRead });
    const stats = [
      // 100% cache hits on a handful of tokens does not beat 80% on millions.
      stat("ann", { cacheHitRate: 1, tokens: tokens(0, 1000) }),
      stat("ben", { cacheHitRate: 0.8, tokens: tokens(400_000, 1_600_000) }),
    ];
    expect(award(stats, "cache-me-if-you-can")).toMatchObject({ winnerId: "ben", value: "80% from cache", runnerUpId: null });
  });

  test("the biggest thread belongs to its owner", () => {
    const stats = [stat("ann", {}), stat("ben", {}), stat("shared", {})];
    const threads = [
      { person_id: "shared", tokens: 90_000_000, rn_tokens: 1 },
      { person_id: "ann", tokens: 3_000_000, rn_tokens: 1 },
      { person_id: "ben", tokens: 41_200_000, rn_tokens: 1 },
      { person_id: "ben", tokens: 999, rn_tokens: 2, rn_duration: 1 },
    ];
    expect(award(stats, "war-and-peace", threads)).toMatchObject({ winnerId: "ben", runnerUpId: "ann", value: "41.2M tokens in one thread" });
  });
});

describe("streaks", () => {
  test("count back from today, or from yesterday when today is still quiet", () => {
    const days = new Set(["2026-11-19", "2026-11-18", "2026-11-17", "2026-11-15"]);
    expect(streakDays(days, "2026-11-19")).toBe(3);
    expect(streakDays(days, "2026-11-20")).toBe(3);
    expect(streakDays(days, "2026-11-21")).toBe(0);
    expect(streakDays(new Set(["2026-03-01", "2026-02-28"]), "2026-03-01")).toBe(2);
    expect(streakDays(undefined, "2026-11-19")).toBe(0);
  });
});
