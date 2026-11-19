import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { hashApiKey, insertEvents, normalizeRecord } from "../ingest.ts";
import { usageRecord } from "../synthetic.ts";
import { FakeProxy } from "./fake-proxy.ts";
import { createTestDb, SETUP_TIMEOUT, type TestDb } from "./pg.ts";

// Talks to Postgres (and may be the file that starts its container).
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "cli.ts");
const OLD_SHARED = "the-old-shared-key";
const OTHER = "somebody-elses-key";

let db: TestDb;
let proxy: FakeProxy;

beforeAll(async () => {
  db = await createTestDb("cli");
  proxy = new FakeProxy("cli-management-key");
  proxy.apiKeys = [OLD_SHARED, OTHER];
}, SETUP_TIMEOUT);

afterAll(async () => {
  await proxy.stop();
  await db.close();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the real CLI as a subprocess, the way an operator would. */
async function cli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: db.url,
      PROXY_URL: proxy.url,
      PROXY_MANAGEMENT_KEY: proxy.managementKey,
      ...opts.env,
    },
    // An empty directory, so no .env of the checkout leaks into the run.
    cwd: import.meta.dir + "/fixtures",
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function keyRows(): Promise<Record<string, unknown>[]> {
  return await db.sql`select key_hash, person_id, revoked_at from api_keys order by created_at, key_hash`;
}

/** Fails if `secret` is readable anywhere in the people and key tables. */
async function expectNotStored(secret: string): Promise<void> {
  const [row] = await db.sql`
    select (select count(*) from api_keys k where k::text like ${"%" + secret + "%"})
         + (select count(*) from people p where p::text like ${"%" + secret + "%"})
         + (select count(*) from meta m where m::text like ${"%" + secret + "%"}) as n`;
  expect(Number(row!.n)).toBe(0);
}

describe("keys add", () => {
  let adaKey = "";

  test("registers a new key with the proxy without touching the existing ones", async () => {
    const res = await cli(["keys", "add", "Ada Lovelace"]);
    expect(res.code).toBe(0);
    // Standard output is the key and nothing else, so it can be piped.
    expect(res.stdout).toMatch(/^sk-slop-[A-Za-z0-9_-]{43}\n$/);
    adaKey = res.stdout.trim();
    expect(res.stderr).not.toContain(adaKey);
    expect(res.stderr).toContain("Ada Lovelace");
    expect(res.stderr).toContain("accepted 2 keys before and accepts 3 keys now");

    expect(proxy.apiKeys).toEqual([OLD_SHARED, OTHER, adaKey]);
    expect(proxy.puts).toHaveLength(1);

    const people = await db.sql`select id, name from people`;
    expect(people.map((p: Record<string, unknown>) => [p.id, p.name])).toEqual([["ada-lovelace", "Ada Lovelace"]]);
    const keys = await keyRows();
    expect(keys.map((k) => [k.key_hash, k.person_id, k.revoked_at])).toEqual([[hashApiKey(adaKey), "ada-lovelace", null]]);
    await expectNotStored(adaKey);
  });

  test("a second key for the same person, found by id, gets a different secret", async () => {
    const res = await cli(["keys", "add", "ada-lovelace"]);
    expect(res.code).toBe(0);
    const second = res.stdout.trim();
    expect(second).not.toBe(adaKey);
    expect(proxy.apiKeys).toEqual([OLD_SHARED, OTHER, adaKey, second]);
    expect((await db.sql`select count(*) as n from people`)[0]!.n).toBe("1");
    expect(await keyRows()).toHaveLength(2);
  });

  test("survives someone else editing the proxy's key list at the same moment", async () => {
    const before = [...proxy.apiKeys!];
    // Between this CLI's read and its write, another admin adds a key.
    proxy.beforeNextPut = () => proxy.apiKeys!.push("added-by-someone-else");
    const res = await cli(["keys", "add", "Grace Hopper"]);
    expect(res.code).toBe(0);
    const grace = res.stdout.trim();
    // The stale write was refused (412) and redone on top of the other admin's change.
    expect(proxy.apiKeys).toEqual([...before, "added-by-someone-else", grace]);
  });

  test("will not add the first key of an open proxy unless told to", async () => {
    const saved = proxy.apiKeys;
    const puts = proxy.puts.length;
    // No list at all, or an empty one: either way the proxy accepts everybody,
    // and the first key would lock out everyone who does not have it.
    for (const none of [null, []]) {
      proxy.apiKeys = none;
      const refused = await cli(["keys", "add", "Linus"]);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("accepts every request without a key");
      expect(refused.stderr).toContain("--first-key");
      expect(proxy.apiKeys).toEqual(none);
    }
    expect(proxy.puts).toHaveLength(puts);
    expect(await db.sql`select 1 from people where id = 'linus'`).toHaveLength(0);

    proxy.apiKeys = null;
    const res = await cli(["keys", "add", "Linus", "--first-key"]);
    expect(res.code).toBe(0);
    expect(proxy.apiKeys as string[] | null).toEqual([res.stdout.trim()]);
    expect(res.stderr).toContain("accepted 0 keys before and accepts 1 key now");
    expect(res.stderr).toContain("From now on a key is required");
    proxy.apiKeys = [...saved!, res.stdout.trim()];
  });

  test("a write whose answer is lost does not leave a key nobody holds", async () => {
    const before = [...proxy.apiKeys!];
    const rows = await keyRows();
    // The proxy stores the new list, but the response never arrives.
    proxy.loseNextPutResponse = true;
    const res = await cli(["keys", "add", "Lost Reply"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    // The key went in (second to last write) and was taken out again (last write).
    expect(proxy.puts.at(-2)).toHaveLength(before.length + 1);
    expect(proxy.apiKeys).toEqual(before);
    expect(await keyRows()).toEqual(rows);
    expect(await db.sql`select 1 from people where id = 'lost-reply'`).toHaveLength(0);

    // Same when the write is confirmed but reading the list back fails.
    proxy.failAfterNextPut = 1;
    const unverified = await cli(["keys", "add", "Lost Reply"]);
    expect(unverified.code).toBe(1);
    expect(unverified.stdout).toBe("");
    expect(proxy.apiKeys).toEqual(before);
    expect(await keyRows()).toEqual(rows);
  });

  test("when the key cannot be removed again, says which key and how to get rid of it", async () => {
    const before = [...proxy.apiKeys!];
    // The write lands, then the proxy stops answering: no verification, no clean-up.
    proxy.failAfterNextPut = 2;
    const res = await cli(["keys", "add", "Stranded"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(proxy.apiKeys).toHaveLength(before.length + 1);
    const orphan = proxy.apiKeys!.find((k) => !before.includes(k))!;
    const hash = hashApiKey(orphan);
    expect(res.stderr).not.toContain(orphan);
    expect(res.stderr).toContain(hash);
    expect(res.stderr).toContain("removed by hand");
    expect(res.stderr).toContain(`keys drop ${hash.slice(0, 12)} --yes`);

    // It is not forgotten: the hash stays on record and shows in the list.
    const [row] = await db.sql`select person_id, label, revoked_at from api_keys where key_hash = ${hash}`;
    expect(row).toMatchObject({ person_id: "stranded", revoked_at: null });
    const list = await cli(["keys", "list"]);
    expect(list.stdout).toMatch(new RegExp(`Stranded\\s+stranded\\s+${hash.slice(0, 12)}\\s+active.*add failed`));

    // And the advertised way out works.
    const preview = await cli(["keys", "drop", hash.slice(0, 12)]);
    expect(preview.code).toBe(2);
    expect(proxy.apiKeys).toContain(orphan);
    const dropped = await cli(["keys", "drop", hash.slice(0, 12), "--yes"]);
    expect(dropped.code).toBe(0);
    expect(proxy.apiKeys).toEqual(before);
    expect((await db.sql`select revoked_at from api_keys where key_hash = ${hash}`)[0]!.revoked_at).not.toBeNull();
    expect((await cli(["keys", "drop", "deadbeef00", "--yes"])).code).toBe(2);
    expect((await cli(["keys", "drop", "abc", "--yes"])).code).toBe(2);
  });

  test("does not mistake a stray 404 for an empty list, nor write without a version", async () => {
    const before = [...proxy.apiKeys!];
    const puts = proxy.puts.length;
    const rows = await keyRows();

    // A 404 from somewhere that is not the config handler: wrong URL, management API off.
    proxy.foreign404 = "404 page not found";
    const stray = await cli(["keys", "add", "Wrong Door", "--first-key"]);
    proxy.foreign404 = null;
    expect(stray.code).toBe(1);
    expect(stray.stderr).toContain("404");

    // A key list that comes without an ETag cannot be written back safely.
    proxy.omitEtag = true;
    const blind = await cli(["keys", "add", "Wrong Door"]);
    proxy.omitEtag = false;
    expect(blind.code).toBe(1);
    expect(blind.stderr).toContain("ETag");

    expect(proxy.puts).toHaveLength(puts);
    expect(proxy.apiKeys).toEqual(before);
    expect(await keyRows()).toEqual(rows);
    expect(await db.sql`select 1 from people where id = 'wrong-door'`).toHaveLength(0);
  });

  test("leaves nothing behind when the proxy refuses", async () => {
    const keysBefore = await keyRows();
    const proxyBefore = [...proxy.apiKeys!];
    const res = await cli(["keys", "add", "Nobody Yet"], { env: { PROXY_MANAGEMENT_KEY: "wrong" } });
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("PROXY_MANAGEMENT_KEY");
    expect(await keyRows()).toEqual(keysBefore);
    expect(await db.sql`select 1 from people where id = 'nobody-yet'`).toHaveLength(0);
    expect(proxy.apiKeys).toEqual(proxyBefore);
  });

  test("refuses the reserved name and bad usage", async () => {
    expect((await cli(["keys", "add", "shared"])).code).toBe(2);
    expect((await cli(["keys", "add"])).code).toBe(2);
    expect((await cli(["keys", "add", "a", "b"])).code).toBe(2);
    expect((await cli(["nonsense"])).code).toBe(2);
    expect((await cli(["--help"])).code).toBe(0);
  });

  test("keys list shows owners and statuses, never a key", async () => {
    const res = await cli(["keys", "list"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Ada Lovelace");
    expect(res.stdout).toContain(hashApiKey(adaKey).slice(0, 12));
    expect(res.stdout).toMatch(/Ada Lovelace\s+ada-lovelace\s+[0-9a-f]{12}\s+active/);
    // The proxy's unlabelled keys are listed by hash as belonging to nobody.
    expect(res.stdout).toMatch(new RegExp(`\\(nobody\\)\\s+shared\\s+${hashApiKey(OLD_SHARED).slice(0, 12)}\\s+unassigned`));
    for (const secret of [adaKey, OLD_SHARED, OTHER]) {
      expect(res.stdout + res.stderr).not.toContain(secret);
    }
  });
});

describe("keys assign", () => {
  test("labels an existing key from standard input and re-attributes its past events", async () => {
    // Usage recorded on the shared key before anyone owned it.
    const row = normalizeRecord(
      usageRecord({ kind: "claude", at: new Date(), apiKey: OLD_SHARED, model: "m", usage: { input: 5, cacheRead: 0, cacheWrite: 0, answer: 5, reasoning: 0 } }),
    )!;
    await insertEvents(db.sql, [row]);
    const owner = async () => (await db.sql`select person_id, unassigned from events_v where event_id = ${row.event_id}`)[0]!;
    expect(await owner()).toMatchObject({ person_id: "shared", unassigned: true });

    const res = await cli(["keys", "assign", "Margaret Hamilton"], { stdin: `${OLD_SHARED}\n` });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Margaret Hamilton");
    expect(res.stdout + res.stderr).not.toContain(OLD_SHARED);
    expect(await owner()).toMatchObject({ person_id: "margaret-hamilton", unassigned: false });
    await expectNotStored(OLD_SHARED);
    // Assigning only labels: the proxy's list is not written.
    expect(proxy.apiKeys).toContain(OLD_SHARED);

    // Assigning it to someone else moves the history again.
    const again = await cli(["keys", "assign", "Ada Lovelace"], { stdin: OLD_SHARED });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("margaret-hamilton");
    expect(await owner()).toMatchObject({ person_id: "ada-lovelace" });
  });

  test("does not take the key from the command line, and needs one on stdin", async () => {
    const puts = proxy.puts.length;
    const argv = await cli(["keys", "assign", "Eve", "sk-on-the-command-line"]);
    expect(argv.code).toBe(2);
    const empty = await cli(["keys", "assign", "Eve"], { stdin: "" });
    expect(empty.code).toBe(2);
    expect(await db.sql`select 1 from people where id = 'eve'`).toHaveLength(0);
    expect(proxy.puts).toHaveLength(puts);
  });

  test("warns when the proxy does not know the key", async () => {
    const res = await cli(["keys", "assign", "Ada Lovelace"], { stdin: "a-key-the-proxy-never-saw" });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("does not accept this key");
  });
});

describe("keys revoke and people rename", () => {
  test("revoking removes only that person's keys from the proxy and keeps their history", async () => {
    const graceHashes = (await db.sql`select key_hash from api_keys where person_id = 'grace-hopper'`).map(
      (r: Record<string, unknown>) => String(r.key_hash),
    );
    expect(graceHashes).toHaveLength(1);
    const before = [...proxy.apiKeys!];
    const graceKey = before.find((k) => hashApiKey(k) === graceHashes[0])!;
    const row = normalizeRecord(
      usageRecord({ kind: "claude", at: new Date(), apiKey: graceKey, model: "m", usage: { input: 1, cacheRead: 0, cacheWrite: 0, answer: 1, reasoning: 0 } }),
    )!;
    await insertEvents(db.sql, [row]);

    // Without --yes it only shows what would go: which keys, and how much they are used.
    const preview = await cli(["keys", "revoke", "Grace Hopper"]);
    expect(preview.code).toBe(2);
    expect(preview.stderr).toMatch(new RegExp(`${graceHashes[0]!.slice(0, 12)}\\s+1\\s`));
    expect(preview.stderr).toContain("--yes");
    expect(preview.stdout + preview.stderr).not.toContain(graceKey);
    expect(proxy.apiKeys).toEqual(before);
    expect((await db.sql`select revoked_at from api_keys where key_hash = ${graceHashes[0]!}`)[0]!.revoked_at).toBeNull();

    const res = await cli(["keys", "revoke", "Grace Hopper", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(`accepted ${before.length} keys before and accepts ${before.length - 1} keys now`);
    expect(proxy.apiKeys).toEqual(before.filter((k) => k !== graceKey));
    const [key] = await db.sql`select revoked_at from api_keys where key_hash = ${graceHashes[0]!}`;
    expect(key!.revoked_at).not.toBeNull();
    const [event] = await db.sql`select person_id from events_v where event_id = ${row.event_id}`;
    expect(event!.person_id).toBe("grace-hopper");

    // Nothing left to revoke.
    expect((await cli(["keys", "revoke", "Grace Hopper", "--yes"])).code).toBe(2);
    expect((await cli(["keys", "revoke", "No Such Person", "--yes"])).code).toBe(2);
  });

  test("revoking someone who was given the shared key shows that it is in the blast radius", async () => {
    // Ada holds her own keys and, since `keys assign`, the key everybody else still uses.
    const before = [...proxy.apiKeys!];
    const preview = await cli(["keys", "revoke", "Ada Lovelace"]);
    expect(preview.code).toBe(2);
    const shared = hashApiKey(OLD_SHARED).slice(0, 12);
    expect(preview.stderr).toContain(shared);
    // Every key is listed with its event count; the shared one has the traffic.
    expect(preview.stderr.match(/^[0-9a-f]{12}\s+\d+/gm)).toHaveLength(4);
    expect(preview.stderr).toMatch(new RegExp(`^${shared}\\s+1\\s`, "m"));
    expect(preview.stderr).toContain("Nothing was changed");
    expect(proxy.apiKeys).toEqual(before);
    expect((await db.sql`select count(*) as n from api_keys where person_id = 'ada-lovelace' and revoked_at is not null`)[0]!.n).toBe("0");
  });

  test("will not empty the proxy's key list unless forced", async () => {
    const saved = [...proxy.apiKeys!];
    const res0 = await cli(["keys", "add", "Solo"]);
    const solo = res0.stdout.trim();
    proxy.apiKeys = [solo];
    const refused = await cli(["keys", "revoke", "Solo", "--yes"]);
    expect(refused.code).toBe(2);
    // The refusal says what --force really does: it opens the proxy.
    expect(refused.stderr).toContain("accepts every request without a key");
    expect(refused.stderr).toContain("open to anyone");
    expect(proxy.apiKeys).toEqual([solo]);
    expect((await db.sql`select revoked_at from api_keys where key_hash = ${hashApiKey(solo)}`)[0]!.revoked_at).toBeNull();
    expect((await cli(["keys", "drop", hashApiKey(solo).slice(0, 10), "--yes"])).code).toBe(2);
    expect(proxy.apiKeys).toEqual([solo]);
    const forced = await cli(["keys", "revoke", "Solo", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain("WARNING: with no keys left the proxy now accepts every request without a key");
    expect(proxy.apiKeys).toEqual([]);
    proxy.apiKeys = saved;
  });

  test("renaming changes the display name and keeps the id", async () => {
    const res = await cli(["people", "rename", "ada-lovelace", "Countess Ada"]);
    expect(res.code).toBe(0);
    const [ada] = await db.sql`select id, name from people where id = 'ada-lovelace'`;
    expect(ada).toMatchObject({ id: "ada-lovelace", name: "Countess Ada" });
    // Found by the new name now; keys still attached.
    expect((await cli(["people", "rename", "countess ada", "Ada Lovelace"])).code).toBe(0);
    expect((await db.sql`select count(*) as n from api_keys where person_id = 'ada-lovelace'`)[0]!.n).not.toBe("0");
    // A name somebody else has is refused.
    expect((await cli(["people", "rename", "Ada Lovelace", "Margaret Hamilton"])).code).toBe(2);
    const list = await cli(["people", "list"]);
    expect(list.stdout).toContain("Ada Lovelace");
  });
});
