#!/usr/bin/env bun
// Admin CLI: people, their API keys, and prices.
//
//   bun run src/server/cli.ts keys add <name>
//   docker compose -f deploy/compose.yaml exec app bun run src/server/cli.ts keys list

import { loadConfig } from "./config.ts";
import { connect, migrate, type Db } from "./db.ts";
import {
  addKey,
  assignKey,
  dropProxyKey,
  listKeys,
  OrphanedKeyError,
  proxyKeysByHash,
  renamePerson,
  revocableKeys,
  revokeKeys,
  UsageError,
} from "./keys.ts";
import { refreshPrices } from "./prices.ts";
import { ProxyClient, ProxyError } from "./proxy.ts";
import {
  deleteSubscription,
  listSubscriptions,
  recomputeSubscriptionCosts,
  setSubscriptionIgnored,
  syncQuotaHistory,
  upsertSubscription,
} from "./subscriptions.ts";

const USAGE = `slopboard admin

  keys add <name>            Create a key for <name>, register it with the proxy, print it once.
                             --first-key is needed when the proxy has no keys yet: a proxy
                             without keys accepts everyone, and the first key ends that.
  keys list                  Show every key by hash: owner, status, usage.
  keys revoke <name>         Remove all of <name>'s keys from the proxy. Past usage stays theirs.
                             Shows the keys and stops, unless given --yes.
  keys drop <hash>           Remove one key from the proxy by the start of its SHA-256
                             (as shown by keys list), whoever owns it. Needs --yes.
  keys assign <name>         Label an existing key as <name>'s. The key is read from
                             standard input, never from the command line.
  people list                Show everyone.
  people rename <name> <new> Change a display name. The id stays the same.
  prices refresh             Download LiteLLM's price list now.
  prices status              Show each model seen and where its price comes from.
  prices alias <model> <id>  Price <model> like LiteLLM's <id>.
  prices unset <model>       Remove a manual alias or price.
  subscriptions list         Show every upstream subscription account, cycle rate and real spend.
  subscriptions set <provider> <account> --cost <usd> [--billing-day <1-31>] [--plan <plan>] [--note <text>]
                             Set monthly cost and billing day for an account, then recompute.
  subscriptions ignore <provider> <account>
                             Exclude an account from real spend ($0) and recompute.
  subscriptions unignore <provider> <account>
                             Include an ignored account in real spend again and recompute.
  subscriptions delete <provider> <account>
                             Remove an explicit subscription entry (falls back to plan defaults).
  subscriptions sync         Pull quota history from the proxy and recompute real spend now.
  subscriptions recompute    Recompute real spend from stored quota history and events.

revoke and drop refuse to remove the proxy's last key. --force overrides that,
and leaves the proxy accepting every request without a key.

<name> is a display name ("Ada Lovelace") or an id ("ada-lovelace"). People are
created the first time they are named.

Environment: DATABASE_URL, PROXY_URL, PROXY_MANAGEMENT_KEY (see .env.example).`;

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);

function table(headers: string[], rows: string[][], print: (line: string) => void = out): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  print(line(headers));
  print(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) print(line(r));
}

const plural = (n: number) => `${n} key${n === 1 ? "" : "s"}`;

function reportProxyKeys(before: number, after: number): void {
  err(`The proxy accepted ${plural(before)} before and accepts ${plural(after)} now.`);
  if (after === 0) err("WARNING: with no keys left the proxy now accepts every request without a key.");
}

function when(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace("T", " ") + "Z" : "-";
}

/** First line of standard input, without the line ending. */
async function readSecretLine(): Promise<string> {
  if (process.stdin.isTTY) err("Paste the key and press Enter:");
  for await (const line of console) return line;
  return "";
}

function needArgs(args: string[], n: number, usage: string): void {
  if (args.length !== n) throw new UsageError(`usage: ${usage}`);
}

const VALUE_OPTIONS = new Set(["--cost", "--billing-day", "--plan", "--note"]);

function parseArgv(argv: string[]): { flags: Set<string>; options: Map<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        options.set(a.slice(0, eq), a.slice(eq + 1));
      } else if (VALUE_OPTIONS.has(a)) {
        const val = argv[i + 1];
        if (val === undefined) throw new UsageError(`${a} requires a value`);
        options.set(a, val);
        i++;
      } else {
        flags.add(a);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, options, positional };
}

async function run(argv: string[]): Promise<number> {
  const { flags, options, positional } = parseArgv(argv);
  const [group, action, ...args] = positional;
  if (!group || flags.has("--help") || group === "help") {
    out(USAGE);
    return group || flags.has("--help") ? 0 : 2;
  }

  const config = loadConfig();
  const sql: Db = connect(config.databaseUrl, 2);
  const proxy = () => {
    if (!config.proxyUrl) throw new UsageError("PROXY_URL is not set");
    if (!config.proxyManagementKey) throw new UsageError("PROXY_MANAGEMENT_KEY is not set");
    return new ProxyClient(config.proxyUrl, config.proxyManagementKey);
  };

  try {
    await migrate(sql);
    switch (`${group} ${action ?? ""}`.trim()) {
      case "keys add": {
        needArgs(args, 1, "keys add <name> [--first-key]");
        const added = await addKey(sql, proxy(), args[0]!, { allowFirstKey: flags.has("--first-key") });
        err(`Key for ${added.person.name} (${added.person.id}).`);
        err(`The proxy accepted ${plural(added.proxyKeysBefore)} before and accepts ${plural(added.proxyKeysAfter)} now.`);
        if (added.proxyKeysBefore === 0) err(`It had none, so until now it accepted everyone. From now on a key is required.`);
        err("This is the only time the key is shown; Slopboard keeps just its hash.");
        out(added.key);
        return 0;
      }
      case "keys list": {
        needArgs(args, 0, "keys list");
        const { keys, proxyError } = await listKeys(sql, config.proxyManagementKey ? proxy() : null);
        if (proxyError) err(`Could not ask the proxy, statuses are unknown: ${proxyError}`);
        table(
          ["PERSON", "ID", "KEY SHA-256", "STATUS", "EVENTS", "LAST SEEN", "CREATED", "NOTE"],
          keys.map((k) => [
            k.personName ?? "(nobody)",
            k.personId ?? "shared",
            k.keyHash.slice(0, 12),
            k.status,
            String(k.events),
            when(k.lastSeenAt),
            when(k.createdAt),
            k.label ?? "",
          ]),
        );
        const loose = keys.filter((k) => k.status === "unassigned").length;
        if (loose > 0) {
          err(`\n${loose} key(s) accepted by the proxy belong to nobody; their traffic counts as "shared".`);
          err('Label one with: keys assign <name>  (key on standard input)');
        }
        return 0;
      }
      case "keys revoke": {
        needArgs(args, 1, "keys revoke <name> [--yes] [--force]");
        const { person, keys } = await revocableKeys(sql, args[0]!);
        if (keys.length === 0) throw new UsageError(`${person.name} has no active keys`);
        // Show what is about to be cut off: a key labelled with `keys assign`
        // may be one that other people still use.
        err(`Active keys of ${person.name} (${person.id}):`);
        table(
          ["KEY SHA-256", "EVENTS", "LAST SEEN", "NOTE"],
          keys.map((k) => [k.keyHash.slice(0, 12), String(k.events), when(k.lastSeenAt), k.label ?? ""]),
          err,
        );
        if (!flags.has("--yes")) {
          err(`\nNothing was changed. Everyone using ${keys.length === 1 ? "this key" : "one of these keys"} loses access when it is revoked.`);
          err("Run again with --yes to revoke all of the above.");
          return 2;
        }
        const res = await revokeKeys(sql, proxy(), args[0]!, flags.has("--force"));
        out(`Revoked ${plural(res.revoked)} of ${person.name}; ${res.removedFromProxy.length} removed from the proxy.`);
        reportProxyKeys(res.proxyKeysBefore, res.proxyKeysAfter);
        return 0;
      }
      case "keys drop": {
        needArgs(args, 1, "keys drop <start of the key's SHA-256> [--yes] [--force]");
        const client = proxy();
        const hashes = await proxyKeysByHash(client, args[0]!);
        if (hashes.length !== 1) {
          throw new UsageError(hashes.length === 0 ? `the proxy has no key whose SHA-256 starts with ${args[0]}` : `${hashes.length} proxy keys start with ${args[0]}; give more digits`);
        }
        const owner: Record<string, unknown>[] = await sql`
          select p.name, (select count(*) from events e where e.key_hash = ${hashes[0]!}) as events
          from (select 1) one left join api_keys k on k.key_hash = ${hashes[0]!} left join people p on p.id = k.person_id`;
        err(`Key ${hashes[0]!.slice(0, 12)}: owner ${owner[0]?.name ?? "nobody"}, ${owner[0]?.events ?? 0} events.`);
        if (!flags.has("--yes")) {
          err("Nothing was changed. Everyone using this key loses access when it is removed. Run again with --yes.");
          return 2;
        }
        const res = await dropProxyKey(sql, client, hashes[0]!, flags.has("--force"));
        out(`Removed key ${hashes[0]!.slice(0, 12)} from the proxy.`);
        reportProxyKeys(res.proxyKeysBefore, res.proxyKeysAfter);
        return 0;
      }
      case "keys assign": {
        needArgs(args, 1, "keys assign <name>   (key on standard input)");
        const key = await readSecretLine();
        const res = await assignKey(sql, config.proxyManagementKey ? proxy() : null, args[0]!, key);
        out(`Key ${res.keyHash.slice(0, 12)} now belongs to ${res.person.name} (${res.person.id}).`);
        if (res.previousPersonId) out(`It used to belong to ${res.previousPersonId}; its past usage moved too.`);
        if (res.knownToProxy === false) err("Note: the proxy does not accept this key at the moment.");
        return 0;
      }
      case "people list": {
        needArgs(args, 0, "people list");
        const rows: Record<string, unknown>[] = await sql`
          select p.id, p.name, count(k.key_hash) filter (where k.revoked_at is null) as active,
                 count(k.key_hash) as total
          from people p left join api_keys k on k.person_id = p.id
          group by p.id order by p.name`;
        table(["NAME", "ID", "ACTIVE KEYS", "ALL KEYS"], rows.map((r) => [String(r.name), String(r.id), String(r.active), String(r.total)]));
        return 0;
      }
      case "people rename": {
        needArgs(args, 2, "people rename <name> <new name>");
        const person = await renamePerson(sql, args[0]!, args[1]!);
        out(`${person.id} is now called ${person.name}.`);
        return 0;
      }
      case "prices refresh": {
        needArgs(args, 0, "prices refresh");
        const res = await refreshPrices(sql, config.pricesUrl);
        out(`Loaded ${res.models} models from LiteLLM, ${res.changed} new or changed.`);
        return 0;
      }
      case "prices status": {
        needArgs(args, 0, "prices status");
        const rows: Record<string, unknown>[] = await sql`
          select mp.model, mp.provider, coalesce(mp.price_source, 'UNPRICED') as source, coalesce(mp.litellm_id, '') as litellm_id,
                 (mp.input_cost * 1e6)::float8 as input, (mp.output_cost * 1e6)::float8 as output,
                 (mp.cache_read_cost * 1e6)::float8 as cache_read, (mp.cache_write_cost * 1e6)::float8 as cache_write
          from model_pricing mp order by (mp.price_source is null) desc, mp.model`;
        const usd = (v: unknown) => (v === null || v === undefined ? "-" : `$${Number(v).toFixed(3).replace(/\.?0+$/, "")}`);
        table(
          ["MODEL", "PROVIDER", "PRICE FROM", "LITELLM ID", "IN/M", "OUT/M", "CACHE READ/M", "CACHE WRITE/M"],
          rows.map((r) => [String(r.model), String(r.provider), String(r.source), String(r.litellm_id), usd(r.input), usd(r.output), usd(r.cache_read), usd(r.cache_write)]),
        );
        return 0;
      }
      case "prices alias": {
        needArgs(args, 2, "prices alias <model> <litellm id>");
        const id = args[1]!.toLowerCase();
        const known = await sql`
          select 1 from model_prices
          where id = ${id} and input_cost_per_token is not null and output_cost_per_token is not null`;
        if (known.length === 0) throw new UsageError(`LiteLLM has no token prices for "${id}" (try: prices refresh)`);
        await sql`
          insert into model_price_overrides (model, litellm_id) values (${args[0]!}, ${id})
          on conflict (model) do update set litellm_id = excluded.litellm_id, input_cost_per_token = null,
            output_cost_per_token = null, cache_read_cost_per_token = null, cache_write_cost_per_token = null,
            cache_write_1h_cost_per_token = null, updated_at = now()`;
        out(`${args[0]} is now priced like ${id}.`);
        return 0;
      }
      case "prices unset": {
        needArgs(args, 1, "prices unset <model>");
        const gone = await sql`delete from model_price_overrides where model = ${args[0]!} returning model`;
        out(gone.length > 0 ? `Removed the override for ${args[0]}.` : `There was no override for ${args[0]}.`);
        return 0;
      }
      case "subscriptions list": {
        needArgs(args, 0, "subscriptions list");
        const rows = await listSubscriptions(sql);
        const fmtMoney = (v: number | null) => (v === null ? "-" : `$${v.toFixed(2)}`);
        table(
          ["PROVIDER", "ACCOUNT", "PLAN", "COST/MO", "BILL DAY", "CYCLE WKS", "$/WEEK", "EVENTS", "REAL SPEND", "STATUS"],
          rows.map((r) => [
            r.provider,
            r.source,
            r.plan ?? "-",
            fmtMoney(r.monthlyCostUsd),
            r.billingDay !== null ? String(r.billingDay) : "1*",
            r.currentCycle ? r.currentCycle.effectiveWeeks.toFixed(2) : "-",
            r.currentCycle ? fmtMoney(r.currentCycle.costPerWeek) : "-",
            String(r.events),
            fmtMoney(r.subCostUsd),
            r.ignored ? "ignored" : r.configured ? "configured" : r.monthlyCostUsd !== null ? "auto" : "unpriced",
          ]),
        );
        return 0;
      }
      case "subscriptions set": {
        needArgs(args, 2, "subscriptions set <provider> <account> --cost <usd> [--billing-day <1-31>] [--plan <plan>] [--note <text>]");
        const costRaw = options.get("--cost");
        const billRaw = options.get("--billing-day");
        const planRaw = options.get("--plan");
        if (costRaw === undefined && billRaw === undefined && planRaw === undefined) {
          throw new UsageError("provide at least one of --cost <usd>, --billing-day <1-31>, or --plan <name>");
        }
        let monthlyCostUsd: number | null = null;
        if (costRaw !== undefined) {
          monthlyCostUsd = Number(costRaw);
          if (!Number.isFinite(monthlyCostUsd) || monthlyCostUsd < 0) {
            throw new UsageError(`--cost must be a non-negative number, got "${costRaw}"`);
          }
        }
        let billingDay: number | null | undefined = undefined;
        if (billRaw !== undefined) {
          const d = Number(billRaw);
          if (!Number.isInteger(d) || d < 1 || d > 31) {
            throw new UsageError(`--billing-day must be an integer 1..31, got "${billRaw}"`);
          }
          billingDay = d;
        }
        const sub = await upsertSubscription(sql, {
          provider: args[0]!,
          source: args[1]!,
          monthlyCostUsd,
          billingDay,
          plan: planRaw,
          note: options.get("--note"),
          ignored: false,
        });
        const res = await recomputeSubscriptionCosts(sql);
        const costLabel = sub.monthly_cost_usd !== null ? `$${sub.monthly_cost_usd.toFixed(2)}/mo` : "auto plan default";
        out(
          `Saved ${sub.provider} ${sub.source}: ${costLabel}` +
            (sub.billing_day ? `, billing day ${sub.billing_day}` : "") +
            `. Recomputed ${res.eventsUpdated} event(s).`,
        );
        return 0;
      }
      case "subscriptions ignore": {
        needArgs(args, 2, "subscriptions ignore <provider> <account>");
        const sub = await setSubscriptionIgnored(sql, args[0]!, args[1]!, true);
        const res = await recomputeSubscriptionCosts(sql);
        out(`Ignored ${sub.provider} ${sub.source} ($0 spend). Recomputed ${res.eventsUpdated} event(s).`);
        return 0;
      }
      case "subscriptions unignore": {
        needArgs(args, 2, "subscriptions unignore <provider> <account>");
        const sub = await setSubscriptionIgnored(sql, args[0]!, args[1]!, false);
        const res = await recomputeSubscriptionCosts(sql);
        const label = sub.monthly_cost_usd !== null ? `$${sub.monthly_cost_usd.toFixed(2)}/mo` : "auto plan default";
        out(`Included ${sub.provider} ${sub.source} (${label}). Recomputed ${res.eventsUpdated} event(s).`);
        return 0;
      }
      case "subscriptions delete": {
        needArgs(args, 2, "subscriptions delete <provider> <account>");
        const gone = await deleteSubscription(sql, args[0]!, args[1]!);
        const res = await recomputeSubscriptionCosts(sql);
        out(
          (gone ? `Removed explicit subscription for ${args[0]} ${args[1]}.` : `No explicit subscription for ${args[0]} ${args[1]}.`) +
            ` Recomputed ${res.eventsUpdated} event(s).`,
        );
        return 0;
      }
      case "subscriptions sync": {
        needArgs(args, 0, "subscriptions sync");
        const synced = await syncQuotaHistory(sql, proxy());
        const res = await recomputeSubscriptionCosts(sql);
        if (!synced.enabled) {
          out(`Proxy quota history is disabled. Recomputed ${res.eventsUpdated} event(s) from stored data.`);
        } else {
          out(
            `Synced ${synced.samplesStored} quota samples across ${synced.accounts} accounts. Recomputed ${res.eventsUpdated} / ${res.eventsChecked} event(s).`,
          );
        }
        return 0;
      }
      case "subscriptions recompute": {
        needArgs(args, 0, "subscriptions recompute");
        const res = await recomputeSubscriptionCosts(sql);
        out(`Recomputed ${res.eventsUpdated} / ${res.eventsChecked} event(s) across ${res.accounts} accounts.`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${[group, action].filter(Boolean).join(" ")}"\n\n${USAGE}`);
    }
  } finally {
    await sql.close({ timeout: 2 }).catch(() => {});
  }
}

try {
  process.exit(await run(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    err(error.message);
    process.exit(2);
  }
  if (error instanceof OrphanedKeyError) {
    err(`error: ${error.message}`);
    err(`The new key could not be removed from the proxy again either: ${error.cleanupError.message}`);
    err(`The proxy may now accept a key that nobody holds. Its SHA-256 is ${error.keyHash}.`);
    err(`It must be removed by hand: run "keys drop ${error.keyHash.slice(0, 12)} --yes" once the proxy answers, or check keys list.`);
    process.exit(1);
  }
  if (error instanceof ProxyError) {
    err(`proxy: ${error.message}`);
    if (error.isAuth) err("Check PROXY_MANAGEMENT_KEY, and that the proxy allows remote management from this address.");
    process.exit(1);
  }
  err(`error: ${(error as Error).message ?? error}`);
  process.exit(1);
}
