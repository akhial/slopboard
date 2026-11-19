import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Db = SQL;

export function connect(url: string, max = 10): Db {
  return new SQL(url, { max, idleTimeout: 60, connectionTimeout: 10 });
}

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
/** Arbitrary constant: serialises migrations when two processes boot at once. */
const MIGRATION_LOCK = 7_310_318;

/**
 * Serialises schema work inside the caller's transaction. Gives up after a
 * while instead of hanging: a boot or a CLI command stuck for ever on a lock
 * somebody forgot is worse than one that fails and says why.
 */
async function lockMigrations(tx: Db): Promise<void> {
  await tx.unsafe("set local lock_timeout = '30s'");
  try {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
  } catch (error) {
    if ((error as { errno?: unknown }).errno === "55P03") {
      throw new Error(`another database session has held the schema lock (advisory lock ${MIGRATION_LOCK}) for 30 s`);
    }
    throw error;
  }
  await tx.unsafe("set local lock_timeout = 0");
}

/** Applies pending migrations in file-name order. Safe to call on every boot. */
export async function migrate(sql: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return await sql.begin(async (tx) => {
    await lockMigrations(tx);
    await tx`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      )`;
    const done = new Set(
      (await tx<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version),
    );
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      // No parameters, so Bun sends the file as one multi-statement simple query.
      await tx.unsafe(await Bun.file(join(MIGRATIONS_DIR, file)).text());
      await tx`insert into schema_migrations (version) values (${file})`;
      applied.push(file);
    }
    return applied;
  });
}

function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("NUL byte in SQL literal");
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Creates (or repairs) the read-only role named in `roUrl`. The role is the
 * security boundary of POST /api/sql, so this runs at every boot and puts
 * everything back the way it must be:
 *
 *  - SELECT on the public schema and nothing else; no CREATE, no TEMPORARY
 *    (temporary tables are writable even in a read-only transaction);
 *  - no advisory locks: they outlive transactions, the migration lock is one,
 *    and taken by the hundred thousand they exhaust the shared lock table.
 *    EXECUTE on those functions is revoked from PUBLIC in this database and
 *    granted back to the role this process runs as;
 *  - per-role settings reset and set again, so anything the role managed to
 *    `ALTER ROLE ... SET` for itself is gone. (Postgres lets any role alter its
 *    own settings; what stops this one is that its statements only ever run
 *    inside a read-only transaction, see sqlapi.ts.)
 *
 * Needs a superuser, which the compose database user is.
 */
export async function ensureReadonlyRole(sql: Db, roUrl: string, statementTimeoutMs: number): Promise<string> {
  const url = new URL(roUrl);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`read-only role name "${role}" must match [a-z_][a-z0-9_]*`);
  }
  if (!password) throw new Error("DATABASE_RO_URL has no password");
  const [current] = await sql<{ me: string }[]>`select current_user as me`;
  if (current?.me === role) throw new Error("DATABASE_RO_URL must not use the same role as DATABASE_URL");

  const timeout = Math.max(100, Math.floor(statementTimeoutMs));
  await sql.begin(async (tx) => {
    await lockMigrations(tx);
    await tx.unsafe(`
      do $slop$
      declare
        fn regprocedure;
      begin
        if not exists (select from pg_roles where rolname = '${role}') then
          create role ${role};
        end if;
        execute format('grant connect on database %I to ${role}', current_database());
        execute format('revoke temporary on database %I from public', current_database());
        execute format('revoke temporary, create on database %I from ${role}', current_database());
        execute format('alter role ${role} in database %I reset all', current_database());
        for fn in
          select p.oid::regprocedure from pg_proc p
          where p.pronamespace = 'pg_catalog'::regnamespace and p.proname ~ '^pg_(try_)?advisory_'
        loop
          execute format('revoke execute on function %s from public', fn);
          execute format('revoke execute on function %s from ${role}', fn);
          execute format('grant execute on function %s to %I', fn, current_user);
        end loop;
      end
      $slop$;
      alter role ${role} with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
        connection limit 8 password ${quoteLiteral(password)};
      alter role ${role} reset all;
      alter role ${role} set default_transaction_read_only = on;
      alter role ${role} set statement_timeout = ${timeout};
      alter role ${role} set idle_in_transaction_session_timeout = ${timeout * 4};
      alter role ${role} set idle_session_timeout = 60000;
      -- Sorts and hashes that spill to disk stop here. Only a superuser can change it.
      alter role ${role} set temp_file_limit = '1GB';
      revoke create on schema public from public;
      revoke all on schema public from ${role};
      grant usage on schema public to ${role};
      revoke all on all tables in schema public from ${role};
      grant select on all tables in schema public to ${role};
      alter default privileges in schema public grant select on tables to ${role};
    `);
  });
  return role;
}

export async function setMeta(sql: Db, key: string, value: unknown): Promise<void> {
  // The parameter is typed as text on purpose: handed a jsonb parameter, Bun
  // would encode the already encoded string a second time.
  await sql`
    insert into meta (key, value, updated_at) values (${key}, (${JSON.stringify(value)}::text)::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export async function getMeta<T>(sql: Db, key: string): Promise<T | null> {
  const rows = await sql<{ value: T }[]>`select value from meta where key = ${key}`;
  return rows[0]?.value ?? null;
}

/** True when the error means "could not reach Postgres", as opposed to "Postgres said no". */
export function isConnectionError(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const sqlState = typeof e?.errno === "string" ? e.errno : "";
  // Postgres answered: 08 connection exception, 53 insufficient resources, 57P shutdown.
  if (/^[0-9A-Z]{5}$/.test(sqlState)) return /^(08|53|57P)/.test(sqlState);
  // It did not: ERR_POSTGRES_CONNECTION_REFUSED, ..._CONNECTION_CLOSED, ..._TIMEOUT, ...
  return /CONNECT|CLOSED|TIMEOUT|LIFETIME/.test(code);
}

/**
 * True when Postgres refused a statement because of the data in it: SQLSTATE
 * class 22 (data exception, e.g. a number out of range) or 23 (integrity
 * constraint violation). Retrying such a row can never work. Everything else
 * (missing column, permission denied, deadlock, cancelled statement) says
 * nothing about the row and may well work later.
 */
export function isRowError(error: unknown): boolean {
  const sqlState = (error as { errno?: unknown } | null)?.errno;
  return typeof sqlState === "string" && /^(22|23)[0-9A-Z]{3}$/.test(sqlState);
}

/** Bun returns bigint and numeric as strings; the board only needs JS numbers. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
