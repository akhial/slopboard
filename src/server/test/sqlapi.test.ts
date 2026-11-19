import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { connect, ensureReadonlyRole, migrate, type Db } from "../db.ts";
import { insertEvents, normalizeRecord } from "../ingest.ts";
import { runReadOnly, singleStatement, SqlGate, SqlRequestError } from "../sqlapi.ts";
import { usageRecord } from "../synthetic.ts";
import { createTestDb, SETUP_TIMEOUT, type TestDb } from "./pg.ts";

// Talks to Postgres (and may be the file that starts its container).
setDefaultTimeout(30_000);

let db: TestDb;
/** A connection as the read-only role, for checking what the role itself may do. */
let ro: Db;
let roRole: string;
const limits = { timeoutMs: 1500, maxRows: 5, maxBytes: 200_000 };
const run = (sql: string, over: Partial<typeof limits> = {}) => runReadOnly(db.roUrl, sql, { ...limits, ...over });

beforeAll(async () => {
  db = await createTestDb("sqlapi");
  roRole = await ensureReadonlyRole(db.sql, db.roUrl, limits.timeoutMs);
  // Running it again, as every boot does, is harmless.
  await ensureReadonlyRole(db.sql, db.roUrl, limits.timeoutMs);
  ro = connect(db.roUrl, 1);
  const rows = Array.from({ length: 12 }, (_, i) =>
    normalizeRecord(
      usageRecord({ kind: "claude", at: new Date(Date.now() - i * 1000), apiKey: "sk-sql-test", model: "m", usage: { input: i, cacheRead: 0, cacheWrite: 0, answer: 1, reasoning: 0 } }),
    )!,
  );
  await insertEvents(db.sql, rows);
}, SETUP_TIMEOUT);

afterAll(async () => {
  await ro.close({ timeout: 2 }).catch(() => {});
  await db.close();
});

const rejects = async (sql: string): Promise<SqlRequestError> => {
  try {
    await run(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(SqlRequestError);
    return error as SqlRequestError;
  }
  throw new Error(`expected a rejection for: ${sql}`);
};

describe("singleStatement", () => {
  test("accepts one statement, with or without a trailing semicolon", () => {
    expect(singleStatement("select 1")).toBe("select 1");
    expect(singleStatement("  select 1 ;  \n")).toBe("select 1");
    expect(singleStatement("select 1; -- done")).toBe("select 1");
    expect(singleStatement("select 1; /* a; b */ ;")).toBe("select 1");
  });

  test("a semicolon inside a string, identifier, comment or dollar quote is not a separator", () => {
    for (const sql of [
      "select ';' as a",
      "select 'it''s; fine'",
      `select 1 as "a;b"`,
      "select 1 -- ; drop table events",
      "select /* ; */ 1",
      "select $$ ; $$",
      "select $tag$ ; $$ ; $tag$",
      "select E'a\\';b'",
    ]) {
      expect(singleStatement(sql)).toBe(sql);
    }
  });

  test("rejects a second statement however it is dressed up", () => {
    for (const sql of [
      "select 1; select 2",
      "select 1; drop table events",
      "select 'a'; delete from events --'",
      // In an E'' string the backslash escapes the quote, so the string ends at the second quote.
      "select E'\\''; drop table events --'",
      "select $$a$$; select $$b$$",
      "select 1; 'x'",
      'select 1; "x"',
      "select 1; $$x$$",
      "select 1 /* x */; commit; select 2",
    ]) {
      expect(() => singleStatement(sql)).toThrow("only one statement");
    }
    for (const sql of ["", "  ;  ", "-- nothing"]) expect(() => singleStatement(sql)).toThrow("empty query");
    expect(() => singleStatement("select 'open")).toThrow("unterminated");
    expect(() => singleStatement("select /* open")).toThrow("unterminated");
    // The wrapper statement binds $1 and $2 itself.
    expect(() => singleStatement("select $1")).toThrow("parameters");
    expect(singleStatement("select '$1', $a$ $2 $a$")).toBe("select '$1', $a$ $2 $a$");
  });
});

describe("POST /api/sql backend", () => {
  test("returns columns and rows as arrays", async () => {
    const res = await run("select count(*) as n, sum(input_tokens) as input, max(ts) as last from events");
    expect(res.columns).toEqual(["n", "input", "last"]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.slice(0, 2).map(Number)).toEqual([12, 66]);
    expect(String(res.rows[0]![2])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res).toMatchObject({ rowCount: 1, truncated: false });
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("keeps columns that share a name, and names them even with no rows", async () => {
    const twins = await run("select 1 as a, 2 as a, null as b, '{\"k\": [1]}'::jsonb as j");
    expect(twins.columns).toEqual(["a", "a", "b", "j"]);
    expect(twins.rows).toEqual([[1, 2, null, { k: [1] }]]);
    const empty = await run("select event_id, model from events where false");
    expect(empty).toMatchObject({ columns: ["event_id", "model"], rows: [], rowCount: 0, truncated: false });
    // Names the wrapper uses internally are no problem as column names.
    const clash = await run("select 1 as total, 2 as fit, 3 as w, 4 as m");
    expect(clash).toMatchObject({ columns: ["total", "fit", "w", "m"], rows: [[1, 2, 3, 4]] });
  });

  test("stops at the row cap and says so", async () => {
    const capped = await run("select input_tokens from events order by input_tokens");
    expect(capped.rows.map((r) => Number(r[0]))).toEqual([0, 1, 2, 3, 4]);
    expect(capped).toMatchObject({ rowCount: 5, truncated: true });
    const exact = await run("select input_tokens from events order by input_tokens limit 5");
    expect(exact).toMatchObject({ rowCount: 5, truncated: false });
    // A huge result is cut off inside Postgres, not after it was all fetched.
    const huge = await run("select 1 from events a, events b, events c, events d, events e, events f, events g");
    expect(huge).toMatchObject({ rowCount: 5, truncated: true });
  });

  test("stops at the byte budget and says so", async () => {
    // Each row is about 50 kB; 200 kB of budget holds three of them.
    const wide = await run("select g, repeat('x', 50000) as pad from generate_series(1, 5) g");
    expect(wide.rows.map((r) => r[0])).toEqual([1, 2, 3]);
    expect(wide).toMatchObject({ columns: ["g", "pad"], rowCount: 3, truncated: true });
    // The order of the query is the order of the cut.
    const ordered = await run("select g from generate_series(1, 5) g order by g desc", { maxBytes: 6 });
    expect(ordered.rows).toEqual([[5], [4]]);
    expect(ordered.truncated).toBe(true);

    // A single value larger than the budget is not sent at all.
    const before = process.memoryUsage().rss;
    const big = await run("select repeat('x', 30000000) as big");
    expect(big).toMatchObject({ columns: ["big"], rows: [], rowCount: 0, truncated: true });
    expect(JSON.stringify(big).length).toBeLessThan(1000);

    // The reviewer's query: 500 MB in one value. Whether Postgres gets through
    // it within the time limit or gives up, none of it may arrive here.
    const outcome = await run("select repeat('x', 500000000)", { timeoutMs: 4000 }).catch((e: unknown) => e);
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(SqlRequestError);
    else expect(outcome).toMatchObject({ rows: [], truncated: true });
    expect(process.memoryUsage().rss - before).toBeLessThan(150_000_000);
  });

  test("the views, CTEs and EXPLAIN work", async () => {
    const view = await run("select person_id, count(*) from events_v group by 1");
    expect(view.rows).toEqual([["shared", "12"]]);
    const cte = await run("with t as (select 1 as x) select x from t; -- done");
    expect(cte.rows).toEqual([[1]]);
    expect((await run("/* why */ values (1, 'a'), (2, 'b')")).rows).toEqual([[1, "a"], [2, "b"]]);
    expect((await run("table people")).columns).toEqual(["id", "name", "created_at"]);
    for (const sql of ["explain select * from events", "EXPLAIN (analyze, costs off) select 1", "explain analyze verbose select 1"]) {
      const plan = await run(sql);
      expect(plan.columns).toEqual(["QUERY PLAN"]);
      expect(plan.rows.length).toBeGreaterThan(0);
    }
  });

  test("cannot write, by any route", async () => {
    for (const sql of [
      "insert into people (id, name) values ('x', 'X')",
      "update events set model = 'x'",
      "delete from events",
      "drop table events",
      "create table t (a int)",
      "truncate events",
      "commit",
      "set statement_timeout = 0",
      "show all",
      "select * from events for update",
      "with gone as (delete from events returning 1) select * from gone",
      "explain analyze delete from events",
      "explain (analyze) with gone as (delete from events returning 1) select * from gone",
      "alter role current_user set statement_timeout = 0",
      "select 1; delete from events",
      "select nextval('nope')",
      "select lo_creat(-1)",
    ]) {
      const error = await rejects(sql);
      expect(error.status).toBe(400);
    }
    expect((await db.sql`select count(*) as n from events`)[0]!.n).toBe("12");
  });

  test("a slow query is cancelled", async () => {
    const started = performance.now();
    const error = await rejects("select pg_sleep(30)");
    expect(error.status).toBe(400);
    expect(error.message).toContain("statement timeout");
    expect(error.message).toContain("1500 ms");
    expect(performance.now() - started).toBeLessThan(10_000);
    // The next request is unaffected.
    expect((await run("select 1")).rows).toEqual([[1]]);
  });

  test("a mistake comes back as a readable error", async () => {
    const error = await rejects("select nope from events");
    expect(error.status).toBe(400);
    expect(error.message).toContain("nope");
  });
});

// What an independent review got through the first version of this endpoint.
// Each test replays the attack as it was reported.
describe("attacks on POST /api/sql", () => {
  const setting = async (name: string) => (await run(`select current_setting('${name}')`)).rows[0]![0];
  const roleSettings = async () =>
    (await db.sql`
      select coalesce(array_to_string(s.setconfig, ','), '') as config
      from pg_roles r left join pg_db_role_setting s on s.setrole = r.oid
      where r.rolname = ${roleRef()}
      order by s.setdatabase`).map((r: Record<string, unknown>) => String(r.config));
  const roleRef = () => roRole;
  const sessions = async () => {
    const [row] = await db.sql`select count(*)::int as n from pg_stat_activity where usename = ${roRole} and pid <> pg_backend_pid()`;
    return Number(row!.n);
  };

  test("session settings do not outlive the request", async () => {
    // standard_conforming_strings = off is what let a crafted literal hide a second statement.
    expect((await run("select set_config('standard_conforming_strings', 'off', false)")).rows).toEqual([["off"]]);
    expect(await setting("standard_conforming_strings")).toBe("on");
    // So did a client encoding in which a byte swallows the closing quote.
    expect((await run("select set_config('client_encoding', 'SJIS', false)")).rows).toEqual([["SJIS"]]);
    expect(await setting("client_encoding")).toBe("UTF8");
    await run("select set_config('statement_timeout', '0', false)");
    expect(await setting("statement_timeout")).toBe("1500ms");
    await run("select set_config('search_path', 'pg_temp', false), set_config('default_transaction_read_only', 'off', false)");
    expect(await setting("search_path")).toBe('"$user", public');
    expect(await setting("default_transaction_read_only")).toBe("on");
    // The mechanism: no session is left behind to carry anything.
    await Bun.sleep(100);
    ro.close({ timeout: 0 }).catch(() => {});
    await Bun.sleep(100);
    expect(await sessions()).toBe(0);
    ro = connect(db.roUrl, 1);
  });

  test("a setting changed inside a query does not help that query either", async () => {
    const started = performance.now();
    const error = await rejects("select set_config('statement_timeout', '0', false), pg_sleep(30)");
    expect(error.message).toContain("statement timeout");
    expect(performance.now() - started).toBeLessThan(10_000);
    expect((await rejects("select set_config('transaction_read_only', 'off', true)")).status).toBe(400);
    expect((await rejects("select set_config('temp_file_limit', '-1', false)")).message).toContain("permission denied");
  });

  test("a second statement cannot be smuggled in, even with the string rules turned against the scanner", async () => {
    // Read with standard_conforming_strings on (the default, and what the
    // scanner in this process assumes), this is a single string literal. Read
    // with it off, the literal ends after \' and four more statements follow.
    const smuggled = "select 'a\\''; commit; begin; create temp table pwned as select 1; --'";
    expect((await run(smuggled)).rows).toEqual([["a\\'; commit; begin; create temp table pwned as select 1; --"]]);

    // Now give the role the setting the attack needed, as a login default, so
    // that it is in force before the statement is even parsed.
    await db.sql.unsafe(`alter role ${roRole} set standard_conforming_strings = off`);
    try {
      expect(await setting("standard_conforming_strings")).toBe("off");
      // To the scanner in this process it still looks like one statement;
      // Postgres now reads four. It refuses them itself.
      for (const sql of [
        smuggled,
        "select 'a\\''; commit; alter role current_user set statement_timeout = 0; --'",
        "select 'a\\''; commit; begin read write; delete from events; commit; --'",
        "select 'a\\''; select pg_sleep(30); --'",
      ]) {
        const error = await rejects(sql);
        expect(error.status).toBe(400);
        expect(error.message).toMatch(/multiple commands|syntax error/);
      }
      expect((await rejects("explain select 'a\\''; commit; create temp table pwned2 as select 1; --'")).status).toBe(400);
    } finally {
      // Every boot puts the role back in order.
      await ensureReadonlyRole(db.sql, db.roUrl, limits.timeoutMs);
    }
    expect(await setting("standard_conforming_strings")).toBe("on");
    expect((await db.sql`select count(*) as n from events`)[0]!.n).toBe("12");
    expect(await db.sql`select 1 from pg_class where relname in ('pwned', 'pwned2')`).toHaveLength(0);
  });

  test("the role cannot change its own defaults through the endpoint", async () => {
    const before = await roleSettings();
    expect(before.join()).toContain("default_transaction_read_only=on");
    expect(before.join()).toContain("temp_file_limit=1GB");
    for (const sql of [
      "alter role current_user set statement_timeout = 0",
      "select 1; alter role current_user set default_transaction_read_only = off",
      "alter role current_user password 'mine-now'",
    ]) {
      await rejects(sql);
    }
    // Postgres lets a role alter itself, but never inside a read-only
    // transaction, which is the only place a query from the endpoint runs.
    await expect(
      ro.begin("read only", async (tx) => await tx.unsafe("alter role current_user set statement_timeout = 0")),
    ).rejects.toThrow(/read-only transaction/);
    expect(await roleSettings()).toEqual(before);

    // Should it happen anyway, the next boot undoes it, cluster-wide and per database.
    await db.sql.unsafe(`alter role ${roRole} set statement_timeout = 0`);
    await db.sql.unsafe(`alter role ${roRole} in database ${db.name} set default_transaction_read_only = off`);
    expect(await roleSettings()).not.toEqual(before);
    await ensureReadonlyRole(db.sql, db.roUrl, limits.timeoutMs);
    expect(await roleSettings()).toEqual(before);
  });

  test("advisory locks are out of reach: the migration lock cannot be held, the lock table cannot be filled", async () => {
    for (const sql of [
      "select pg_advisory_lock(7310318)",
      "select pg_advisory_xact_lock(7310318)",
      "select pg_try_advisory_lock(7310318)",
      "select pg_advisory_lock_shared(1, 2)",
      "select count(pg_advisory_lock(g)) from generate_series(1, 200000) g",
    ]) {
      const error = await rejects(sql);
      expect(error.message).toContain("permission denied for function");
    }
    await expect(ro`select pg_advisory_lock(7310318)`).rejects.toThrow(/permission denied/);
    expect(Number((await db.sql`select count(*) as n from pg_locks where locktype = 'advisory'`)[0]!.n)).toBe(0);

    // Schema work, which takes that lock, is not held up: this used to hang every boot and CLI command.
    const started = performance.now();
    await migrate(db.sql);
    await ensureReadonlyRole(db.sql, db.roUrl, limits.timeoutMs);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("no temporary tables", async () => {
    for (const sql of [
      "create temp table junk as select repeat('x', 1000000) from generate_series(1, 100000)",
      "select repeat('x', 1000000) into temp junk from generate_series(1, 100000)",
      "select 1; create temp table junk (a int)",
    ]) {
      await rejects(sql);
    }
    // Even with a session of its own and a read-write transaction, the role may not.
    await expect(ro.begin("read write", async (tx) => await tx.unsafe("create temp table junk (a int)"))).rejects.toThrow(
      /permission denied/,
    );
    const [priv] = await db.sql`select has_database_privilege(${roRole}, current_database(), 'TEMPORARY') as temp,
                                       has_database_privilege(${roRole}, current_database(), 'CREATE') as creates,
                                       has_schema_privilege(${roRole}, 'public', 'CREATE') as schema_create`;
    expect(priv).toEqual({ temp: false, creates: false, schema_create: false });
  });

  test("the role itself is read-only, even with a session of its own", async () => {
    await expect(ro`delete from events`).rejects.toThrow();
    for (const sql of [
      "insert into people (id, name) values ('x', 'X')",
      "update events set model = 'x'",
      "delete from api_keys",
      "truncate events",
      "create table sneaky (a int)",
      "drop view events_v",
    ]) {
      await expect(ro.begin("read write", async (tx) => await tx.unsafe(sql))).rejects.toThrow(/permission denied|must be owner/);
    }
    expect(await ro`select count(*) as n from events`).toHaveLength(1);
  });

  test("many queries at once are queued, not multiplied into connections", async () => {
    const gate = new SqlGate(2, 3);
    let running = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        peak = Math.max(peak, ++running);
        const res = await run("select pg_sleep(0.2), 1 as one");
        running--;
        return res.rows[0]![1];
      });
    const results = await Promise.allSettled(Array.from({ length: 7 }, task));
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(2);
    expect((refused[0]!.reason as SqlRequestError).status).toBe(503);
    await Bun.sleep(200);
    expect(await sessions()).toBeLessThanOrEqual(1);
  });
});
