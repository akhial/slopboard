// POST /api/sql: ad-hoc SELECTs for people and agents on the tailnet.
//
// The layers, outermost first:
//
//  - Every request gets its own database connection, closed when the request
//    ends. Nothing a query does to its session (settings, advisory locks,
//    temporary objects) can reach the next request, because there is no
//    session left.
//  - The user's text is embedded in one statement that is sent with bind
//    parameters, i.e. through the extended protocol, where Postgres itself
//    refuses a second statement. No amount of quoting tricks turns one request
//    into two statements, so nothing can leave the READ ONLY transaction.
//  - That statement stops after `maxRows` rows and after `maxBytes` of data,
//    counted inside Postgres, so an oversized result never reaches this process.
//  - The role can only SELECT, cannot create temporary tables, cannot take
//    advisory locks, and has a statement timeout and a temp-file limit
//    (ensureReadonlyRole in db.ts).

import type { SqlResult } from "../shared/api.ts";
import { SQL } from "bun";
import { isConnectionError } from "./db.ts";

export class SqlRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SqlRequestError";
  }
}

const IDENT = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * Returns the statement without trailing semicolons, or throws when the text
 * holds more than one statement. Understands quotes, E'' strings, dollar
 * quoting and comments, so a semicolon inside any of those is not a separator.
 */
export function singleStatement(input: string): string {
  const s = input;
  let end = -1; // index of the first top-level semicolon
  let hasCode = false;
  let i = 0;
  const unterminated = (what: string) => new SqlRequestError(`unterminated ${what}`, 400);

  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === "-" && next === "-") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") (depth++, (i += 2));
        else if (s[i] === "*" && s[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      if (depth > 0) throw unterminated("comment");
    } else if (c === "'") {
      if (end !== -1) throw new SqlRequestError("only one statement per request", 400);
      hasCode = true;
      const prev = s[i - 1];
      const escapes = (prev === "e" || prev === "E") && !(i >= 2 && IDENT.test(s[i - 2]!));
      i++;
      for (;;) {
        if (i >= s.length) throw unterminated("string");
        if (escapes && s[i] === "\\") i += 2;
        else if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (c === '"') {
      if (end !== -1) throw new SqlRequestError("only one statement per request", 400);
      hasCode = true;
      i++;
      for (;;) {
        if (i >= s.length) throw unterminated("identifier");
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (c === "$" && !(i > 0 && IDENT.test(s[i - 1]!))) {
      // The wrapper statement uses $1 and $2 itself.
      if (/[0-9]/.test(next ?? "")) throw new SqlRequestError("query parameters ($1, $2, ...) are not supported", 400);
      const tag = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(s.slice(i));
      if (end !== -1) throw new SqlRequestError("only one statement per request", 400);
      hasCode = true;
      if (!tag) {
        i++;
        continue;
      }
      const close = s.indexOf(tag[0], i + tag[0].length);
      if (close === -1) throw unterminated("dollar-quoted string");
      i = close + tag[0].length;
    } else if (c === ";") {
      if (end === -1) end = i;
      i++;
    } else {
      if (!/\s/.test(c)) {
        if (end !== -1) throw new SqlRequestError("only one statement per request", 400);
        hasCode = true;
      }
      i++;
    }
  }
  const statement = (end === -1 ? s : s.slice(0, end)).trim();
  // Nothing but whitespace and comments.
  if (!statement || !hasCode) throw new SqlRequestError("empty query", 400);
  return statement;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return value.map(jsonValue);
  return value;
}

export interface SqlLimits {
  timeoutMs: number;
  maxRows: number;
  /** Budget for the returned rows, measured as Postgres text. */
  maxBytes: number;
}

const QUERY_KEYWORDS = new Set(["select", "with", "values", "table"]);
const NOT_A_QUERY = "only read queries are allowed: SELECT, WITH, VALUES or TABLE, optionally under EXPLAIN";
const LEADING_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/;
const EXPLAIN_PREFIX = /^explain\b\s*(\([^()'"$;]*\)\s*|(?:(?:analy[sz]e|verbose)\b\s*)*)/i;

function firstKeyword(sql: string): string {
  return /^[\s(]*([A-Za-z]+)/.exec(sql)?.[1]?.toLowerCase() ?? "";
}

/**
 * The one statement that is sent to Postgres for a query.
 *
 * $1 is the row cap plus one, $2 the byte budget. The inner SELECT numbers the
 * rows and keeps a running total of their size as text; the outer one returns
 * the rows that fit, next to how many rows there were and how many fit. The
 * LEFT JOIN makes sure a row comes back even when nothing fits, so "no rows"
 * and "first row too big" can be told apart. Sizes are taken from the very
 * rows that are returned, so a query cannot show one size and send another.
 *
 * The user's text sits between newlines so that a trailing "--" comment ends
 * before the closing parenthesis. If the text closes that parenthesis itself
 * and starts something else, the result is either still one read-only
 * statement or a syntax error; it is never two statements.
 */
function wrapQuery(statement: string): string {
  return `with "__slop_w" as materialized (
  select "__slop_q".*,
         row_number() over () as "__slop_n",
         sum(octet_length("__slop_q"::text)) over (rows between unbounded preceding and current row) as "__slop_b"
  from (
${statement}
  ) "__slop_q"
  limit $1
)
select m.total, m.fit, w.*
from (select count(*) as total, count(*) filter (where "__slop_b" <= $2) as fit from "__slop_w") m
left join "__slop_w" w on w."__slop_b" <= $2
order by w."__slop_n"`;
}

type Values = unknown[][] & { columns?: { name: string }[] | null };

/**
 * Runs one read-only query as the read-only role on a connection of its own.
 * `roUrl` is DATABASE_RO_URL.
 */
export async function runReadOnly(roUrl: string, text: string, limits: SqlLimits): Promise<SqlResult> {
  const statement = singleStatement(text);
  const body = statement.replace(LEADING_COMMENTS, "");
  const explain = EXPLAIN_PREFIX.exec(body);
  const query = explain ? body.slice(explain[0].length) : body;
  if (!QUERY_KEYWORDS.has(firstKeyword(query))) throw new SqlRequestError(NOT_A_QUERY, 400);

  const started = performance.now();
  const timeout = Math.max(1, Math.floor(limits.timeoutMs));
  const maxRows = Math.max(1, Math.floor(limits.maxRows));
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes));

  // A connection for this request alone. `max: 1` keeps Bun from opening more.
  const conn = new SQL(roUrl, { max: 1, connectionTimeout: 5, idleTimeout: 30 });
  let fetched: Values;
  try {
    fetched = await conn.begin("read only", async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${timeout}`);
      // The bind parameters are what select the extended protocol.
      if (explain) {
        // EXPLAIN shows the plan of the query under the same row cap.
        const sql = `${explain[0].trimEnd()}\nselect * from (\n${query}\n) "__slop_q" limit $1`;
        return (await tx.unsafe(sql, [maxRows + 1]).values()) as Values;
      }
      return (await tx.unsafe(wrapQuery(query), [maxRows + 1, maxBytes]).values()) as Values;
    });
  } catch (error) {
    const e = error as { errno?: unknown; message?: string };
    // Postgres answered with an SQLSTATE: the query is at fault, unless the server is going away.
    if (typeof e.errno === "string" && /^[0-9A-Z]{5}$/.test(e.errno) && !isConnectionError(error)) {
      const hint = e.errno === "57014" ? ` (limit is ${timeout} ms)` : "";
      throw new SqlRequestError(`${e.message ?? "query failed"}${hint}`, 400);
    }
    throw new SqlRequestError(`database unavailable: ${e.message ?? String(error)}`, 503);
  } finally {
    // With the connection goes every bit of session state the query may have left.
    await conn.close({ timeout: 1 }).catch(() => {});
  }

  const names = (fetched.columns ?? []).map((c) => c.name);
  let columns: string[];
  let rows: unknown[][];
  let truncated: boolean;
  if (explain) {
    columns = names;
    // A plan is small; the caps are applied here only as a backstop.
    let bytes = 0;
    rows = [];
    for (const row of fetched) {
      bytes += String(row[0] ?? "").length;
      if (rows.length >= maxRows || bytes > maxBytes) break;
      rows.push(row.map(jsonValue));
    }
    truncated = rows.length < fetched.length;
  } else {
    // Each row is [total, fit, ...the query's columns, row number, running bytes].
    columns = names.slice(2, -2);
    const total = Number(fetched[0]?.[0] ?? 0);
    const fit = Number(fetched[0]?.[1] ?? 0);
    const keep = Math.min(fit, maxRows);
    rows = fetched.slice(0, keep).map((row) => row.slice(2, -2).map(jsonValue));
    truncated = total > keep;
  }
  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/**
 * Bounds how many queries run at once: each one holds a database connection,
 * and the role is limited to a handful.
 */
export class SqlGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxActive = 4,
    private readonly maxWaiting = 16,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) {
      if (this.waiting.length >= this.maxWaiting) throw new SqlRequestError("too many queries at once, try again shortly", 503);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next in line, or free it.
      if (next) next();
      else this.active--;
    }
  }
}
