// A stand-in for the two management endpoints of CLIProxyAPI that Slopboard
// talks to, behaving as the Go handlers do:
//
//   GET  /v8/management/observability/usage/queue?count=N   pops, destructively
//   GET  /v8/management/config/access/api-keys              list + ETag, 404 when unset
//   PUT  /v8/management/config/access/api-keys              replaces the whole list, honours If-Match
//
// The real proxy is never contacted by the tests.

import type { Server } from "bun";
import { createHash } from "node:crypto";

export class FakeProxy {
  queue: unknown[] = [];
  /** null: the config has no access.api-keys node. */
  apiKeys: string[] | null = [];
  /** Requests that arrived without the right management key. */
  authFailures = 0;
  /** Every list a client wrote. */
  puts: string[][] = [];
  pops = 0;
  /** When set, queue requests answer with this status. */
  queueStatus: number | null = null;
  /** Runs once, just before the next PUT is evaluated: a concurrent writer. */
  beforeNextPut: (() => void) | null = null;
  /** The next PUT is applied, but its answer is lost: the client sees a 502. */
  loseNextPutResponse = false;
  /** After the next applied PUT, this many key-list requests fail with a 503. */
  failAfterNextPut = 0;
  /** Serve the key list without an ETag header. */
  omitEtag = false;
  /** Answer the key-list GET with this 404 instead: a 404 that is not the config handler's. */
  foreign404: string | null = null;

  private failing = 0;

  private server: Server<undefined> | null = null;
  private port = 0;

  constructor(readonly managementKey = "test-management-key") {
    this.up();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Stops listening, so clients get "connection refused". */
  async down(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  up(): void {
    if (this.server) return;
    this.server = Bun.serve({ hostname: "127.0.0.1", port: this.port, fetch: (req) => this.handle(req) });
    this.port = this.server.port ?? 0;
  }

  async stop(): Promise<void> {
    await this.down();
  }

  private etag(): string {
    return `"${createHash("sha256").update(JSON.stringify(this.apiKeys)).digest("hex")}"`;
  }

  private authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const bearer = /^bearer\s+(.+)$/i.exec(header)?.[1] ?? header;
    return (bearer || req.headers.get("x-management-key")) === this.managementKey;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!this.authorized(req)) {
      this.authFailures++;
      return Response.json({ error: "invalid management key" }, { status: 401 });
    }

    if (url.pathname === "/v8/management/observability/usage/queue" && req.method === "GET") {
      if (this.queueStatus !== null) return Response.json({ error: "unavailable" }, { status: this.queueStatus });
      const raw = url.searchParams.get("count") ?? "1";
      const count = Number(raw);
      if (!Number.isInteger(count) || count <= 0) {
        return Response.json({ error: "count must be a positive integer" }, { status: 400 });
      }
      this.pops++;
      return Response.json(this.queue.splice(0, count));
    }

    if (url.pathname === "/v8/management/config/access/api-keys") {
      if (this.failing > 0) {
        this.failing--;
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (req.method === "GET") {
        if (this.foreign404 !== null) return new Response(this.foreign404, { status: 404 });
        if (this.apiKeys === null) return Response.json({ error: "not_found" }, { status: 404 });
        const headers: Record<string, string> = { "Cache-Control": "no-store" };
        if (!this.omitEtag) headers.ETag = this.etag();
        return Response.json(this.apiKeys, { headers });
      }
      if (req.method === "PUT") {
        const hook = this.beforeNextPut;
        this.beforeNextPut = null;
        hook?.();
        const ifMatch = req.headers.get("if-match");
        if (ifMatch !== null && ifMatch !== "*" && ifMatch !== this.etag()) {
          return Response.json({ error: "precondition_failed" }, { status: 412, headers: { ETag: this.etag() } });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        if (!Array.isArray(body) || body.some((k) => typeof k !== "string")) {
          return Response.json({ error: "invalid_config" }, { status: 400 });
        }
        // Lists are replaced whole, exactly like the real handler.
        this.apiKeys = [...(body as string[])];
        this.puts.push([...this.apiKeys]);
        this.failing = this.failAfterNextPut;
        this.failAfterNextPut = 0;
        if (this.loseNextPutResponse) {
          this.loseNextPutResponse = false;
          return new Response("bad gateway", { status: 502 });
        }
        return Response.json({ status: "ok", "config-version": 8 }, { headers: { ETag: this.etag() } });
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
