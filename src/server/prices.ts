// Loads LiteLLM's public price list into `model_prices`.
// How a model finds its price is decided in SQL: see the `model_pricing` view.

import { getMeta, setMeta, type Db } from "./db.ts";

const REFRESHED_KEY = "prices.refreshed_at";

interface PriceRow {
  id: string;
  provider: string | null;
  mode: string | null;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
  cache_creation_input_token_cost_above_1hr: number | null;
  output_cost_per_reasoning_token: number | null;
  fast_multiplier: number | null;
  raw: Record<string, unknown>;
}

function cost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Picks the fields Slopboard prices with out of LiteLLM's file. */
export function parsePriceFile(file: unknown): PriceRow[] {
  if (!isObject(file)) throw new Error("price file is not a JSON object");
  // Keyed by lower-cased id; the first of any ids that collide wins.
  const rows = new Map<string, PriceRow>();
  for (const [key, entry] of Object.entries(file)) {
    const id = key.toLowerCase();
    // "sample_spec" documents the format and is not a model.
    if (id === "sample_spec" || !isObject(entry) || rows.has(id)) continue;
    const extra = isObject(entry.provider_specific_entry) ? entry.provider_specific_entry : {};
    const fast = cost(extra.fast);
    rows.set(id, {
      id,
      provider: typeof entry.litellm_provider === "string" ? entry.litellm_provider : null,
      mode: typeof entry.mode === "string" ? entry.mode : null,
      input_cost_per_token: cost(entry.input_cost_per_token),
      output_cost_per_token: cost(entry.output_cost_per_token),
      cache_read_input_token_cost: cost(entry.cache_read_input_token_cost),
      cache_creation_input_token_cost: cost(entry.cache_creation_input_token_cost),
      cache_creation_input_token_cost_above_1hr: cost(entry.cache_creation_input_token_cost_above_1hr),
      output_cost_per_reasoning_token: cost(entry.output_cost_per_reasoning_token),
      fast_multiplier: fast !== null && fast > 0 ? fast : null,
      raw: entry,
    });
  }
  if (rows.size === 0) throw new Error("price file has no models");
  return [...rows.values()];
}

/**
 * Downloads the price list and upserts it. Models that disappeared from the
 * file keep their last known price, so old events do not silently lose theirs.
 */
export async function refreshPrices(sql: Db, url: string): Promise<{ models: number; changed: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`price list: HTTP ${res.status} from ${url}`);
  const rows = parsePriceFile(await res.json());

  let changed = 0;
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += 250) {
      const chunk = rows.slice(i, i + 250);
      const res = await tx`
        insert into model_prices ${tx(chunk)}
        on conflict (id) do update set
          provider = excluded.provider,
          mode = excluded.mode,
          input_cost_per_token = excluded.input_cost_per_token,
          output_cost_per_token = excluded.output_cost_per_token,
          cache_read_input_token_cost = excluded.cache_read_input_token_cost,
          cache_creation_input_token_cost = excluded.cache_creation_input_token_cost,
          cache_creation_input_token_cost_above_1hr = excluded.cache_creation_input_token_cost_above_1hr,
          output_cost_per_reasoning_token = excluded.output_cost_per_reasoning_token,
          fast_multiplier = excluded.fast_multiplier,
          raw = excluded.raw,
          updated_at = now()
        where model_prices.raw is distinct from excluded.raw
        returning id`;
      changed += res.length;
    }
  });
  await setMeta(sql, REFRESHED_KEY, new Date().toISOString());
  return { models: rows.length, changed };
}

/** Refreshes now if the list is older than `everyHours`, then keeps checking hourly. */
export function schedulePriceRefresh(
  sql: Db,
  url: string,
  everyHours: number,
  log: (message: string) => void = (m) => console.log(`[prices] ${m}`),
): { stop: () => void } {
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const last = await getMeta<string>(sql, REFRESHED_KEY);
      const ageHours = (Date.now() - Date.parse(last ?? "")) / 3_600_000;
      // Never refreshed, or an unreadable timestamp: both mean "do it now".
      if (!(ageHours < everyHours)) {
        const { models, changed } = await refreshPrices(sql, url);
        log(`loaded ${models} models from LiteLLM, ${changed} new or changed`);
      }
    } catch (error) {
      log(`refresh failed, keeping the prices already stored: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), 3_600_000);
  return { stop: () => clearInterval(timer) };
}
