#!/usr/bin/env bun
// Fills the database with a few weeks of made-up usage, for UI work and screenshots.
//
//   bun run src/server/seed.ts            # refuses to touch a database that has events
//   bun run src/server/seed.ts --reset    # wipes previously seeded data first
//   bun run src/server/seed.ts --days 30 --seed 7
//
// The records go through the same normalisation and insert path as real ones.
// The same --seed gives the same people and the same shape of activity.

import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { connect, getMeta, migrate, setMeta, type Db } from "./db.ts";
import { slugify } from "./format.ts";
import { hashApiKey, insertEvents, normalizeRecord, type EventRow } from "./ingest.ts";
import { refreshPrices } from "./prices.ts";
import { usageRecord, type ProviderKind, type Usage } from "./synthetic.ts";

const SEED_MARK = "seed.synthetic";

// ---------------------------------------------------------------- randomness

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(min = 0, max = 1): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Mostly small, sometimes large: the shape of nearly everything here. */
  skewed(min: number, max: number, power = 2.5): number {
    return Math.round(min + (max - min) * this.next() ** power);
  }
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let roll = this.next() * items.reduce((sum, [, w]) => sum + w, 0);
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll <= 0) return item;
    }
    return items[items.length - 1]![0];
  }
  /** A UUID drawn from this generator, so runs are reproducible. */
  uuid(): string {
    const h = createHash("sha256").update(`${this.next()}:${this.next()}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

// ---------------------------------------------------------------- the cast

interface Model {
  kind: ProviderKind;
  id: string;
  /** Typical reasoning tokens per turn; 0 for models that do not think out loud. */
  thinks: number;
}

const M = {
  fable: { kind: "claude", id: "claude-fable-5-2", thinks: 2600 },
  opus: { kind: "claude", id: "claude-opus-5-5", thinks: 1800 },
  sonnet: { kind: "claude", id: "claude-sonnet-5-5", thinks: 900 },
  haiku: { kind: "claude", id: "claude-haiku-5-5", thinks: 0 },
  sol: { kind: "codex", id: "gpt-5.6-sol", thinks: 2200 },
  codex: { kind: "codex", id: "gpt-5.3-codex", thinks: 1400 },
  mini: { kind: "codex", id: "gpt-5.4-mini", thinks: 300 },
  gemini: { kind: "gemini", id: "gemini-3.1-pro-preview", thinks: 1500 },
  // Deliberately absent from LiteLLM, to exercise "unpriced".
  glm: { kind: "other", id: "glm-5.1", thinks: 0 },
} as const satisfies Record<string, Model>;

/** Relative likelihood of starting a thread in each hour of the day (board timezone). */
type Hours = readonly number[];
const OFFICE: Hours = [0, 0, 0, 0, 0, 0, 0.2, 0.6, 2, 5, 7, 7, 4, 5, 7, 7, 6, 4, 2, 1.2, 0.8, 0.4, 0.2, 0.1];
const NIGHT_OWL: Hours = [7, 7, 6, 3, 1, 0, 0, 0, 0, 0, 0.3, 1, 1.5, 2, 3, 3, 3, 3, 4, 5, 6, 8, 8, 8];
const EARLY_BIRD: Hours = [0, 0, 0, 0, 0.3, 4, 8, 9, 8, 6, 5, 4, 2, 2, 2, 1.5, 1, 0.4, 0.2, 0, 0, 0, 0, 0];
const EVENINGS: Hours = [0.4, 0.1, 0, 0, 0, 0, 0, 0.3, 1, 2, 3, 3, 2, 3, 3, 3, 3, 4, 6, 7, 7, 5, 3, 1.2];

interface Profile {
  name: string;
  /** Threads on an ordinary weekday. */
  threadsPerDay: number;
  weekendFactor: number;
  hours: Hours;
  models: readonly (readonly [Model, number])[];
  subagentModels: readonly (readonly [Model, number])[];
  /** Chance per turn of handing work to a subagent. */
  delegation: number;
  /** Chance per request that the first attempt fails. */
  failures: number;
  /** Typical number of turns in a thread. */
  stamina: number;
}

const CAST: readonly Profile[] = [
  {
    name: "Mira Okafor",
    threadsPerDay: 4,
    weekendFactor: 0.35,
    hours: NIGHT_OWL,
    models: [[M.fable, 6], [M.opus, 3], [M.sonnet, 1]],
    subagentModels: [[M.sonnet, 5], [M.haiku, 4], [M.opus, 1]],
    delegation: 0.045,
    failures: 0.012,
    stamina: 55,
  },
  {
    name: "Jonas Weidmann",
    threadsPerDay: 6,
    weekendFactor: 0.15,
    hours: OFFICE,
    models: [[M.sol, 5], [M.codex, 4], [M.mini, 1]],
    subagentModels: [[M.mini, 6], [M.codex, 2]],
    delegation: 0.02,
    failures: 0.008,
    stamina: 40,
  },
  {
    name: "Priya Raman",
    threadsPerDay: 2.5,
    weekendFactor: 4,
    hours: EVENINGS,
    models: [[M.opus, 3], [M.sol, 2], [M.gemini, 3], [M.sonnet, 2], [M.glm, 2], [M.codex, 1], [M.fable, 1], [M.haiku, 1]],
    subagentModels: [[M.haiku, 3], [M.mini, 2], [M.sonnet, 2]],
    delegation: 0.025,
    failures: 0.015,
    stamina: 30,
  },
  {
    name: "Tomás Echeverría",
    threadsPerDay: 4,
    weekendFactor: 0.4,
    hours: OFFICE,
    models: [[M.sonnet, 5], [M.haiku, 3], [M.codex, 2]],
    subagentModels: [[M.haiku, 8], [M.sonnet, 1]],
    delegation: 0.07,
    failures: 0.11,
    stamina: 28,
  },
  {
    name: "Leila Haddad",
    threadsPerDay: 3.5,
    weekendFactor: 0.3,
    hours: EARLY_BIRD,
    models: [[M.haiku, 4], [M.mini, 3], [M.sonnet, 2]],
    subagentModels: [[M.haiku, 1]],
    delegation: 0.015,
    failures: 0.01,
    stamina: 34,
  },
];

// ---------------------------------------------------------------- generation

interface World {
  rng: Rng;
  now: number;
  tz: string;
  records: Record<string, unknown>[];
}

/** UTC instant of `hour:minute` local time on the day `daysAgo` before today in `tz`. */
function localTime(tz: string, now: number, daysAgo: number, hour: number, minute: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = fmt.format(new Date(now - daysAgo * 86_400_000)).split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // Shift by the zone's offset at that moment.
  const local = new Date(new Date(guess).toLocaleString("en-US", { timeZone: tz })).getTime();
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return guess - (local - utc);
}

function weekdayOf(tz: string, at: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(at));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
}

interface Conversation {
  apiKey: string;
  model: Model;
  sessionId: string;
  parentSessionId?: string;
  turns: number;
  startAt: number;
  profile: Profile;
  depth: number;
}

const FAILURES: readonly (readonly [number, number])[] = [[429, 6], [529, 3], [500, 1.5], [503, 1], [502, 0.5]];
const FAIL_BODY: Record<number, string> = {
  429: '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  529: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  500: '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  503: '{"error":{"message":"The server is overloaded or not ready yet.","type":"server_error"}}',
  502: "upstream connect error or disconnect/reset before headers",
};

/** Plays one session turn by turn and returns when it ended. */
function converse(w: World, c: Conversation): number {
  const { rng } = w;
  const { model, profile } = c;
  const caches = model.kind === "claude" || model.kind === "codex" || model.kind === "gemini";
  const maxContext = model.kind === "claude" ? 420_000 : 260_000;
  // System prompt, tool definitions, and for a subagent its briefing.
  let context = c.depth === 0 ? rng.int(14_000, 38_000) : rng.int(6_000, 16_000);
  let cached = 0;
  let at = c.startAt;
  let lastAt = at;

  for (let turn = 0; turn < c.turns; turn++) {
    if (at >= w.now) break;

    const fresh = rng.skewed(120, 9_000);
    // The cache goes cold after a few idle minutes.
    const warm = caches && cached > 0 && at - lastAt < 5 * 60_000;
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, answer: 0, reasoning: 0 };
    if (!caches) {
      usage.input = context + fresh;
    } else if (model.kind === "claude") {
      usage.cacheRead = warm ? cached : 0;
      usage.cacheWrite = context - usage.cacheRead + Math.round(fresh * 0.8);
      usage.input = fresh - Math.round(fresh * 0.8) + rng.int(3, 40);
      if (rng.chance(0.25)) usage.cacheWrite1h = Math.round(usage.cacheWrite * 0.5);
    } else {
      // OpenAI and Gemini cache implicitly: a hit is a discount, a miss costs nothing extra.
      usage.cacheRead = warm ? Math.floor(cached / 1024) * 1024 : 0;
      usage.input = context - usage.cacheRead + fresh;
    }
    usage.answer = rng.skewed(40, 3_800, 3);
    usage.reasoning = model.thinks > 0 && rng.chance(0.6) ? rng.skewed(64, model.thinks * 4, 2) : 0;

    const ttft = Math.round(rng.float(350, 1_600) + usage.reasoning * rng.float(8, 18));
    const latency = ttft + Math.round((usage.answer + usage.reasoning * 0.2) * rng.float(9, 22));
    const requestId = rng.uuid();
    let attemptAt = at;

    if (rng.chance(profile.failures)) {
      const status = rng.weighted(FAILURES);
      // A burst of refusals, then usually a retry that goes through.
      const attempts = status === 429 ? rng.int(1, 3) : 1;
      for (let i = 0; i < attempts; i++) {
        w.records.push(
          usageRecord({
            kind: model.kind,
            at: new Date(attemptAt),
            apiKey: c.apiKey,
            model: model.id,
            sessionId: c.sessionId,
            parentSessionId: c.parentSessionId,
            requestId,
            executionId: rng.uuid(),
            failedStatus: status,
            failBody: FAIL_BODY[status],
            latencyMs: rng.int(90, 900),
          }),
        );
        attemptAt += rng.int(800, 4_000);
      }
      if (rng.chance(0.3)) {
        // Gave up: the request as a whole failed.
        at = attemptAt + rng.int(5_000, 120_000);
        continue;
      }
    }

    w.records.push(
      usageRecord({
        kind: model.kind,
        at: new Date(attemptAt),
        apiKey: c.apiKey,
        model: model.id,
        alias: model.kind === "codex" && usage.reasoning > 3000 ? `${model.id}(high)` : model.id,
        usage,
        sessionId: c.sessionId,
        parentSessionId: c.parentSessionId,
        requestId,
        executionId: rng.uuid(),
        latencyMs: latency,
        ttftMs: ttft,
        speed: model === M.fable && rng.chance(0.04) ? "fast" : undefined,
      }),
    );

    context += fresh + usage.answer;
    cached = context;
    if (context > maxContext) {
      // Compaction: the conversation carries on from a summary.
      context = rng.int(22_000, 45_000);
      cached = 0;
    }
    lastAt = attemptAt;

    if (c.depth < 2 && rng.chance(c.depth === 0 ? profile.delegation : profile.delegation * 0.25)) {
      const helpers = c.depth === 0 && rng.chance(0.3) ? rng.int(2, 5) : 1;
      let done = attemptAt + latency;
      for (let i = 0; i < helpers; i++) {
        done = Math.max(
          done,
          converse(w, {
            apiKey: c.apiKey,
            model: rng.weighted(profile.subagentModels),
            sessionId: rng.uuid(),
            parentSessionId: c.sessionId,
            turns: rng.skewed(3, 32, 2),
            startAt: attemptAt + latency + rng.int(200, 2_500),
            profile,
            depth: c.depth + 1,
          }),
        );
      }
      // The parent waits for its subagents.
      at = done + rng.int(500, 4_000);
    } else {
      // Read the answer, type the next thing; now and then wander off for coffee.
      at = attemptAt + latency + (rng.chance(0.015) ? rng.int(6 * 60_000, 25 * 60_000) : rng.skewed(1_500, 150_000, 3));
    }
  }
  return at;
}

function generate(w: World, days: number, keys: Map<string, string>, sharedKey: string): void {
  const { rng } = w;
  for (const profile of CAST) {
    const ownKey = keys.get(profile.name)!;
    for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
      const noon = localTime(w.tz, w.now, daysAgo, 12, 0);
      const weekend = weekdayOf(w.tz, noon) >= 5;
      // Ramp-up: personal keys arrived over the first third of the period, before
      // that everybody was on the shared key. Some never fully switched.
      const progress = 1 - daysAgo / days;
      const sharedChance = progress < 0.22 ? 0.8 : 0.04;
      const mean = profile.threadsPerDay * (weekend ? profile.weekendFactor : 1) * rng.float(0.5, 1.5);
      for (let t = rng.poisson(mean); t > 0; t--) {
        const hour = rng.weighted(profile.hours.map((weight, h) => [h, weight] as const));
        converse(w, {
          apiKey: rng.chance(sharedChance) ? sharedKey : ownKey,
          model: rng.weighted(profile.models),
          sessionId: rng.uuid(),
          turns: Math.max(2, Math.round(profile.stamina * rng.float(0.1, 1) ** 1.6 * 2.2)),
          startAt: localTime(w.tz, w.now, daysAgo, hour, rng.int(0, 59)) + rng.int(0, 59_000),
          profile,
          depth: 0,
        });
      }
    }
  }

  // One for the record books: an all-nighter with a small army of subagents.
  const mira = CAST[0]!;
  converse(w, {
    apiKey: keys.get(mira.name)!,
    model: M.fable,
    sessionId: rng.uuid(),
    turns: 420,
    startAt: localTime(w.tz, w.now, Math.min(days - 1, 4), 23, 12),
    profile: { ...mira, delegation: 0.06 },
    depth: 0,
  });

  // And something happening right now, so the live parts of the board move.
  for (const [profile, model, minutesAgo] of [[CAST[0]!, M.fable, 34], [CAST[1]!, M.sol, 19], [CAST[3]!, M.sonnet, 11]] as const) {
    converse(w, {
      apiKey: keys.get(profile.name)!,
      model,
      sessionId: rng.uuid(),
      turns: 60,
      startAt: w.now - minutesAgo * 60_000,
      profile: { ...profile, delegation: profile.delegation * 2 },
      depth: 0,
    });
  }
}

// ---------------------------------------------------------------- main

async function reset(sql: Db, force: boolean): Promise<void> {
  const [row] = await sql<{ n: string }[]>`select count(*) as n from events`;
  const hasEvents = Number(row?.n ?? 0) > 0;
  const seeded = (await getMeta<boolean>(sql, SEED_MARK)) === true;
  if (hasEvents && !seeded && !force) {
    throw new Error("this database holds events that were not seeded; refusing to wipe it (use --force to do it anyway)");
  }
  await sql`truncate events, sessions, models, api_keys, people cascade`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const option = (name: string, fallback: number) => {
    const i = argv.indexOf(name);
    const value = i === -1 ? fallback : Number(argv[i + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} needs a positive integer`);
    return value;
  };
  const days = option("--days", 24);
  const seed = option("--seed", 20261119);

  const config = loadConfig();
  const sql = connect(config.databaseUrl, 4);
  try {
    await migrate(sql);
    if (flag("--reset")) {
      await reset(sql, flag("--force"));
    } else {
      const [row] = await sql<{ n: string }[]>`select count(*) as n from events`;
      if (Number(row?.n ?? 0) > 0) throw new Error("the database already has events; pass --reset to replace seeded data");
    }

    const [prices] = await sql<{ n: string }[]>`select count(*) as n from model_prices`;
    if (Number(prices?.n ?? 0) === 0 && !flag("--no-prices")) {
      try {
        const res = await refreshPrices(sql, config.pricesUrl);
        console.log(`loaded ${res.models} model prices from LiteLLM`);
      } catch (error) {
        console.warn(`could not load prices, costs will be empty: ${(error as Error).message}`);
      }
    }

    const rng = new Rng(seed);
    const keys = new Map<string, string>();
    for (const profile of CAST) {
      const id = slugify(profile.name);
      const key = `sk-seed-${id}`;
      keys.set(profile.name, key);
      await sql`insert into people (id, name) values (${id}, ${profile.name}) on conflict (id) do update set name = excluded.name`;
      await sql`
        insert into api_keys (key_hash, person_id, label) values (${hashApiKey(key)}, ${id}, 'seed')
        on conflict (key_hash) do nothing`;
    }

    const world: World = { rng, now: Date.now(), tz: config.boardTz, records: [] };
    generate(world, days, keys, "sk-seed-the-old-shared-key");

    const rows = world.records
      .map(normalizeRecord)
      .filter((r): r is EventRow => r !== null && Date.parse(r.ts) <= world.now)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    let stored = 0;
    for (let i = 0; i < rows.length; i += 2000) {
      stored += await insertEvents(sql, rows.slice(i, i + 2000));
      process.stdout.write(`\rinserted ${stored} / ${rows.length} events`);
    }
    process.stdout.write("\n");
    await setMeta(sql, SEED_MARK, true);
    console.log(`seeded ${days} days for ${CAST.length} people (timezone ${config.boardTz}, seed ${seed})`);
  } finally {
    await sql.close({ timeout: 5 }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(`seed: ${(error as Error).message}`);
  process.exit(1);
}
