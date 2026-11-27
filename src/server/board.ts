// Builds the Board of src/shared/api.ts out of Postgres.

import type {
  Board,
  BoardTotals,
  CostMode,
  HeatCell,
  LiveEvent,
  ModelRow,
  PersonRow,
  ProviderEconomics,
  RangeKey,
  Timeline,
  TokenCounts,
} from "../shared/api.ts";
import { buildAwards, buildRecords, type PersonStats, type RecordInputs } from "./awards.ts";
import { num, numOrNull, type Db } from "./db.ts";
import { displayModelName } from "./format.ts";
import { buildPoolStatuses, type PoolAccountInput } from "./pools.ts";

export const RANGES: readonly RangeKey[] = ["today", "7d", "30d", "all"];
export const SHARED_ID = "shared";
export const SHARED_NAME = "Shared key";

const PROVIDER_ORDER = ["claude", "codex", "antigravity"];
const PROVIDER_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PROVIDERS = 20;

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

/** Canonical display order for available providers: core providers first, then alphabetical. */
export function sortAvailableProviders(providers: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const p of providers) {
    const clean = p.trim().toLowerCase();
    if (clean) unique.add(clean);
  }
  return [...unique].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a);
    const ib = PROVIDER_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
}

/** Canonical sorted, deduplicated lowercase provider filter, or null when unfiltered. */
export function normalizeProviders(providers: readonly string[] | null | undefined): string[] | null {
  if (!providers || providers.length === 0) return null;
  const set = new Set<string>();
  for (const p of providers) {
    const clean = p.trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return set.size > 0 ? [...set].sort() : null;
}

/** Parses one or more `providers` query parameter values (comma-separated or repeated). */
export function parseProvidersParam(
  rawValues: readonly string[],
): { ok: true; providers: string[] | null } | { ok: false; error: string } {
  if (rawValues.length === 0) return { ok: true, providers: null };
  const set = new Set<string>();
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const clean = part.trim().toLowerCase();
      if (!clean) continue;
      if (!PROVIDER_TOKEN.test(clean)) {
        return { ok: false, error: `invalid provider "${part.trim()}"` };
      }
      set.add(clean);
      if (set.size > MAX_PROVIDERS) {
        return { ok: false, error: `too many providers (max ${MAX_PROVIDERS})` };
      }
    }
  }
  if (set.size === 0) return { ok: false, error: "providers must name at least one provider" };
  return { ok: true, providers: [...set].sort() };
}

/** Whole days before today that the range reaches back. */
const DAYS_BACK: Record<Exclude<RangeKey, "all">, number> = { today: 0, "7d": 6, "30d": 29 };

type Row = Record<string, unknown>;

async function query(sql: Db, text: string, params: unknown[] = []): Promise<Row[]> {
  return (await sql.unsafe(text, params)) as unknown as Row[];
}

// One usage event is one upstream attempt, and all attempts of an inbound
// request share its trace_id. So a request is a successful attempt, or a trace
// in which no attempt succeeded. Counting successes one by one (instead of
// counting traces) is what keeps Codex websocket connections honest: every
// turn on such a connection carries the trace_id of the connection.
const FAILED_REQUESTS = `(count(distinct trace_id) - count(distinct trace_id) filter (where not failed))`;
const REQUESTS = `(count(*) filter (where not failed) + ${FAILED_REQUESTS})`;

// Unclassified tokens have no bucket; they are shown as plain input so that
// totals stay complete. They are never priced (see events_v).
const TOKEN_SUMS = `
  coalesce(sum(input_tokens + unclassified_tokens), 0)::float8 as input,
  coalesce(sum(cache_read_tokens), 0)::float8 as cache_read,
  coalesce(sum(cache_write_tokens), 0)::float8 as cache_write,
  coalesce(sum(output_tokens), 0)::float8 as output,
  coalesce(sum(reasoning_tokens), 0)::float8 as reasoning`;

function tokenCounts(row: Row | undefined): TokenCounts {
  const input = num(row?.input);
  const cacheRead = num(row?.cache_read);
  const cacheWrite = num(row?.cache_write);
  const output = num(row?.output);
  return { input, cacheRead, cacheWrite, output, reasoning: num(row?.reasoning), total: input + cacheRead + cacheWrite + output };
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return null;
}

function date(value: unknown): Date | null {
  const s = iso(value);
  return s ? new Date(s) : null;
}

/** Zero when nothing was used; null only when tokens were used and none of them has a price. */
function costOf(tokens: TokenCounts, cost: unknown): number | null {
  return tokens.total === 0 ? 0 : numOrNull(cost);
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

// ------------------------------------------------------------ slow facts

/** Facts that do not depend on the range and may be a little stale. */
interface SlowFacts {
  at: number;
  /** person id -> local days ("YYYY-MM-DD") with activity. */
  days: Map<string, Set<string>>;
  lastSeen: Map<string, string>;
  today: string;
  heatmap: HeatCell[];
}

const SLOW_TTL_MS = 30_000;
const SLOW_MAX_ENTRIES = 32;
const slowCache = new WeakMap<Db, Map<string, Promise<SlowFacts>>>();

async function loadSlowFacts(sql: Db, tz: string, providers: readonly string[] | null): Promise<SlowFacts> {
  const dayWhere = providers ? `where lower(provider) = any($2::text[])` : "";
  const dayParams: unknown[] = providers ? [tz, providers] : [tz];
  const heatAnd = providers ? `and lower(provider) = any($2::text[])` : "";
  const [dayRows, heatRows, todayRows] = await Promise.all([
    query(
      sql,
      `select person_id, to_char((ts at time zone $1)::date, 'YYYY-MM-DD') as day, max(ts) as last_seen
       from events_v ${dayWhere} group by 1, 2`,
      dayParams,
    ),
    query(
      sql,
      `select extract(isodow from ts at time zone $1)::int - 1 as weekday,
              extract(hour from ts at time zone $1)::int as hour,
              sum(total_tokens)::float8 as tokens,
              ${REQUESTS}::int as requests
       from events_v
       where ts >= (date_trunc('day', now() at time zone $1) - interval '27 days') at time zone $1
       ${heatAnd}
       group by 1, 2
       order by 1, 2`,
      dayParams,
    ),
    query(sql, `select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as today`, [tz]),
  ]);

  const days = new Map<string, Set<string>>();
  const lastSeen = new Map<string, string>();
  for (const r of dayRows) {
    const id = String(r.person_id);
    let set = days.get(id);
    if (!set) days.set(id, (set = new Set()));
    set.add(String(r.day));
    const seen = iso(r.last_seen);
    if (seen && seen > (lastSeen.get(id) ?? "")) lastSeen.set(id, seen);
  }
  return {
    at: Date.now(),
    days,
    lastSeen,
    today: String(todayRows[0]?.today),
    heatmap: heatRows.map((r) => ({
      weekday: num(r.weekday),
      hour: num(r.hour),
      tokens: num(r.tokens),
      requests: num(r.requests),
    })),
  };
}

async function slowFacts(sql: Db, tz: string, providers: readonly string[] | null): Promise<SlowFacts> {
  let byKey = slowCache.get(sql);
  if (!byKey) slowCache.set(sql, (byKey = new Map()));
  const key = `${tz}\0${providers ? providers.join(",") : ""}`;
  const cached = byKey.get(key);
  if (cached) {
    const facts = await cached.catch(() => null);
    if (facts && Date.now() - facts.at < SLOW_TTL_MS) return facts;
  }
  if (byKey.size >= SLOW_MAX_ENTRIES) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
  const fresh = loadSlowFacts(sql, tz, providers);
  byKey.set(key, fresh);
  return await fresh;
}

/** Drops cached facts, for tests and for callers that just changed the data. */
export function resetBoardCaches(sql: Db): void {
  slowCache.delete(sql);
}

function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive active days up to today. A streak that reaches yesterday is
 * still alive, so it does not drop to zero at midnight before the first
 * request of the day.
 */
export function streakDays(days: Set<string> | undefined, today: string): number {
  if (!days) return 0;
  let day = days.has(today) ? today : previousDay(today);
  let streak = 0;
  while (days.has(day)) {
    streak++;
    day = previousDay(day);
  }
  return streak;
}

// ------------------------------------------------------------ the board

export async function buildBoard(
  sql: Db,
  tz: string,
  range: RangeKey,
  collectorLagSeconds: number | null,
  rawProviders: readonly string[] | null = null,
): Promise<Board> {
  const providers = normalizeProviders(rawProviders);
  const days = range === "all" ? 0 : DAYS_BACK[range];
  const [boundsRows, providerRows] = await Promise.all([
    query(
      sql,
      `select now() as now,
              (b.today - make_interval(days => $2::int)) at time zone $1 as since,
              (b.today - make_interval(days => 2 * $2::int + 1)) at time zone $1 as prev_since,
              (select max(ts) from events) as last_event_at,
              (exists (select 1 from subscriptions where not ignored and monthly_cost_usd is not null)
               or exists (select 1 from events where sub_cost_usd is not null)) as has_sub
       from (select date_trunc('day', now() at time zone $1) as today) b`,
      [tz, days],
    ),
    query(sql, `select distinct lower(provider) as provider from models where provider is not null`),
  ]);
  const bounds = boundsRows[0];
  const availableProviders = sortAvailableProviders(providerRows.map((r) => String(r.provider)));
  const now = date(bounds?.now) ?? new Date();
  const rangeStart = range === "all" ? null : date(bounds?.since);
  const prevStart = range === "all" ? null : date(bounds?.prev_since);
  const costMode: CostMode = bounds?.has_sub === true ? "subscription" : "list";
  const costCol = costMode === "subscription" ? "sub_cost_usd" : "api_cost_usd";
  // "all" is spelled as "since the epoch" so every query has the same shape.
  const since = rangeStart ?? new Date(0);
  const unit: Timeline["unit"] = range === "today" ? "hour" : "day";

  const andP = (idx: number) => (providers ? `and lower(provider) = any($${idx}::text[])` : "");
  const whereP = (idx: number) => (providers ? `where lower(provider) = any($${idx}::text[])` : "");
  const withP = (base: unknown[]) => (providers ? [...base, providers] : base);

  const bucketSql =
    range === "today"
      ? `select g at time zone $1 as bucket
         from generate_series(date_trunc('day', now() at time zone $1),
                              date_trunc('hour', now() at time zone $1), interval '1 hour') g`
      : range === "all"
        ? `select g at time zone $1 as bucket
           from generate_series(
             coalesce((select date_trunc('day', min(ts) at time zone $1) from events ${whereP(2)}),
                      date_trunc('day', now() at time zone $1)),
             date_trunc('day', now() at time zone $1), interval '1 day') g`
        : `select g at time zone $1 as bucket
           from generate_series(date_trunc('day', now() at time zone $1) - make_interval(days => ${days}),
                                date_trunc('day', now() at time zone $1), interval '1 day') g`;
  const bucketParams = range === "all" ? withP([tz]) : [tz];

  const [
    registered,
    personRows,
    totalRows,
    personModelRows,
    personHourRows,
    bucketRows,
    timelineRows,
    modelRows,
    providerEconRows,
    providerThreadRows,
    recentRows,
    nowRows,
    prevRows,
    threadRows,
    biggestRequest,
    priciestRequest,
    slowestRequest,
    busiestHour,
    biggestDay,
    slow,
    poolSampleRows,
    poolSubRows,
  ] = await Promise.all([
    query(sql, `select id, name from people order by id`),
    query(
      sql,
      `select person_id,
              ${REQUESTS}::int as requests,
              ${FAILED_REQUESTS}::int as failed_requests,
              ${TOKEN_SUMS},
              sum(${costCol})::float8 as cost,
              sum(api_cost_usd)::float8 as list_cost,
              count(distinct thread_id)::int as threads,
              count(distinct session_id) filter (where is_subagent)::int as subagents,
              coalesce(sum(total_tokens) filter (where is_subagent), 0)::float8 as subagent_tokens,
              count(distinct (ts at time zone $2)::date)::int as active_days,
              max(ts) as last_seen,
              coalesce(sum(total_tokens) filter (where extract(hour from ts at time zone $2) < 5), 0)::float8 as night_tokens,
              coalesce(sum(total_tokens) filter (where extract(hour from ts at time zone $2) between 5 and 8), 0)::float8 as dawn_tokens,
              coalesce(sum(total_tokens) filter (where extract(isodow from ts at time zone $2) >= 6), 0)::float8 as weekend_tokens,
              count(*) filter (where status_code = 429)::int as rate_limits,
              count(distinct requested_model)::int as models_used,
              avg(ttft_ms) filter (where not failed and ttft_ms > 0)::float8 as avg_ttft_ms,
              coalesce(max(input_tokens + cache_read_tokens + cache_write_tokens + unclassified_tokens), 0)::float8 as biggest_prompt
       from events_v
       where ts >= $1 ${andP(3)}
       group by person_id`,
      withP([since, tz]),
    ),
    query(
      sql,
      `select ${REQUESTS}::int as requests,
              ${FAILED_REQUESTS}::int as failed_requests,
              ${TOKEN_SUMS},
              sum(${costCol})::float8 as cost,
              sum(api_cost_usd)::float8 as list_cost,
              count(distinct thread_id)::int as threads,
              count(distinct session_id) filter (where is_subagent)::int as subagents
       from events_v
       where ts >= $1 ${andP(2)}`,
      withP([since]),
    ),
    query(
      sql,
      `select person_id, requested_model as model, sum(total_tokens)::float8 as tokens
       from events_v where ts >= $1 ${andP(2)} group by 1, 2`,
      withP([since]),
    ),
    query(
      sql,
      `select person_id, extract(hour from ts at time zone $2)::int as hour, sum(total_tokens)::float8 as tokens
       from events_v where ts >= $1 ${andP(3)} group by 1, 2`,
      withP([since, tz]),
    ),
    query(sql, bucketSql, bucketParams),
    query(
      sql,
      `select person_id,
              date_trunc('${unit}', ts at time zone $2) at time zone $2 as bucket,
              sum(total_tokens)::float8 as tokens
       from events_v where ts >= $1 ${andP(3)} group by 1, 2`,
      withP([since, tz]),
    ),
    query(
      sql,
      `select requested_model as model,
              mode() within group (order by provider) as provider,
              ${REQUESTS}::int as requests,
              ${TOKEN_SUMS},
              coalesce(sum(input_tokens + 0.1 * cache_read_tokens + 1.25 * cache_write_tokens + 5.0 * output_tokens + unclassified_tokens), 0)::float8 as eff_tokens,
              sum(${costCol})::float8 as cost,
              sum(api_cost_usd)::float8 as list_cost,
              sum(api_cost_usd) filter (where sub_cost_usd is not null and api_cost_usd is not null)::float8 as paired_api_cost,
              sum(sub_cost_usd) filter (where sub_cost_usd is not null and api_cost_usd is not null)::float8 as paired_sub_cost,
              ${costMode === "subscription" ? "bool_or(sub_cost_usd is not null)" : "bool_or(price_source is not null)"} as priced,
              bool_or(price_source is not null) as list_priced
       from events_v
       where ts >= $1 ${andP(2)}
       group by requested_model`,
      withP([since]),
    ),
    query(
      sql,
      `select lower(provider) as provider,
              ${REQUESTS}::int as requests,
              count(distinct thread_id)::int as threads,
              ${TOKEN_SUMS},
              coalesce(sum(input_tokens + 0.1 * cache_read_tokens + 1.25 * cache_write_tokens + 5.0 * output_tokens + unclassified_tokens), 0)::float8 as eff_tokens,
              coalesce(sum(quota_weeks), 0)::float8 as quota_weeks,
              sum(sub_cost_usd)::float8 as sub_cost,
              sum(api_cost_usd)::float8 as list_cost,
              bool_or(sub_cost_usd is not null) as has_sub,
              bool_or(price_source is not null) as has_list,
              sum(api_cost_usd) filter (where sub_cost_usd is not null and api_cost_usd is not null)::float8 as paired_api_cost,
              sum(sub_cost_usd) filter (where sub_cost_usd is not null and api_cost_usd is not null)::float8 as paired_sub_cost,
              sum(quota_weeks) filter (where quota_weeks is not null and api_cost_usd is not null)::float8 as paired_quota_weeks,
              sum(api_cost_usd) filter (where quota_weeks is not null and api_cost_usd is not null)::float8 as paired_quota_api_cost
       from events_v
       where ts >= $1 and provider is not null ${andP(2)}
       group by lower(provider)`,
      withP([since]),
    ),
    query(
      sql,
      `with t as (
         select thread_id,
                mode() within group (order by lower(provider)) as provider,
                count(*) filter (where not failed) as ok_reqs,
                sum(sub_cost_usd)::float8 as sub_cost
         from events_v
         where ts >= $1 and thread_id is not null and provider is not null ${andP(2)}
         group by thread_id
       )
       select provider,
              count(*) filter (where ok_reqs >= 5)::int as substantial_threads,
              percentile_cont(0.5) within group (order by sub_cost) filter (where ok_reqs >= 5 and sub_cost is not null)::float8 as median_sub_cost,
              avg(sub_cost) filter (where ok_reqs >= 5 and sub_cost is not null)::float8 as avg_sub_cost
       from t
       group by provider`,
      withP([since]),
    ),
    query(
      sql,
      `select ts, person_id, requested_model as model, total_tokens::float8 as tokens, ${costCol} as cost_usd, is_subagent, failed
       from events_v ${whereP(1)} order by ts desc limit 30`,
      withP([]),
    ),
    query(
      sql,
      `select coalesce(sum(total_tokens), 0)::float8 / 10 as tpm from events where ts >= now() - interval '10 minutes' ${andP(1)}`,
      withP([]),
    ),
    prevStart
      ? query(
          sql,
          `select person_id, sum(total_tokens)::float8 as tokens
           from events_v where ts >= $1 and ts < $2 ${andP(3)} group by 1`,
          withP([prevStart, since]),
        )
      : Promise.resolve([] as Row[]),
    // Per person, their thread with the most tokens, the longest span and the most subagents.
    query(
      sql,
      `with t as (
         select thread_id,
                mode() within group (order by person_id) as person_id,
                sum(total_tokens)::float8 as tokens,
                ${REQUESTS}::int as requests,
                count(distinct session_id) filter (where is_subagent)::int as subagents,
                min(ts) as started_at,
                extract(epoch from max(ts) - min(ts))::float8 * 1000 as duration_ms,
                -- The model of the main conversation; subagents often run something cheaper.
                coalesce(mode() within group (order by requested_model) filter (where not is_subagent),
                         mode() within group (order by requested_model)) as model
         from events_v
         where ts >= $1 and thread_id is not null ${andP(2)}
         group by thread_id
       ), r as (
         select t.*,
                row_number() over (partition by person_id order by tokens desc, thread_id) as rn_tokens,
                row_number() over (partition by person_id order by duration_ms desc, thread_id) as rn_duration,
                row_number() over (partition by person_id order by subagents desc, thread_id) as rn_subagents
         from t
       )
       select * from r where rn_tokens = 1 or rn_duration = 1 or rn_subagents = 1`,
      withP([since]),
    ),
    query(
      sql,
      `select ts, person_id, requested_model as model, total_tokens::float8 as tokens,
              cache_read_tokens::float8 as cache_read,
              (input_tokens + cache_read_tokens + cache_write_tokens)::float8 as prompt
       from events_v where ts >= $1 and total_tokens > 0 ${andP(2)}
       order by total_tokens desc, ts limit 1`,
      withP([since]),
    ),
    query(
      sql,
      `select ts, person_id, requested_model as model, total_tokens::float8 as tokens, ${costCol} as cost_usd
       from events_v where ts >= $1 and ${costCol} > 0 ${andP(2)}
       order by ${costCol} desc, ts limit 1`,
      withP([since]),
    ),
    query(
      sql,
      `select ts, person_id, requested_model as model, total_tokens::float8 as tokens, latency_ms::float8 as latency_ms
       from events_v where ts >= $1 and not failed and latency_ms > 0 ${andP(2)}
       order by latency_ms desc, ts limit 1`,
      withP([since]),
    ),
    query(
      sql,
      `select person_id,
              date_trunc('hour', ts at time zone $2) at time zone $2 as bucket,
              sum(total_tokens)::float8 as tokens,
              ${REQUESTS}::int as requests
       from events_v where ts >= $1 ${andP(3)}
       group by 1, 2 order by tokens desc, bucket limit 1`,
      withP([since, tz]),
    ),
    query(
      sql,
      `select person_id,
              date_trunc('day', ts at time zone $2) at time zone $2 as bucket,
              sum(total_tokens)::float8 as tokens,
              ${REQUESTS}::int as requests
       from events_v where ts >= $1 ${andP(3)}
       group by 1, 2 order by tokens desc, bucket limit 1`,
      withP([since, tz]),
    ),
    slowFacts(sql, tz, providers),
    query(
      sql,
      `select lower(provider) as provider, source, ts, used_pct, reset_at, plan
       from quota_samples
       where window_id = 'seven_day'
         and ts >= now() - interval '14 days'
         ${andP(1)}
       order by provider, source, ts`,
      withP([]),
    ),
    query(
      sql,
      `select lower(provider) as provider, source, plan, ignored
       from subscriptions ${whereP(1)}`,
      withP([]),
    ),
  ]);

  // ---- timeline
  const buckets = bucketRows.map((r) => iso(r.bucket)).filter((b): b is string => b !== null);
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));
  const seriesOf = new Map<string, number[]>();
  for (const r of timelineRows) {
    const i = bucketIndex.get(iso(r.bucket) ?? "");
    if (i === undefined) continue;
    const id = String(r.person_id);
    let series = seriesOf.get(id);
    if (!series) seriesOf.set(id, (series = new Array<number>(buckets.length).fill(0)));
    series[i] = (series[i] ?? 0) + num(r.tokens);
  }

  // ---- per person lookups
  const topModel = new Map<string, { model: string; tokens: number }>();
  const topPerson = new Map<string, { id: string; tokens: number }>();
  for (const r of personModelRows) {
    const id = String(r.person_id);
    const model = String(r.model);
    const tokens = num(r.tokens);
    const bestModel = topModel.get(id);
    if (!bestModel || tokens > bestModel.tokens || (tokens === bestModel.tokens && model < bestModel.model)) {
      topModel.set(id, { model, tokens });
    }
    const bestPerson = topPerson.get(model);
    if (tokens > 0 && (!bestPerson || tokens > bestPerson.tokens || (tokens === bestPerson.tokens && id < bestPerson.id))) {
      topPerson.set(model, { id, tokens });
    }
  }
  const peakHour = new Map<string, { hour: number; tokens: number }>();
  for (const r of personHourRows) {
    const id = String(r.person_id);
    const hour = num(r.hour);
    const tokens = num(r.tokens);
    const best = peakHour.get(id);
    if (tokens > 0 && (!best || tokens > best.tokens || (tokens === best.tokens && hour < best.hour))) {
      peakHour.set(id, { hour, tokens });
    }
  }
  // ---- people: everyone registered, plus the shared row once it has ever had traffic
  const names = new Map<string, string>(registered.map((r) => [String(r.id), String(r.name)]));
  const statsById = new Map<string, Row>(personRows.map((r) => [String(r.person_id), r]));
  // Any id that is not a registered person is the shared row. The all-time
  // facts are a little stale, so also look at what this very board mentions.
  const mentionsShared = [personRows, prevRows, recentRows].some((rows) => rows.some((r) => !names.has(String(r.person_id))));
  const sharedEver = mentionsShared || [...slow.lastSeen.keys()].some((id) => !names.has(id));
  const ids = new Set<string>([...names.keys(), ...(sharedEver ? [SHARED_ID] : [])]);

  // Ranks are among assigned people only: the shared row is not a contestant,
  // and must not push anyone down, now or in the window before.
  const previousRank = new Map<string, number>();
  prevRows
    .map((r) => ({ id: String(r.person_id), tokens: num(r.tokens) }))
    .filter((p) => p.tokens > 0 && names.has(p.id))
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
    .forEach((p, i) => previousRank.set(p.id, i + 1));

  const stats: PersonStats[] = [];
  const people: PersonRow[] = [];
  for (const id of ids) {
    const row = statsById.get(id);
    const unassigned = !names.has(id);
    const tokens = tokenCounts(row);
    const inputSide = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    const rangeLastSeen = iso(row?.last_seen);
    const allTimeLastSeen = slow.lastSeen.get(id) ?? null;
    const person: PersonRow = {
      id,
      name: names.get(id) ?? SHARED_NAME,
      unassigned,
      rank: 0,
      previousRank: range === "all" || unassigned ? null : (previousRank.get(id) ?? null),
      requests: num(row?.requests),
      failedRequests: num(row?.failed_requests),
      tokens,
      costUsd: costOf(tokens, row?.cost),
      listCostUsd: costOf(tokens, row?.list_cost),
      threads: num(row?.threads),
      subagents: num(row?.subagents),
      subagentTokenShare: ratio(num(row?.subagent_tokens), tokens.total),
      cacheHitRate: ratio(tokens.cacheRead, inputSide),
      topModel: topModel.has(id) && tokens.total > 0 ? displayModelName(topModel.get(id)!.model) : null,
      activeDays: num(row?.active_days),
      streakDays: streakDays(slow.days.get(id), slow.today),
      peakHour: peakHour.get(id)?.hour ?? null,
      lastSeenAt:
        rangeLastSeen && allTimeLastSeen
          ? rangeLastSeen > allTimeLastSeen
            ? rangeLastSeen
            : allTimeLastSeen
          : (rangeLastSeen ?? allTimeLastSeen),
      spark: seriesOf.get(id) ?? new Array<number>(buckets.length).fill(0),
    };
    people.push(person);
    stats.push({
      person,
      nightTokens: num(row?.night_tokens),
      dawnTokens: num(row?.dawn_tokens),
      weekendTokens: num(row?.weekend_tokens),
      rateLimits: num(row?.rate_limits),
      modelsUsed: num(row?.models_used),
      avgTtftMs: numOrNull(row?.avg_ttft_ms),
      biggestPrompt: num(row?.biggest_prompt),
    });
  }
  // Assigned people in rank order, then the unassigned row, which has no rank.
  people.sort(
    (a, b) =>
      Number(a.unassigned) - Number(b.unassigned) ||
      b.tokens.total - a.tokens.total ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  people.forEach((p, i) => (p.rank = p.unassigned ? 0 : i + 1));

  const timeline: Timeline = { unit, buckets, series: Object.fromEntries(people.map((p) => [p.id, p.spark])) };

  // ---- models
  const models: ModelRow[] = modelRows
    .map((r) => {
      const model = String(r.model);
      const priced = r.priced === true;
      const listPriced = r.list_priced === true;
      const pairedApi = numOrNull(r.paired_api_cost);
      const pairedSub = numOrNull(r.paired_sub_cost);
      const subsidyMultiplier =
        pairedApi !== null && pairedSub !== null && pairedApi > 0 && pairedSub > 0
          ? pairedApi / pairedSub
          : null;
      return {
        model,
        displayName: displayModelName(model),
        provider: String(r.provider ?? "unknown"),
        requests: num(r.requests),
        tokens: tokenCounts(r),
        effectiveTokens: num(r.eff_tokens),
        costUsd: priced ? numOrNull(r.cost) : null,
        listCostUsd: listPriced ? numOrNull(r.list_cost) : null,
        subsidyMultiplier,
        priced,
        topPersonId: topPerson.get(model)?.id ?? null,
      };
    })
    .sort((a, b) => b.tokens.total - a.tokens.total || a.model.localeCompare(b.model));

  // ---- provider economics
  const threadStatsByProvider = new Map<string, Row>(
    providerThreadRows.map((r) => [String(r.provider).toLowerCase(), r]),
  );
  const providerEconomics: ProviderEconomics[] = providerEconRows
    .map((r) => {
      const provider = String(r.provider).toLowerCase();
      const tokens = tokenCounts(r);
      const effectiveTokens = num(r.eff_tokens);
      const subCostUsd = r.has_sub === true ? numOrNull(r.sub_cost) : null;
      const listCostUsd = r.has_list === true ? numOrNull(r.list_cost) : null;
      const pairedApi = numOrNull(r.paired_api_cost);
      const pairedSub = numOrNull(r.paired_sub_cost);
      const subsidyMultiplier =
        pairedApi !== null && pairedSub !== null && pairedApi > 0 && pairedSub > 0
          ? pairedApi / pairedSub
          : null;
      const pairedQuotaApi = numOrNull(r.paired_quota_api_cost);
      const pairedQuotaWeeks = numOrNull(r.paired_quota_weeks);
      const apiUsdPerQuotaWeek =
        pairedQuotaApi !== null && pairedQuotaWeeks !== null && pairedQuotaApi > 0 && pairedQuotaWeeks > 0
          ? pairedQuotaApi / pairedQuotaWeeks
          : null;
      const subUsdPerMillionEffTokens =
        subCostUsd !== null && subCostUsd > 0 && effectiveTokens > 0
          ? (subCostUsd / effectiveTokens) * 1e6
          : null;
      const outputTokensPerSubDollar =
        subCostUsd !== null && subCostUsd > 0 && tokens.output > 0
          ? tokens.output / subCostUsd
          : null;
      const tRow = threadStatsByProvider.get(provider);
      const inputSide = tokens.input + tokens.cacheRead + tokens.cacheWrite;
      return {
        provider,
        requests: num(r.requests),
        threads: num(r.threads),
        substantialThreads: num(tRow?.substantial_threads),
        tokens,
        effectiveTokens,
        subCostUsd,
        listCostUsd,
        quotaWeeks: num(r.quota_weeks),
        subsidyMultiplier,
        apiUsdPerQuotaWeek,
        subUsdPerMillionEffTokens,
        outputTokensPerSubDollar,
        medianThreadSubCostUsd: numOrNull(tRow?.median_sub_cost),
        avgThreadSubCostUsd: numOrNull(tRow?.avg_sub_cost),
        cacheHitRate: ratio(tokens.cacheRead, inputSide),
      };
    })
    .sort((a, b) => {
      if (a.subsidyMultiplier !== null && b.subsidyMultiplier !== null && a.subsidyMultiplier !== b.subsidyMultiplier) {
        return b.subsidyMultiplier - a.subsidyMultiplier;
      }
      if (a.subsidyMultiplier !== null) return -1;
      if (b.subsidyMultiplier !== null) return 1;
      return b.tokens.total - a.tokens.total || a.provider.localeCompare(b.provider);
    });

  // ---- totals
  const totalRow = totalRows[0];
  const totalTokens = tokenCounts(totalRow);
  const totals: BoardTotals = {
    requests: num(totalRow?.requests),
    failedRequests: num(totalRow?.failed_requests),
    tokens: totalTokens,
    costUsd: costOf(totalTokens, totalRow?.cost),
    listCostUsd: costOf(totalTokens, totalRow?.list_cost),
    threads: num(totalRow?.threads),
    subagents: num(totalRow?.subagents),
    people: people.filter((p) => !p.unassigned && p.requests > 0).length,
    tokensPerMinuteNow: Math.round(num(nowRows[0]?.tpm)),
  };

  const recent: LiveEvent[] = recentRows.map((r) => ({
    at: iso(r.ts) ?? now.toISOString(),
    personId: String(r.person_id),
    model: String(r.model),
    modelName: displayModelName(String(r.model)),
    totalTokens: num(r.tokens),
    costUsd: numOrNull(r.cost_usd),
    subagent: r.is_subagent === true,
    failed: r.failed === true,
  }));

  const recordInputs: RecordInputs = {
    tz,
    // A weekday alone names a moment only within the last week.
    withDate: range === "30d" || range === "all",
    threads: threadRows,
    biggestRequest: biggestRequest[0],
    priciestRequest: priciestRequest[0],
    slowestRequest: slowestRequest[0],
    busiestHour: busiestHour[0],
    biggestDay: biggestDay[0],
  };

  const poolSubs = new Map<string, { plan: string | null; ignored: boolean }>();
  for (const r of poolSubRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    poolSubs.set(`${provider}\0${source}`, {
      plan: r.plan ? String(r.plan) : null,
      ignored: r.ignored === true,
    });
  }
  const poolInputs = new Map<string, PoolAccountInput>();
  for (const r of poolSampleRows) {
    const provider = String(r.provider).toLowerCase();
    const source = String(r.source);
    const key = `${provider}\0${source}`;
    let acc = poolInputs.get(key);
    if (!acc) {
      const sub = poolSubs.get(key);
      acc = {
        provider,
        source,
        explicitPlan: sub?.plan ?? null,
        ignored: sub?.ignored ?? false,
        samples: [],
      };
      poolInputs.set(key, acc);
    }
    const tsDate = date(r.ts);
    if (!tsDate) continue;
    const resetDate = date(r.reset_at);
    acc.samples.push({
      tsMs: tsDate.getTime(),
      usedPct: num(r.used_pct),
      resetAtMs: resetDate ? resetDate.getTime() : null,
      plan: r.plan ? String(r.plan) : null,
    });
  }
  const pools = buildPoolStatuses([...poolInputs.values()], now.getTime(), providers);

  return {
    generatedAt: now.toISOString(),
    range,
    rangeStart: rangeStart?.toISOString() ?? null,
    timezone: tz,
    costMode,
    providers,
    availableProviders,
    pools,
    lastEventAt: iso(bounds?.last_event_at),
    collectorLagSeconds,
    totals,
    people,
    models,
    providerEconomics,
    timeline,
    heatmap: slow.heatmap,
    awards: buildAwards(stats, threadRows, costMode),
    records: buildRecords(recordInputs),
    recent,
  };
}

// ------------------------------------------------------------ caching

interface CacheEntry {
  at: number;
  board: Board | null;
  inflight: Promise<Board> | null;
}

const BOARD_CACHE_MAX_ENTRIES = 64;

/**
 * Serves boards from memory for `ttlMs`, with one query run per (range, providers)
 * key no matter how many tabs ask at once. A board older than that but not ancient
 * is still returned at once while a fresh one is built in the background.
 */
export class BoardCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly build: (range: RangeKey, providers: string[] | null) => Promise<Board>,
    private readonly ttlMs: number,
  ) {}

  async get(range: RangeKey, rawProviders: readonly string[] | null = null): Promise<Board> {
    const providers = normalizeProviders(rawProviders);
    const key = `${range}\0${providers ? providers.join(",") : ""}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= BOARD_CACHE_MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      entry = { at: 0, board: null, inflight: null };
      this.entries.set(key, entry);
    }
    const age = Date.now() - entry.at;
    const cached = entry.board;
    if (cached && age < this.ttlMs) return cached;

    if (!entry.inflight) {
      entry.inflight = this.build(range, providers)
        .then((board) => {
          entry.board = board;
          entry.at = Date.now();
          return board;
        })
        .finally(() => {
          entry.inflight = null;
        });
      // A failed background refresh must not become an unhandled rejection.
      entry.inflight.catch(() => {});
    }
    if (cached && age < this.ttlMs * 6) return cached;
    return await entry.inflight;
  }

  clear(): void {
    this.entries.clear();
  }
}
