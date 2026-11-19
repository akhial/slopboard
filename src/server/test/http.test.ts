import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import type { Server } from "bun";
import type { ApiError, Board, Health, SqlResult } from "../../shared/api.ts";
import { BOARD_PATH } from "../../shared/api.ts";
import { RANGES } from "../board.ts";
import { Collector } from "../collector.ts";
import { ensureReadonlyRole } from "../db.ts";
import { startServer } from "../http.ts";
import { hashApiKey } from "../ingest.ts";
import { ProxyClient } from "../proxy.ts";
import { usageRecord } from "../synthetic.ts";
import { assertBoard } from "./contract.ts";
import { FakeProxy } from "./fake-proxy.ts";
import index from "./fixtures/index.html";
import { createTestDb, SETUP_TIMEOUT, type TestDb } from "./pg.ts";

// Talks to Postgres (and may be the file that starts its container).
setDefaultTimeout(30_000);

let db: TestDb;
let proxy: FakeProxy;
let collector: Collector;
let server: Server<undefined>;
let withoutSql: Server<undefined>;

const KEY = "sk-http-test-key";

beforeAll(async () => {
  db = await createTestDb("http");
  await ensureReadonlyRole(db.sql, db.roUrl, 2000);
  proxy = new FakeProxy();
  await db.sql`insert into people (id, name) values ('ada', 'Ada')`;
  await db.sql`insert into api_keys (key_hash, person_id) values (${hashApiKey(KEY)}, 'ada')`;
  collector = new Collector({
    sql: db.sql,
    proxy: new ProxyClient(proxy.url, proxy.managementKey),
    pollIntervalMs: 50,
    batch: 100,
    maxPending: 1000,
    log: () => {},
  });
  const base = { sql: db.sql, index, boardTz: "Europe/Berlin", host: "127.0.0.1", port: 0, sqlTimeoutMs: 2000, sqlMaxRows: 3, sqlMaxBytes: 100_000, healthCacheMs: 0 };
  server = startServer({ ...base, roUrl: db.roUrl, collector, boardCacheMs: 60_000 });
  withoutSql = startServer({ ...base, roUrl: null, collector: null, boardCacheMs: 0 });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await server.stop(true);
  await withoutSql.stop(true);
  await proxy.stop();
  await db.close();
});

const get = (path: string, from = server) => fetch(new URL(path, from.url));
const postSql = (body: unknown, from = server) =>
  fetch(new URL("/api/sql", from.url), { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("http", () => {
  test("health before and after the first poll", async () => {
    const before = (await (await get("/api/health")).json()) as Health;
    // The database is fine, but the collector has not reached the proxy yet.
    expect(before).toEqual({ ok: false, db: true, collectorLagSeconds: null, events: 0 });

    proxy.queue.push(
      ...Array.from({ length: 4 }, (_, i) =>
        usageRecord({ kind: "claude", at: new Date(Date.now() - i * 1000), apiKey: KEY, model: "claude-sonnet-5-5", usage: { input: 10, cacheRead: 80, cacheWrite: 5, answer: 5, reasoning: 0 } }),
      ),
    );
    await collector.tick();

    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as Health).toMatchObject({ ok: true, db: true, events: 4 });
    // Without a collector there is nothing to wait for.
    expect((await (await get("/api/health", withoutSql)).json()) as Health).toMatchObject({ ok: true, collectorLagSeconds: null });
  });

  test("the board is served for every range and matches the contract", async () => {
    expect(BOARD_PATH).toBe("/api/board");
    for (const range of RANGES) {
      const res = await get(`${BOARD_PATH}?range=${range}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const board: unknown = await res.json();
      assertBoard(board);
      expect(board.range).toBe(range);
      expect(board.timezone).toBe("Europe/Berlin");
      expect(board.people.map((p) => [p.id, p.requests, p.tokens.total])).toEqual([["ada", 4, 400]]);
      expect(typeof board.collectorLagSeconds).toBe("number");
    }
    // No range means the last seven days.
    expect(((await (await get(BOARD_PATH)).json()) as Board).range).toBe("7d");
  });

  test("the board is cached, the collector lag is not", async () => {
    const first = (await (await get(`${BOARD_PATH}?range=today`)).json()) as Board;
    await db.sql`update events set input_tokens = input_tokens + 1`;
    const second = (await (await get(`${BOARD_PATH}?range=today`)).json()) as Board;
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.totals.tokens.total).toBe(first.totals.tokens.total);
    // The server with caching off sees the change at once.
    const live = (await (await get(`${BOARD_PATH}?range=today`, withoutSql)).json()) as Board;
    expect(live.totals.tokens.total).toBe(first.totals.tokens.total + 4);
    expect(live.collectorLagSeconds).toBeNull();
  });

  test("a bad range and unknown paths are refused with an ApiError", async () => {
    const bad = await get(`${BOARD_PATH}?range=forever`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiError).error).toContain("today, 7d, 30d, all");
    expect((await get("/api/nope")).status).toBe(404);
    expect((await fetch(new URL(BOARD_PATH, server.url), { method: "POST" })).status).toBe(405);
    expect((await get("/api/sql")).status).toBe(405);
  });

  test("POST /api/sql runs read-only queries", async () => {
    const res = await postSql({ sql: "select person_id, count(*)::int as n from events_v group by 1" });
    expect(res.status).toBe(200);
    expect((await res.json()) as SqlResult).toMatchObject({ columns: ["person_id", "n"], rows: [["ada", 4]], rowCount: 1, truncated: false });

    const capped = (await (await postSql({ sql: "select event_id from events" })).json()) as SqlResult;
    expect(capped).toMatchObject({ rowCount: 3, truncated: true });

    for (const [body, status] of [
      [{ sql: "delete from events" }, 400],
      [{ sql: "select 1; select 2" }, 400],
      [{ sql: "select nope" }, 400],
      [{ sql: 42 }, 400],
      [{}, 400],
      ["not json", 400],
    ] as const) {
      const refused = await postSql(body);
      expect(refused.status).toBe(status);
      expect(typeof ((await refused.json()) as ApiError).error).toBe("string");
    }
    expect((await db.sql`select count(*) as n from events`)[0]!.n).toBe("4");

    // Nothing one request does to its session is there for the next one.
    await postSql({ sql: "select set_config('standard_conforming_strings', 'off', false), set_config('statement_timeout', '0', false)" });
    const after = (await (await postSql({ sql: "select current_setting('standard_conforming_strings'), current_setting('statement_timeout')" })).json()) as SqlResult;
    expect(after.rows).toEqual([["on", "2s"]]);
    // A result too large for the byte budget is cut short, not sent.
    const big = await postSql({ sql: "select repeat('x', 5000000) as big" });
    const bigBody = await big.text();
    expect(big.status).toBe(200);
    expect(bigBody.length).toBeLessThan(1000);
    expect(JSON.parse(bigBody) as SqlResult).toMatchObject({ columns: ["big"], rowCount: 0, truncated: true });

    const off = await postSql({ sql: "select 1" }, withoutSql);
    expect(off.status).toBe(503);
    expect(((await off.json()) as ApiError).error).toContain("DATABASE_RO_URL");
  });

  test("the UI is served at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Slopboard test page");
  });
});
