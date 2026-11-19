// Entry point: migrations, collector, price refresh and the HTTP server in one process.

import index from "../web/index.html";
import { Collector } from "./collector.ts";
import { loadConfig } from "./config.ts";
import { connect, ensureReadonlyRole, migrate, type Db } from "./db.ts";
import { startServer } from "./http.ts";
import { schedulePriceRefresh } from "./prices.ts";
import { ProxyClient } from "./proxy.ts";

const log = (message: string) => console.log(`[slopboard] ${message}`);

/** Postgres may still be starting when the container comes up. */
async function migrateWhenReady(sql: Db): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await migrate(sql);
      if (applied.length > 0) log(`applied migrations: ${applied.join(", ")}`);
      return;
    } catch (error) {
      if (attempt >= 30) throw error;
      log(`database not ready (${(error as Error).message}), retrying`);
      await Bun.sleep(2000);
    }
  }
}

const config = loadConfig();
const sql = connect(config.databaseUrl);
await migrateWhenReady(sql);

let roUrl: string | null = null;
if (config.databaseRoUrl) {
  try {
    const role = await ensureReadonlyRole(sql, config.databaseRoUrl, config.sqlTimeoutMs);
    roUrl = config.databaseRoUrl;
    log(`POST /api/sql runs as read-only role "${role}"`);
  } catch (error) {
    log(`POST /api/sql disabled: ${(error as Error).message}`);
  }
} else {
  log("POST /api/sql disabled: DATABASE_RO_URL is not set");
}

const prices = schedulePriceRefresh(sql, config.pricesUrl, config.pricesRefreshHours);

let collector: Collector | null = null;
if (!config.collectorEnabled) {
  log("collector disabled by COLLECTOR_ENABLED");
} else if (!config.proxyUrl) {
  log("collector disabled: PROXY_URL is not set");
} else if (!config.proxyManagementKey) {
  log("collector disabled: PROXY_MANAGEMENT_KEY is not set");
} else {
  collector = new Collector({
    sql,
    proxy: new ProxyClient(config.proxyUrl, config.proxyManagementKey),
    pollIntervalMs: config.pollIntervalMs,
    batch: config.pollBatch,
    maxPending: config.maxPending,
  });
  await collector.start();
  log(`collecting from ${config.proxyUrl} every ${config.pollIntervalMs} ms`);
}

const server = startServer({
  sql,
  roUrl,
  collector,
  index,
  boardTz: config.boardTz,
  host: config.host,
  port: config.port,
  boardCacheMs: config.boardCacheMs,
  sqlTimeoutMs: config.sqlTimeoutMs,
  sqlMaxRows: config.sqlMaxRows,
  sqlMaxBytes: config.sqlMaxBytes,
  development: config.development,
});
log(`listening on ${server.url} (board timezone ${config.boardTz})`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}, shutting down`);
  prices.stop();
  await server.stop();
  // The collector holds records that exist nowhere else: give it its last flush.
  await collector?.stop();
  await sql.close({ timeout: 5 }).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
