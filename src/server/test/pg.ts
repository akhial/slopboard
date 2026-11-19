// One throwaway Postgres container per `bun test` run, and a fresh database per test file.
//
// The container is named slopboard-test-<random>, listens on a free port of
// 127.0.0.1 only, and is removed when the run ends (see setup.ts).

import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { connect, migrate, type Db } from "../db.ts";

const IMAGE = "postgres:17";

/** For beforeAll hooks: the first one of a run also waits for the container to start. */
export const SETUP_TIMEOUT = 120_000;
const PASSWORD = "slopboard-test";

interface Container {
  name: string;
  port: number;
}

const state = globalThis as typeof globalThis & { __slopboardPg?: Promise<Container> };

function docker(...args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, out: `${res.stdout.toString()}${res.stderr.toString()}`.trim() };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function adminUrl(c: Container, database = "postgres"): string {
  return `postgres://postgres:${PASSWORD}@127.0.0.1:${c.port}/${database}`;
}

export async function waitUntilReady(c: Container, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const sql = new SQL(adminUrl(c), { max: 1, connectionTimeout: 3 });
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(250);
    } finally {
      await sql.close({ timeout: 0 }).catch(() => {});
    }
  }
  throw new Error(`test Postgres did not come up: ${(last as Error)?.message}`);
}

/** Starts the container on first use; every later call returns the same one. */
export function testContainer(): Promise<Container> {
  state.__slopboardPg ??= (async () => {
    const name = `slopboard-test-${randomBytes(4).toString("hex")}`;
    const port = await freePort();
    const run = docker(
      "run", "-d", "--name", name,
      "-p", `127.0.0.1:${port}:5432`,
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
      IMAGE,
      // Throwaway data: trade durability for speed.
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
    );
    if (!run.ok) throw new Error(`could not start ${IMAGE}: ${run.out}`);
    const container = { name, port };
    await waitUntilReady(container);
    return container;
  })();
  return state.__slopboardPg;
}

/** Removes the container if one was started. Safe to call more than once. */
export async function removeTestContainer(): Promise<void> {
  const pending = state.__slopboardPg;
  if (!pending) return;
  state.__slopboardPg = undefined;
  const container = await pending.catch(() => null);
  if (container) docker("rm", "-f", "-v", container.name);
}

export function stopPostgres(c: Container): void {
  const res = docker("stop", "-t", "5", c.name);
  if (!res.ok) throw new Error(`docker stop failed: ${res.out}`);
}

export async function startPostgres(c: Container): Promise<void> {
  const res = docker("start", c.name);
  if (!res.ok) throw new Error(`docker start failed: ${res.out}`);
  await waitUntilReady(c);
}

export interface TestDb {
  container: Container;
  name: string;
  url: string;
  /** URL of a read-only role in this database (the role is created on demand by the code under test). */
  roUrl: string;
  sql: Db;
  close: () => Promise<void>;
}

/** A new, migrated database. */
export async function createTestDb(label: string): Promise<TestDb> {
  const container = await testContainer();
  const name = `t_${label.replace(/[^a-z0-9]+/g, "_")}_${randomBytes(3).toString("hex")}`;
  const admin = new SQL(adminUrl(container), { max: 1 });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }
  const url = adminUrl(container, name);
  const sql = connect(url, 5);
  await migrate(sql);
  return {
    container,
    name,
    url,
    roUrl: `postgres://ro_${name}:ro-secret@127.0.0.1:${container.port}/${name}`,
    sql,
    close: async () => {
      await sql.close({ timeout: 2 }).catch(() => {});
    },
  };
}
