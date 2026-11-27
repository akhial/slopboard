// The HTTP surface: the three endpoints of src/shared/api.ts plus the UI.

import type { Server } from "bun";
import { BOARD_PATH, type ApiError, type Board, type Health, type RangeKey } from "../shared/api.ts";
import { BoardCache, buildBoard, isRangeKey, parseProvidersParam, RANGES } from "./board.ts";
import type { Collector } from "./collector.ts";
import { num, type Db } from "./db.ts";
import { runReadOnly, SqlGate, SqlRequestError } from "./sqlapi.ts";

export interface ServerDeps {
  sql: Db;
  /** DATABASE_RO_URL: how POST /api/sql connects, anew for every request. Null switches it off. */
  roUrl: string | null;
  collector: Collector | null;
  /** The UI: Bun's HTML import of src/web/index.html. */
  index: Bun.HTMLBundle;
  boardTz: string;
  host: string;
  port: number;
  boardCacheMs: number;
  sqlTimeoutMs: number;
  sqlMaxRows: number;
  sqlMaxBytes: number;
  /** How long /api/health reuses its count of events. */
  healthCacheMs?: number;
  development?: boolean;
}

/** The collector counts as healthy while the proxy answered within this long. */
const HEALTHY_LAG_SECONDS = 120;
const MAX_SQL_BYTES = 100_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(error: string, status: number): Response {
  return json({ error } satisfies ApiError, status);
}

export function startServer(deps: ServerDeps): Server<undefined> {
  const lag = () => deps.collector?.lagSeconds() ?? null;
  const boards = new BoardCache(
    (range: RangeKey, providers: string[] | null) => buildBoard(deps.sql, deps.boardTz, range, lag(), providers),
    deps.boardCacheMs,
  );

  const sqlGate = new SqlGate();
  let eventCount = { at: 0, value: 0 };

  async function board(req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const range = params.get("range") ?? "7d";
    if (!isRangeKey(range)) return fail(`range must be one of ${RANGES.join(", ")}`, 400);
    const parsedProviders = parseProvidersParam(params.getAll("providers"));
    if (!parsedProviders.ok) return fail(parsedProviders.error, 400);
    try {
      const cached = await boards.get(range, parsedProviders.providers);
      // The lag keeps moving while the rest of the board sits in the cache.
      return json({ ...cached, collectorLagSeconds: lag() } satisfies Board);
    } catch (error) {
      console.error(`[http] board ${range} failed: ${(error as Error).stack ?? error}`);
      return fail("the board could not be built, see the server log", 503);
    }
  }

  async function health(): Promise<Response> {
    let db = true;
    try {
      if (Date.now() - eventCount.at >= (deps.healthCacheMs ?? 5000)) {
        const rows = await deps.sql`select count(*) as n from events`;
        eventCount = { at: Date.now(), value: num(rows[0]?.n) };
      } else {
        await deps.sql`select 1`;
      }
    } catch {
      db = false;
    }
    const seconds = lag();
    const collectorOk = deps.collector === null || (seconds !== null && seconds <= HEALTHY_LAG_SECONDS);
    const body: Health = { ok: db && collectorOk, db, collectorLagSeconds: seconds, events: eventCount.value };
    // The status follows the database only: a proxy that is down is reported, not fatal.
    return json(body, db ? 200 : 503);
  }

  async function sqlEndpoint(req: Request): Promise<Response> {
    const roUrl = deps.roUrl;
    if (!roUrl) return fail("POST /api/sql is disabled: DATABASE_RO_URL is not set", 503);
    let text: unknown;
    try {
      const raw = await req.text();
      if (raw.length > MAX_SQL_BYTES) return fail("query too large", 413);
      text = (JSON.parse(raw) as { sql?: unknown } | null)?.sql;
    } catch {
      return fail('body must be JSON like {"sql": "select ..."}', 400);
    }
    if (typeof text !== "string") return fail('body must be JSON like {"sql": "select ..."}', 400);
    try {
      const limits = { timeoutMs: deps.sqlTimeoutMs, maxRows: deps.sqlMaxRows, maxBytes: deps.sqlMaxBytes };
      const query = text;
      return json(await sqlGate.run(() => runReadOnly(roUrl, query, limits)));
    } catch (error) {
      if (error instanceof SqlRequestError) return fail(error.message, error.status);
      console.error(`[http] sql failed: ${(error as Error).stack ?? error}`);
      return fail("query failed", 500);
    }
  }

  const methodNotAllowed = () => fail("method not allowed", 405);

  return Bun.serve({
    hostname: deps.host,
    port: deps.port,
    development: deps.development ?? false,
    routes: {
      "/": deps.index,
      [BOARD_PATH]: { GET: board, POST: methodNotAllowed },
      "/api/health": { GET: health },
      "/api/sql": { POST: sqlEndpoint, GET: methodNotAllowed },
      "/api/*": () => fail("not found", 404),
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
    error(error) {
      console.error(`[http] ${error.stack ?? error}`);
      return fail("internal error", 500);
    },
  });
}
