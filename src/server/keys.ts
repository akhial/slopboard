// People and their client API keys. Used by the CLI (src/server/cli.ts).
//
// A key exists in plaintext in exactly two places: the proxy's config, and the
// terminal of whoever ran `keys add`, once. Slopboard keeps the SHA-256.

import { randomBytes } from "node:crypto";
import { num, type Db } from "./db.ts";
import { slugify } from "./format.ts";
import { hashApiKey } from "./ingest.ts";
import type { ProxyClient } from "./proxy.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Person {
  id: string;
  name: string;
}

/** 32 random bytes, so guessing one is not a thing. */
export function generateKey(): string {
  return `sk-slop-${randomBytes(32).toString("base64url")}`;
}

/** Finds a person by id (slug) or by display name, case-insensitively. */
export async function findPerson(sql: Db, nameOrId: string): Promise<Person | null> {
  const wanted = nameOrId.trim();
  const rows = await sql<Person[]>`
    select id, name from people
    where id = ${slugify(wanted)} or lower(name) = lower(${wanted})
    order by (id = ${slugify(wanted)}) desc
    limit 1`;
  return rows[0] ?? null;
}

async function requirePerson(sql: Db, nameOrId: string): Promise<Person> {
  const person = await findPerson(sql, nameOrId);
  if (!person) throw new UsageError(`no such person: ${nameOrId}`);
  return person;
}

/** Returns the person called `name`, creating them if needed. */
export async function ensurePerson(sql: Db, name: string): Promise<Person & { created: boolean }> {
  const display = name.trim();
  const existing = await findPerson(sql, display);
  if (existing) return { ...existing, created: false };
  const id = slugify(display);
  if (!id) throw new UsageError(`"${name}" has no letters or digits to build an id from`);
  if (id === "shared") throw new UsageError(`"shared" is reserved for traffic that belongs to nobody`);
  await sql`insert into people (id, name) values (${id}, ${display})`;
  return { id, name: display, created: true };
}

export interface AddedKey {
  person: Person;
  /** The plaintext key. Show it to the user once and forget it. */
  key: string;
  keyHash: string;
  /** Keys the proxy accepted before and accepts now. */
  proxyKeysBefore: number;
  proxyKeysAfter: number;
}

/**
 * `keys add` failed after writing to the proxy, and the key could not be taken
 * out again. The proxy may accept a key that nobody holds.
 */
export class OrphanedKeyError extends Error {
  constructor(
    readonly keyHash: string,
    readonly original: Error,
    readonly cleanupError: Error,
  ) {
    super(original.message);
    this.name = "OrphanedKeyError";
  }
}

export const OPEN_PROXY_WARNING =
  "With no client API keys the proxy accepts every request without a key. The first key turns authentication on for everyone at once: anybody who does not have it is locked out.";

/**
 * Creates a key for `name`, registers it with the proxy and records hash -> person.
 *
 * Refuses to add the first key of a proxy that has none, unless `allowFirstKey`.
 */
export async function addKey(
  sql: Db,
  proxy: ProxyClient,
  name: string,
  opts: { label?: string | null; allowFirstKey?: boolean } = {},
): Promise<AddedKey> {
  const person = await ensurePerson(sql, name);
  const key = generateKey();
  const keyHash = hashApiKey(key);
  await sql`insert into api_keys (key_hash, person_id, label) values (${keyHash}, ${person.id}, ${opts.label ?? null})`;
  const forget = async () => {
    await sql`delete from api_keys where key_hash = ${keyHash}`;
    if (person.created) await sql`delete from people where id = ${person.id}`;
  };

  // From the moment a write is attempted, the proxy may hold the key even if
  // the answer never arrives.
  let writeAttempted = false;
  try {
    // Read, append, write back under If-Match: every key already there stays.
    const change = await proxy.updateApiKeys((keys) => {
      if (keys.length === 0 && !opts.allowFirstKey) {
        throw new UsageError(`the proxy has no client API keys. ${OPEN_PROXY_WARNING}\nPass --first-key if that is what you want.`);
      }
      writeAttempted = true;
      return [...keys, key];
    });
    const now = await proxy.getApiKeys();
    if (!now.keys.includes(key)) throw new Error("the proxy accepted the write but does not list the new key");
    return {
      person: { id: person.id, name: person.name },
      key,
      keyHash,
      proxyKeysBefore: change.before.length,
      proxyKeysAfter: now.keys.length,
    };
  } catch (error) {
    if (!writeAttempted) {
      await forget();
      throw error;
    }
    // The key was never shown to anyone, so it must not stay valid.
    try {
      await proxy.updateApiKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : null));
    } catch (cleanupError) {
      // Keep hash -> person, so the key shows up in `keys list` and `keys revoke` can find it.
      await sql`update api_keys set label = 'add failed; may still be accepted by the proxy' where key_hash = ${keyHash}`;
      throw new OrphanedKeyError(keyHash, error as Error, cleanupError as Error);
    }
    await forget();
    throw error;
  }
}

export interface RevocableKey {
  keyHash: string;
  label: string | null;
  events: number;
  lastSeenAt: Date | null;
}

/** The active keys of `name`, with how much each has been used: what `keys revoke` would remove. */
export async function revocableKeys(sql: Db, name: string): Promise<{ person: Person; keys: RevocableKey[] }> {
  const person = await requirePerson(sql, name);
  const rows = await sql`
    select k.key_hash, k.label, count(e.event_id) as events, max(e.ts) as last_seen
    from api_keys k left join events e on e.key_hash = k.key_hash
    where k.person_id = ${person.id} and k.revoked_at is null
    group by k.key_hash, k.label, k.created_at
    order by k.created_at, k.key_hash`;
  return {
    person,
    keys: rows.map((r: Record<string, unknown>) => ({
      keyHash: String(r.key_hash),
      label: (r.label as string | null) ?? null,
      events: num(r.events),
      lastSeenAt: (r.last_seen as Date | null) ?? null,
    })),
  };
}

export interface RevokeResult {
  person: Person | null;
  /** Hashes of the keys taken out of the proxy's config. */
  removedFromProxy: string[];
  /** Keys marked revoked here. */
  revoked: number;
  proxyKeysBefore: number;
  proxyKeysAfter: number;
}

const LAST_KEY_REFUSAL =
  "this would remove the proxy's last client API key. With no keys the proxy accepts every request without a key, " +
  "so it would be open to anyone who can reach it. Add another key first, or pass --force to open the proxy on purpose.";

async function removeFromProxy(proxy: ProxyClient, hashes: Set<string>, force: boolean) {
  let removed: string[] = [];
  const change = await proxy.updateApiKeys((keys) => {
    const keep = keys.filter((k) => !hashes.has(hashApiKey(k)));
    removed = keys.map(hashApiKey).filter((h) => hashes.has(h));
    if (removed.length === 0) return null;
    if (keep.length === 0 && !force) throw new UsageError(LAST_KEY_REFUSAL);
    return keep;
  });
  return { removed, before: change.before.length, after: change.after.length };
}

/**
 * Removes every active key of `name` from the proxy. The hash -> person rows
 * stay (marked revoked), so past usage remains attributed. `force` allows
 * removing the proxy's last key, which leaves the proxy open to everyone.
 */
export async function revokeKeys(sql: Db, proxy: ProxyClient, name: string, force = false): Promise<RevokeResult> {
  const { person, keys } = await revocableKeys(sql, name);
  if (keys.length === 0) throw new UsageError(`${person.name} has no active keys`);
  const hashes = new Set(keys.map((k) => k.keyHash));
  const res = await removeFromProxy(proxy, hashes, force);
  const done = await sql`
    update api_keys set revoked_at = now()
    where key_hash = any(${[...hashes]}::text[]) and revoked_at is null
    returning key_hash`;
  return { person, removedFromProxy: res.removed, revoked: done.length, proxyKeysBefore: res.before, proxyKeysAfter: res.after };
}

/** The keys of the proxy whose SHA-256 starts with `prefix`, by hash. */
export async function proxyKeysByHash(proxy: ProxyClient, prefix: string): Promise<string[]> {
  const wanted = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(wanted)) throw new UsageError("give at least the first 8 hex digits of the key's SHA-256 (see keys list)");
  const hashes = (await proxy.getApiKeys()).keys.map(hashApiKey).filter((h) => h.startsWith(wanted));
  return [...new Set(hashes)];
}

/**
 * Removes one key from the proxy by its hash, whoever it belongs to. This is
 * the way out for a key that nobody holds any more.
 */
export async function dropProxyKey(sql: Db, proxy: ProxyClient, prefix: string, force = false): Promise<RevokeResult> {
  const hashes = await proxyKeysByHash(proxy, prefix);
  if (hashes.length === 0) throw new UsageError(`the proxy has no key whose SHA-256 starts with ${prefix}`);
  if (hashes.length > 1) throw new UsageError(`${hashes.length} proxy keys start with ${prefix}; give more digits`);
  const res = await removeFromProxy(proxy, new Set(hashes), force);
  const done = await sql`
    update api_keys set revoked_at = now() where key_hash = ${hashes[0]!} and revoked_at is null returning key_hash`;
  return { person: null, removedFromProxy: res.removed, revoked: done.length, proxyKeysBefore: res.before, proxyKeysAfter: res.after };
}

export interface AssignResult {
  person: Person;
  keyHash: string;
  /** Who the key belonged to before, when that was someone else. */
  previousPersonId: string | null;
  /** Whether the proxy currently accepts this key; null when the proxy was not asked. */
  knownToProxy: boolean | null;
}

/** Labels an existing key as belonging to `name`. Its past events follow. */
export async function assignKey(sql: Db, proxy: ProxyClient | null, name: string, key: string): Promise<AssignResult> {
  const plaintext = key.trim();
  if (!plaintext) throw new UsageError("no key given on standard input");
  if (/\s/.test(plaintext)) throw new UsageError("the key must be a single token without whitespace");
  const keyHash = hashApiKey(plaintext);
  const person = await ensurePerson(sql, name);
  const before = await sql<{ person_id: string }[]>`select person_id from api_keys where key_hash = ${keyHash}`;
  await sql`
    insert into api_keys (key_hash, person_id) values (${keyHash}, ${person.id})
    on conflict (key_hash) do update set person_id = excluded.person_id, revoked_at = null`;

  let knownToProxy: boolean | null = null;
  if (proxy) {
    try {
      knownToProxy = (await proxy.getApiKeys()).keys.includes(plaintext);
    } catch {
      knownToProxy = null;
    }
  }
  const previous = before[0]?.person_id ?? null;
  return {
    person: { id: person.id, name: person.name },
    keyHash,
    previousPersonId: previous && previous !== person.id ? previous : null,
    knownToProxy,
  };
}

export async function renamePerson(sql: Db, nameOrId: string, newName: string): Promise<Person> {
  const person = await requirePerson(sql, nameOrId);
  const display = newName.trim();
  if (!display) throw new UsageError("the new name is empty");
  const clash = await findPerson(sql, display);
  if (clash && clash.id !== person.id) throw new UsageError(`"${display}" is already ${clash.id}`);
  // The id stays: it is what URLs and DOM ids are built from.
  await sql`update people set name = ${display} where id = ${person.id}`;
  return { id: person.id, name: display };
}

export interface KeyListing {
  keyHash: string;
  personId: string | null;
  personName: string | null;
  label: string | null;
  createdAt: Date | null;
  /** active: accepted by the proxy. revoked: revoked here. missing: assigned but the proxy does not list it. */
  status: "active" | "revoked" | "missing" | "unassigned" | "unknown";
  events: number;
  lastSeenAt: Date | null;
}

/**
 * Every key Slopboard knows of: assigned ones, keys the proxy accepts that
 * belong to nobody, and hashes that only show up in events.
 */
export async function listKeys(sql: Db, proxy: ProxyClient | null): Promise<{ keys: KeyListing[]; proxyError: string | null }> {
  let proxyHashes: Set<string> | null = null;
  let proxyError: string | null = null;
  if (proxy) {
    try {
      proxyHashes = new Set((await proxy.getApiKeys()).keys.map(hashApiKey));
    } catch (error) {
      proxyError = (error as Error).message;
    }
  }

  const usage = new Map<string, { events: number; lastSeenAt: Date | null }>();
  for (const r of await sql`select key_hash, count(*) as n, max(ts) as last from events where key_hash is not null group by 1`) {
    usage.set(String(r.key_hash), { events: num(r.n), lastSeenAt: (r.last as Date | null) ?? null });
  }

  const out: KeyListing[] = [];
  const seen = new Set<string>();
  const assigned = await sql`
    select k.key_hash, k.person_id, p.name, k.label, k.created_at, k.revoked_at
    from api_keys k join people p on p.id = k.person_id
    order by p.name, k.created_at`;
  for (const r of assigned) {
    const hash = String(r.key_hash);
    seen.add(hash);
    const status = r.revoked_at ? "revoked" : proxyHashes === null ? "unknown" : proxyHashes.has(hash) ? "active" : "missing";
    out.push({
      keyHash: hash,
      personId: String(r.person_id),
      personName: String(r.name),
      label: (r.label as string | null) ?? null,
      createdAt: (r.created_at as Date | null) ?? null,
      status,
      ...(usage.get(hash) ?? { events: 0, lastSeenAt: null }),
    });
  }
  for (const hash of new Set([...(proxyHashes ?? []), ...usage.keys()])) {
    if (seen.has(hash)) continue;
    out.push({
      keyHash: hash,
      personId: null,
      personName: null,
      label: null,
      createdAt: null,
      status: proxyHashes === null ? "unknown" : proxyHashes.has(hash) ? "unassigned" : "missing",
      ...(usage.get(hash) ?? { events: 0, lastSeenAt: null }),
    });
  }
  return { keys: out, proxyError };
}
