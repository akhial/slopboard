// Pulls usage records out of the proxy's queue and stores them.
//
// The pull is destructive, so a record is in exactly one place at a time: the
// proxy's queue, `pending` here, or Postgres. `pending` is what carries a
// popped batch across a Postgres outage. It is bounded: once full, polling
// stops and records wait in the proxy instead (which keeps them for up to an
// hour, see `redis-usage-queue-retention-seconds`).

import { getMeta, isRowError, setMeta, type Db } from "./db.ts";
import { insertEvents, normalizeRecord, type EventRow } from "./ingest.ts";
import { ProxyError, type ProxyClient } from "./proxy.ts";

export interface CollectorOptions {
  sql: Db;
  proxy: ProxyClient;
  pollIntervalMs: number;
  /** Records asked from the proxy per poll. */
  batch: number;
  /** Upper bound of records held in memory. */
  maxPending: number;
  /** Called after new events are stored in Postgres. */
  onStored?: (stored: number) => void;
  log?: (message: string) => void;
}

export interface TickResult {
  /** Records popped from the proxy in this tick. */
  pulled: number;
  /** Rows that were new to Postgres in this tick. */
  stored: number;
  proxyOk: boolean;
  dbOk: boolean;
  /** The proxy returned as many records as were asked for, so more are probably waiting. */
  more: boolean;
}

const LAST_POLL_KEY = "collector.last_poll_ok";
const FLUSH_SIZE = 2000;
const PERSIST_EVERY_MS = 30_000;
const AUTH_BACKOFF_MS = 10 * 60_000;
const MAX_PROXY_BACKOFF_MS = 60_000;
const MAX_DB_BACKOFF_MS = 30_000;

export class Collector {
  private pending: EventRow[] = [];
  private lastPollOkAt: number | null = null;
  private lastPersistAt = 0;
  private proxyFailures = 0;
  private dbFailures = 0;
  private lastProxyError: ProxyError | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly log: (message: string) => void;

  readonly totals = { pulled: 0, stored: 0, ignored: 0, dropped: 0 };

  constructor(private readonly opts: CollectorOptions) {
    this.log = opts.log ?? ((m) => console.log(`[collector] ${m}`));
  }

  /** Records popped from the proxy that Postgres has not accepted yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Seconds since the proxy last answered a poll, null if it never has. */
  lagSeconds(now = Date.now()): number | null {
    if (this.lastPollOkAt === null) return null;
    return Math.max(0, Math.round((now - this.lastPollOkAt) / 1000));
  }

  /** One cycle: pull from the proxy if there is room, then store what is pending. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { pulled: 0, stored: 0, proxyOk: true, dbOk: true, more: false };

    const room = this.opts.maxPending - this.pending.length;
    if (room > 0) {
      const want = Math.min(this.opts.batch, room);
      try {
        const items = await this.opts.proxy.popUsage(want);
        // From here on these records exist nowhere else. Nothing below may throw them away.
        this.lastPollOkAt = Date.now();
        result.pulled = items.length;
        result.more = items.length >= want;
        this.totals.pulled += items.length;
        for (const item of items) {
          const row = normalizeRecord(item);
          if (row) this.pending.push(row);
          else this.totals.ignored++;
        }
        if (this.proxyFailures > 0) this.log("proxy reachable again");
        this.proxyFailures = 0;
        this.lastProxyError = null;
      } catch (error) {
        result.proxyOk = false;
        this.lastProxyError = error instanceof ProxyError ? error : new ProxyError(String(error), 0);
        if (this.proxyFailures++ === 0) this.log(`proxy poll failed: ${this.lastProxyError.message}`);
      }
    }

    try {
      result.stored = await this.flush();
      if (result.stored > 0) this.opts.onStored?.(result.stored);
      if (result.proxyOk && Date.now() - this.lastPersistAt > PERSIST_EVERY_MS && this.lastPollOkAt !== null) {
        await setMeta(this.opts.sql, LAST_POLL_KEY, new Date(this.lastPollOkAt).toISOString());
        this.lastPersistAt = Date.now();
      }
      if (this.dbFailures > 0) this.log("database reachable again");
      this.dbFailures = 0;
    } catch (error) {
      result.dbOk = false;
      // Say so at once, then again every so often: this can be an outage that
      // passes, or a broken schema or permission that somebody has to fix.
      if (this.dbFailures++ % 20 === 0) {
        this.log(`database write failed, holding ${this.pending.length} records in memory: ${(error as Error).message}`);
      }
    }
    return result;
  }

  /**
   * Stores `pending`. A row leaves memory in exactly two ways: its transaction
   * committed, or Postgres rejected that very row for its content. Any other
   * failure keeps everything and is retried with back-off.
   */
  private async flush(): Promise<number> {
    const before = this.totals.stored;
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, FLUSH_SIZE);
      try {
        this.totals.stored += await insertEvents(this.opts.sql, batch);
      } catch (error) {
        if (!isRowError(error)) throw error;
        // Some row in the batch is unacceptable. Find it, so one bad record
        // cannot block everything behind it.
        await this.flushOneByOne(batch);
        continue;
      }
      this.pending.splice(0, batch.length);
    }
    return this.totals.stored - before;
  }

  /** Stores the rows at the head of `pending` one at a time, removing each as it is settled. */
  private async flushOneByOne(batch: EventRow[]): Promise<void> {
    for (const row of batch) {
      try {
        this.totals.stored += await insertEvents(this.opts.sql, [row]);
      } catch (error) {
        // Not this row's fault: stop here and keep it and everything after it.
        if (!isRowError(error)) throw error;
        this.totals.dropped++;
        this.log(`dropping record ${row.event_id}, which Postgres rejects for its content: ${(error as Error).message}`);
      }
      this.pending.shift();
    }
  }

  private delayAfter(result: TickResult): number {
    if (!result.dbOk) return Math.min(MAX_DB_BACKOFF_MS, 1000 * 2 ** Math.min(this.dbFailures - 1, 10));
    if (!result.proxyOk) {
      // Five bad keys in a row get this address banned by the proxy for 30 minutes, so go slowly.
      if (this.lastProxyError?.isAuth) return AUTH_BACKOFF_MS;
      return Math.min(MAX_PROXY_BACKOFF_MS, this.opts.pollIntervalMs * 2 ** Math.min(this.proxyFailures - 1, 10));
    }
    return result.more ? 0 : this.opts.pollIntervalMs;
  }

  /** Starts polling in the background. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const last = await getMeta<string>(this.opts.sql, LAST_POLL_KEY);
      const at = Date.parse(last ?? "");
      if (Number.isFinite(at) && this.lastPollOkAt === null) this.lastPollOkAt = at;
    } catch {
      // The loop below reports database trouble.
    }
    this.loop = (async () => {
      while (this.running) {
        let delay = this.opts.pollIntervalMs;
        try {
          delay = this.delayAfter(await this.tick());
        } catch (error) {
          this.log(`unexpected error: ${(error as Error).stack ?? error}`);
        }
        if (!this.running) break;
        if (delay > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = null;
        }
      }
    })();
  }

  /** Stops polling and makes one last attempt to store what is pending. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
    if (this.pending.length > 0) {
      try {
        await this.flush();
      } catch (error) {
        this.log(`shutting down with ${this.pending.length} records unsaved: ${(error as Error).message}`);
      }
    }
  }
}
