import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildBoard, resetBoardCaches } from "../board.ts";
import { Collector } from "../collector.ts";
import { connect } from "../db.ts";
import { ProxyClient } from "../proxy.ts";
import { usageRecord, type SyntheticRecord } from "../synthetic.ts";
import { FakeProxy } from "./fake-proxy.ts";
import { createTestDb, SETUP_TIMEOUT, startPostgres, stopPostgres, type TestDb } from "./pg.ts";

// Talks to Postgres (and may be the file that starts its container).
setDefaultTimeout(30_000);

const KEY = "sk-collector-test-key-abcdef";
const quiet = () => {};

let db: TestDb;
let proxy: FakeProxy;

beforeAll(async () => {
  db = await createTestDb("collector");
  proxy = new FakeProxy();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await proxy.stop();
  await db.close();
});

function rec(extra: Partial<SyntheticRecord> = {}): Record<string, unknown> {
  return usageRecord({
    kind: "claude",
    at: new Date(),
    apiKey: KEY,
    model: "claude-sonnet-5-5",
    usage: { input: 10, cacheRead: 100, cacheWrite: 20, answer: 30, reasoning: 0 },
    sessionId: randomUUID(),
    ...extra,
  });
}

function collector(maxPending = 10_000, batch = 500, key = proxy.managementKey): Collector {
  return new Collector({
    sql: db.sql,
    proxy: new ProxyClient(proxy.url, key, 3000),
    pollIntervalMs: 50,
    batch,
    maxPending,
    log: quiet,
  });
}

async function eventCount(): Promise<number> {
  const [row] = await db.sql`select count(*) as n from events`;
  return Number(row!.n);
}

describe("collector", () => {
  test("stores what it pulls, and storing the same record again changes nothing", async () => {
    const c = collector();
    expect(c.lagSeconds()).toBeNull();
    const records = [rec(), rec(), rec()];
    proxy.queue.push(...records);

    const first = await c.tick();
    expect(first).toMatchObject({ pulled: 3, stored: 3, proxyOk: true, dbOk: true });
    expect(proxy.queue).toHaveLength(0);
    expect(await eventCount()).toBe(3);
    expect(c.lagSeconds()).toBe(0);

    // The proxy delivers the three again (say, a replay) together with one new record.
    proxy.queue.push(...records, rec());
    const second = await c.tick();
    expect(second).toMatchObject({ pulled: 4, stored: 1 });
    expect(await eventCount()).toBe(4);

    // An empty poll is still a successful poll.
    expect(await c.tick()).toMatchObject({ pulled: 0, stored: 0, proxyOk: true, dbOk: true });
    expect(proxy.authFailures).toBe(0);
  });

  test("the plaintext key is not stored anywhere", async () => {
    const [row] = await db.sql`select count(*) as n from events e where e::text like ${"%" + KEY + "%"}`;
    expect(Number(row!.n)).toBe(0);
    const [hashed] = await db.sql`select count(distinct key_hash) as n, min(key_hash) as h from events`;
    expect(Number(hashed!.n)).toBe(1);
    expect(String(hashed!.h)).toMatch(/^[0-9a-f]{64}$/);
    const [raw] = await db.sql`select raw from events limit 1`;
    expect((raw!.raw as Record<string, unknown>).api_key).toBeUndefined();
    expect((raw!.raw as Record<string, unknown>).model).toBe("claude-sonnet-5-5");
  });

  test("drains a backlog larger than one batch", async () => {
    const c = collector(10_000, 10);
    const before = await eventCount();
    proxy.queue.push(...Array.from({ length: 25 }, () => rec()));
    const first = await c.tick();
    expect(first).toMatchObject({ pulled: 10, more: true });
    expect((await c.tick()).more).toBe(true);
    expect(await c.tick()).toMatchObject({ pulled: 5, more: false });
    expect(await eventCount()).toBe(before + 25);
  });

  test("a record Postgres rejects is dropped without blocking the rest", async () => {
    const c = collector();
    const before = await eventCount();
    const poison = rec();
    poison.latency_ms = 1e30; // does not fit a bigint
    proxy.queue.push(rec(), poison, rec());
    const result = await c.tick();
    expect(result).toMatchObject({ pulled: 3, stored: 2, dbOk: true });
    expect(c.pendingCount).toBe(0);
    expect(c.totals.dropped).toBe(1);
    expect(await eventCount()).toBe(before + 2);
  });

  test("an error that is not about the row holds everything instead of dropping it", async () => {
    const c = collector();
    const before = await eventCount();
    const batch = [rec(), rec(), rec()];
    proxy.queue.push(...batch);

    // The schema no longer matches: Postgres is up and says "no such column" (42703).
    await db.sql.unsafe("alter table events rename column latency_ms to latency_ms_gone");
    try {
      const during = await c.tick();
      expect(during).toMatchObject({ pulled: 3, stored: 0, proxyOk: true, dbOk: false });
      expect(c.pendingCount).toBe(3);
      expect(c.totals.dropped).toBe(0);
      // Still nothing dropped on the retries, and more records queue up behind.
      proxy.queue.push(rec());
      expect(await c.tick()).toMatchObject({ pulled: 1, dbOk: false });
      expect(c.pendingCount).toBe(4);
    } finally {
      await db.sql.unsafe("alter table events rename column latency_ms_gone to latency_ms");
    }
    expect(await c.tick()).toMatchObject({ stored: 4, dbOk: true });

    // Lost permission (42501) and a statement cancelled by a timeout (57014) are the same story.
    await db.sql.unsafe(`
      create role slop_writer_${db.name} login password 'w';
      grant usage on schema public to slop_writer_${db.name};
      grant select, update on all tables in schema public to slop_writer_${db.name};`);
    const restricted = connect(`postgres://slop_writer_${db.name}:w@127.0.0.1:${db.container.port}/${db.name}`, 1);
    const denied = new Collector({ sql: restricted, proxy: new ProxyClient(proxy.url, proxy.managementKey), pollIntervalMs: 50, batch: 500, maxPending: 100, log: quiet });
    try {
      proxy.queue.push(rec(), rec());
      expect(await denied.tick()).toMatchObject({ pulled: 2, stored: 0, dbOk: false });
      expect([denied.pendingCount, denied.totals.dropped]).toEqual([2, 0]);
      await db.sql.unsafe(`grant insert on all tables in schema public to slop_writer_${db.name}`);
      await restricted.unsafe("set statement_timeout = 1");
      await db.sql.begin(async (tx) => {
        // Hold a lock the insert needs, so it runs into its timeout.
        await tx.unsafe("lock table events in access exclusive mode");
        expect(await denied.tick()).toMatchObject({ stored: 0, dbOk: false });
        expect([denied.pendingCount, denied.totals.dropped]).toEqual([2, 0]);
      });
      await restricted.unsafe("set statement_timeout = 0");
      expect(await denied.tick()).toMatchObject({ stored: 2, dbOk: true });
    } finally {
      await restricted.close({ timeout: 1 }).catch(() => {});
    }
    expect(await eventCount()).toBe(before + 6);

    // A row that is itself unacceptable (22003, out of range) is still the one case that is dropped.
    const poison = rec();
    poison.latency_ms = 1e30;
    proxy.queue.push(poison, rec());
    expect(await c.tick()).toMatchObject({ pulled: 2, stored: 1, dbOk: true });
    expect([c.pendingCount, c.totals.dropped]).toEqual([0, 1]);
  });

  test("backs off when the proxy is down or refuses the key, and loses nothing", async () => {
    const c = collector();
    const before = await eventCount();
    proxy.queue.push(rec(), rec());

    await proxy.down();
    const down = await c.tick();
    expect(down).toMatchObject({ pulled: 0, proxyOk: false, dbOk: true });
    expect(c.lagSeconds()).toBeNull();
    proxy.up();

    proxy.queueStatus = 503;
    expect((await c.tick()).proxyOk).toBe(false);
    proxy.queueStatus = null;

    const wrongKey = collector(10_000, 500, "not-the-key");
    expect((await wrongKey.tick()).proxyOk).toBe(false);
    expect(proxy.authFailures).toBe(1);
    expect(proxy.queue).toHaveLength(2);

    expect(await c.tick()).toMatchObject({ pulled: 2, stored: 2, proxyOk: true });
    expect(await eventCount()).toBe(before + 2);
  });

  test("background loop polls on its own and stops cleanly", async () => {
    const c = collector();
    const before = await eventCount();
    await c.start();
    proxy.queue.push(rec(), rec(), rec());
    const deadline = Date.now() + 5000;
    while ((await eventCount()) < before + 3 && Date.now() < deadline) await Bun.sleep(25);
    await c.stop();
    expect(await eventCount()).toBe(before + 3);
    const pops = proxy.pops;
    await Bun.sleep(150);
    expect(proxy.pops).toBe(pops);
    // The time of the last good poll survives a restart of the process.
    const restarted = collector();
    await proxy.down();
    await restarted.start();
    await restarted.stop();
    proxy.up();
    const lag = restarted.lagSeconds();
    expect(lag).not.toBeNull();
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(60);
  });
});

describe("requests and threads", () => {
  test("retries count once, and every turn on a shared trace counts", async () => {
    const fresh = await createTestDb("requests");
    try {
      const c = new Collector({ sql: fresh.sql, proxy: new ProxyClient(proxy.url, proxy.managementKey), pollIntervalMs: 50, batch: 500, maxPending: 1000, log: quiet });
      const usage = { input: 100, cacheRead: 0, cacheWrite: 0, answer: 50, reasoning: 0 };
      const retried = randomUUID();
      const doomed = randomUUID();
      const websocket = randomUUID();
      proxy.queue.push(
        // One inbound request: two refusals, then success.
        rec({ requestId: retried, failedStatus: 429, usage: undefined }),
        rec({ requestId: retried, failedStatus: 429, usage: undefined }),
        rec({ requestId: retried, usage }),
        // One inbound request that never succeeded.
        rec({ requestId: doomed, failedStatus: 500, usage: undefined }),
        rec({ requestId: doomed, failedStatus: 500, usage: undefined }),
        // Three turns over one Codex websocket: same request id, three requests.
        rec({ kind: "codex", model: "gpt-5.3-codex", requestId: websocket, usage }),
        rec({ kind: "codex", model: "gpt-5.3-codex", requestId: websocket, usage }),
        rec({ kind: "codex", model: "gpt-5.3-codex", requestId: websocket, usage }),
      );
      expect((await c.tick()).stored).toBe(8);
      const board = await buildBoard(fresh.sql, "UTC", "today", null);
      expect(board.totals.requests).toBe(5);
      expect(board.totals.failedRequests).toBe(1);
      expect(board.totals.tokens.total).toBe(4 * 150);
      const shared = board.people.find((p) => p.id === "shared")!;
      expect([shared.requests, shared.failedRequests, shared.unassigned]).toEqual([5, 1, true]);
    } finally {
      await fresh.close();
    }
  });

  test("a thread is the root session plus everything under it, in whatever order records arrive", async () => {
    const fresh = await createTestDb("threads");
    try {
      const c = new Collector({ sql: fresh.sql, proxy: new ProxyClient(proxy.url, proxy.managementKey), pollIntervalMs: 50, batch: 500, maxPending: 1000, log: quiet });
      const root = randomUUID();
      const child = randomUUID();
      const grandchild = randomUUID();
      const sibling = randomUUID();
      const orphanParent = randomUUID();
      const orphan = randomUUID();
      const other = randomUUID();

      const threadOf = async () => {
        const rows = await fresh.sql`select session_id, thread_id, is_subagent from events order by ts`;
        return Object.fromEntries(rows.map((r: Record<string, unknown>) => [String(r.session_id), [r.thread_id, r.is_subagent]]));
      };

      // The deepest session reports first: nothing above it is known yet.
      proxy.queue.push(rec({ sessionId: grandchild, parentSessionId: child, at: new Date(Date.now() - 5000) }));
      await c.tick();
      expect(await threadOf()).toEqual({ [grandchild]: [child, true] });

      // Its parent appears and names the root.
      proxy.queue.push(rec({ sessionId: child, parentSessionId: root, at: new Date(Date.now() - 4000) }));
      await c.tick();
      expect(await threadOf()).toEqual({ [grandchild]: [root, true], [child]: [root, true] });

      // The root itself, a sibling, an unrelated thread, and a subagent whose parent never reports.
      proxy.queue.push(
        rec({ sessionId: root, at: new Date(Date.now() - 3000) }),
        rec({ sessionId: sibling, parentSessionId: root, at: new Date(Date.now() - 2000) }),
        rec({ sessionId: other, at: new Date(Date.now() - 1500) }),
        rec({ sessionId: orphan, parentSessionId: orphanParent, at: new Date(Date.now() - 1000) }),
      );
      await c.tick();
      expect(await threadOf()).toEqual({
        [grandchild]: [root, true],
        [child]: [root, true],
        [root]: [root, false],
        [sibling]: [root, true],
        [other]: [other, false],
        [orphan]: [orphanParent, true],
      });

      // Later requests of a known subagent land in the same thread at once.
      proxy.queue.push(rec({ sessionId: grandchild, parentSessionId: child }));
      await c.tick();
      const [counts] = await fresh.sql`
        select count(*) filter (where thread_id = ${root}) as in_root, count(distinct thread_id) as threads from events`;
      expect([Number(counts!.in_root), Number(counts!.threads)]).toEqual([5, 3]);

      resetBoardCaches(fresh.sql);
      const board = await buildBoard(fresh.sql, "UTC", "today", null);
      expect(board.totals.threads).toBe(3);
      expect(board.totals.subagents).toBe(4);
    } finally {
      await fresh.close();
    }
  });
});

describe("database outage", () => {
  test("a popped batch survives Postgres going away, within a bounded buffer", async () => {
    const c = collector(6);
    const before = await eventCount();
    const batch = Array.from({ length: 5 }, () => rec());
    proxy.queue.push(...batch);

    stopPostgres(db.container);
    try {
      const during = await c.tick();
      // The records left the proxy and could not be written: they now live only in memory.
      expect(during).toMatchObject({ pulled: 5, stored: 0, proxyOk: true, dbOk: false });
      expect(proxy.queue).toHaveLength(0);
      expect(c.pendingCount).toBe(5);

      // More usage arrives while the database is still down. The buffer holds
      // six, so only one more is taken and the rest waits in the proxy.
      proxy.queue.push(...Array.from({ length: 4 }, () => rec()));
      const full = await c.tick();
      expect(full).toMatchObject({ pulled: 1, dbOk: false });
      expect(c.pendingCount).toBe(6);
      expect(proxy.queue).toHaveLength(3);
      const idle = await c.tick();
      expect(idle).toMatchObject({ pulled: 0, dbOk: false });
      expect(proxy.queue).toHaveLength(3);
    } finally {
      await startPostgres(db.container);
    }

    // Postgres is back: everything held in memory is written, then the proxy is drained.
    let stored = 0;
    for (let i = 0; i < 20 && (c.pendingCount > 0 || proxy.queue.length > 0); i++) {
      stored += (await c.tick()).stored;
    }
    expect(stored).toBe(9);
    expect(c.pendingCount).toBe(0);
    expect(await eventCount()).toBe(before + 9);

    // A redelivery of the batch that sat in memory is recognised.
    proxy.queue.push(...batch);
    expect(await c.tick()).toMatchObject({ pulled: 5, stored: 0, dbOk: true });
    expect(await eventCount()).toBe(before + 9);
  }, 120_000);
});
