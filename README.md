![Slopboard: the leader's card, the week's total and the team's numbers](docs/slopboard.png)

Who burned the most tokens, on which model, in which thread, with how many
subagents, at what hour. A leaderboard for a handful of people sharing AI
coding subscriptions through one [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
proxy.

Everything is kept: one row per upstream request, queryable with SQL.

## How it works

```
 clients ──► CLIProxyAPI ──(in-memory usage queue)──┐
                 ▲                                  │ GET .../usage/queue   every 2 s
                 │ PUT .../access/api-keys          ▼
              key CLI ◄────────────────────────  slopboard ──► Postgres
                                                    │
                                 browser ◄── / , /api/board, /api/health, /api/sql
```

One Bun process (`src/server/main.ts`) does four things:

- **Collects.** Every couple of seconds it pops usage records from the proxy's
  management API and inserts them into `events`. The pop is destructive, so
  records popped while Postgres is down are held in memory (bounded) and
  written when it returns; while the buffer is full, polling stops and the
  records wait in the proxy, which keeps them for up to an hour. Inserts are
  keyed by the record's per-attempt id, so writing a record twice is harmless.
- **Prices.** Once a day it downloads LiteLLM's public price list. Cost is
  never stored: the `events_v` view computes "what this would have cost at
  public API prices" when you read it. A model with no confident price match
  has no cost at all, rather than a guessed one.
- **Serves the board.** `GET /api/board?range=today|7d|30d|all` returns
  everything the UI draws, awards and records included, cached for a few
  seconds. The types are in `src/shared/api.ts`; the UI is in `src/web`.
- **Answers SQL.** `POST /api/sql` runs a read-only query for anyone on the
  tailnet.

Each person has their own client API key. Slopboard stores only the SHA-256 of
a key, and attributes events to people through that hash at read time, so
giving a key an owner later moves all of its past usage to them. Traffic on a
key that belongs to nobody is the person `shared`.

## Deploy

1. **Proxy.** In the proxy's config (it hot-reloads, no restart):

   ```yaml
   management:
     secret-key: "<a management key>"   # empty disables the management API and the queue
     allow-remote: true                 # slopboard calls from another container, not from localhost
   observability:
     usage:
       usage-statistics-enabled: true            # off by default; nothing is queued without it
       redis-usage-queue-retention-seconds: 3600 # how long records wait for a collector; 3600 is the maximum
   ```

   Slopboard must be the **only consumer of the usage queue**. Reading it is
   destructive: whatever another reader takes (the management endpoint, or the
   `SUBSCRIBE usage` RESP channel on the same port), Slopboard never sees, and
   while a RESP subscriber is connected nothing is queued at all.

2. **Settings.** `cp .env.example deploy/.env` and fill it in. The file
   documents every variable; the ones you must set are the two database
   passwords (in `POSTGRES_PASSWORD`, `DATABASE_URL`, `DATABASE_RO_URL`),
   `PROXY_URL`, `PROXY_MANAGEMENT_KEY` and `BOARD_TZ`. It lives in `deploy/`,
   next to the compose file, and not in the repository root, where Bun (and so
   `bun test` and the dev server) would load it.

3. **Start.**

   ```bash
   docker compose -f deploy/compose.yaml up -d --build
   curl -s http://127.0.0.1:8318/api/health
   # {"ok":true,"db":true,"collectorLagSeconds":1,"events":0}
   ```

   The app joins the proxy's Docker network (`PROXY_NETWORK`, by default
   `cliproxyapi_default`) and reaches the proxy at `PROXY_URL`. It is published
   on `127.0.0.1:8318` unless `PUBLISH` says otherwise; put `tailscale serve`
   in front of it for the tailnet. Migrations run at every boot.

4. **Keys.** Give everyone a key (below). Until then all traffic shows up as
   `shared`.

`collectorLagSeconds` is the time since the proxy last answered a poll. If it
stays `null` or keeps growing, look at `docker compose -f deploy/compose.yaml logs app`.
After five wrong management keys the proxy bans the caller for 30 minutes, so
fix the key and wait rather than restarting in a loop.

## Configuration

Slopboard follows the [twelve-factor](https://12factor.net) rules, so one image
runs anywhere and nothing about a particular deployment is in this repository.

- **Config** is environment variables only, all read in `src/server/config.ts`
  and all listed in `.env.example`. There is no config file and no per-host
  value in the source: the people, their keys and the price overrides are rows
  in Postgres.
- **Backing services** are URLs: Postgres (`DATABASE_URL`, `DATABASE_RO_URL`),
  the proxy (`PROXY_URL`) and the price list (`PRICES_URL`).
- **State** lives in Postgres. The process keeps only caches and the short
  buffer of records it has popped and not yet written, which it flushes on
  `SIGTERM`. The container never writes to its filesystem.
- **One process**, listening on `PORT`. `COLLECTOR_ENABLED=false` gives one
  that serves the board without collecting; it reports no collector lag, so
  the board served by it shows the sync warning.
- **Logs** go to standard output and standard error.
- **Admin tasks** (keys, people, prices, migrations) run from the same image
  with the same environment: `bun run src/server/cli.ts`.

## Keys and people

```bash
alias slop='docker compose -f deploy/compose.yaml exec app bun run src/server/cli.ts'

slop keys add "Ada Lovelace"   # new key: registered with the proxy, printed once, never stored
slop keys list                 # every key by hash: owner, status, events, last seen
echo "$OLD_KEY" | docker compose -f deploy/compose.yaml exec -T app \
  bun run src/server/cli.ts keys assign "Ada Lovelace"   # label a key that already exists
slop keys revoke "Ada Lovelace"                 # shows her keys and their use; add --yes to do it
slop keys drop 3fa9c2d41b07 --yes               # remove one key from the proxy by its hash
slop people rename ada-lovelace "Countess Ada"  # display name only, the id stays
slop people list
```

What to know before touching keys:

- **A proxy with no client keys accepts every request.** So the first key
  ever added turns authentication on for everyone at once; `keys add` refuses
  to do that unless given `--first-key`. For the same reason `keys revoke` and
  `keys drop` refuse to remove the last key; `--force` overrides that and
  leaves the proxy open to anyone who can reach it.
- **`keys revoke <name>` removes every key assigned to that person**, including
  one that was only labelled with `keys assign`. If the old shared key was
  labelled as somebody's, revoking them cuts off everyone still using it. The
  command therefore lists the keys with their event counts and does nothing
  until run again with `--yes`. Their history stays theirs.
- `keys add` reads the proxy's key list, appends, and writes it back under
  `If-Match`, so keys added by anyone else in the meantime survive. If the
  write cannot be confirmed, the new key is taken out again; if even that
  fails, the command prints the key's hash and how to remove it (`keys drop`).
  `keys add`, `revoke` and `drop` print how many keys the proxy accepted before
  and after.
- `keys assign` takes the key on standard input so it does not end up in shell
  history or `ps`.
- **Every key change rewrites the proxy's `config.yaml`.** The proxy replaces
  the key list as a whole and saves the file again, so comments written next
  to individual keys are lost. Keep notes about who has which key in Slopboard
  (`keys list`), not in that file.

Prices that LiteLLM does not have (or names differently):

```bash
slop prices status                                      # each model seen and where its price comes from
slop prices alias my-proxy-model-id claude-opus-4-6     # price it like that LiteLLM id
slop prices unset my-proxy-model-id
slop prices refresh
```

Explicit prices go into `model_price_overrides` (USD per token):

```sql
insert into model_price_overrides (model, input_cost_per_token, output_cost_per_token, cache_read_cost_per_token)
values ('house-model', 3e-6, 15e-6, 0.3e-6);
```

## Querying

```bash
curl -s http://127.0.0.1:8318/api/sql -d '{"sql":
  "select person_id, requested_model, sum(total_tokens) as tokens, round(sum(cost_usd)::numeric, 2) as usd
   from events_v where ts > now() - interval ''7 days''
   group by 1, 2 order by tokens desc limit 20"}'
# {"columns":["person_id","requested_model","tokens","usd"],"rows":[["ada-lovelace","claude-opus-5-5","12345678","41.20"],...],
#  "rowCount":20,"truncated":false,"elapsedMs":12}
```

One query per request: `SELECT`, `WITH`, `VALUES` or `TABLE`, optionally under
`EXPLAIN`. No `$1` parameters. Limits, all configurable: 5 s statement timeout,
1000 rows, 4 MB of result; `truncated` says when rows were left out. `bigint`
and `numeric` come back as strings.

There is no login in front of this, so it is built to be safe for anyone who
can reach it:

- it runs as a Postgres role that can only `SELECT`, cannot create temporary
  tables and cannot take advisory locks;
- every request gets a connection of its own, closed afterwards, so nothing a
  query sets or locks is there for the next one;
- the query is sent as a single prepared statement inside a read-only
  transaction, so Postgres itself refuses a second statement;
- rows and bytes are counted inside Postgres, so an oversized result never
  reaches the Slopboard process.

What it does expose, to everyone on the tailnet, is the data: client IPs, user
agents, and the account names of the upstream subscriptions.

## Schema in brief

| Relation | What it holds |
| --- | --- |
| `events` | One row per upstream attempt. Extracted columns plus `raw`, the whole record without the plaintext key. |
| `events_v` | **Query this.** `events` plus `person_id`, `person_name`, `unassigned`, `price_source`, `cost_usd`. |
| `threads_v` | One row per thread: owner, start, end, tokens, cost, subagents, model. |
| `people`, `api_keys` | Who exists, and which key hash is whose (`revoked_at` set once revoked). |
| `sessions` | Session tree: `session_id`, `parent_session_id`, `thread_id` (its root). |
| `model_prices` | LiteLLM's price list. |
| `model_price_overrides` | Manual aliases and prices. |
| `model_pricing` | The price each model resolves to, and how (`manual`, `alias`, `exact`, `provider-prefix`, or null for unpriced). |
| `models`, `meta` | Models seen; small bits of state. |

Columns of `events` you will reach for: `ts`, `key_hash`, `model` (what ran
upstream), `alias` (what the client asked for), `requested_model` (`alias`
without a `(high)`-style suffix), `provider`, `session_id`,
`parent_session_id`, `thread_id`, `is_subagent`, `is_fork`, `is_compaction`,
`trace_id`, `failed`, `status_code`, `latency_ms`, `ttft_ms`, `client_ip`,
`user_agent`, and the token columns below.

### What the proxy sends, and how it is read

**Token accounting.** Providers disagree about what includes what. Anthropic
reports cache reads and writes beside `input_tokens` and counts thinking inside
`output_tokens`; OpenAI and Codex count cached tokens inside `input_tokens` and
reasoning inside `output_tokens`; Gemini counts cached tokens inside the prompt
count and reports thoughts beside the candidates. The record's flat `tokens`
object carries those provider-shaped numbers, so adding its fields double
counts. Slopboard reads the record's `token_breakdown` instead, which the proxy
has already normalised into buckets that do not overlap:

| Column | Meaning |
| --- | --- |
| `input_tokens` | input neither read from nor written to the cache |
| `cache_read_tokens` | input read from the cache |
| `cache_write_tokens` | input written to the cache (`cache_write_1h_tokens`: the part with the 1 h TTL) |
| `output_tokens` | output, reasoning included |
| `reasoning_tokens` | the part of `output_tokens` that was reasoning |
| `unclassified_tokens` | tokens the proxy could not assign to a bucket (unknown provider) |
| `total_tokens` | the sum of the above except `reasoning_tokens` |

Unclassified tokens are counted (the board shows them as input) but never
priced: an event that has any gets no cost.

**Requests.** A row is one upstream *attempt*. All attempts of one inbound
request share a `trace_id`, and so do all turns sent over one Codex websocket
connection. So "requests" is: successful attempts, plus traces in which no
attempt succeeded.

```sql
count(*) filter (where not failed)
  + count(distinct trace_id) - count(distinct trace_id) filter (where not failed)   -- requests
count(distinct trace_id) - count(distinct trace_id) filter (where not failed)       -- failed requests
```

**Sessions.** `session_id` and `parent_session_id` are UUIDs made by the proxy:
a client's own session UUID when it sends one, otherwise a hash. A subagent has
its own session whose parent is the session that spawned it, usually the main
conversation, sometimes another subagent. `thread_id` is the root of that tree,
kept up to date as records arrive in any order. `is_subagent` is "has a parent,
and the link is not just a fork or a compaction of the same conversation".

**Cost.** `input`, `cache read`, `cache write` (5 min and 1 h) and `output` are
each priced at their own LiteLLM rate, falling back to the input rate where
LiteLLM lists none for the cache. LiteLLM's `fast` multiplier applies to
responses the proxy marks `speed = fast`. Not modelled: long-context tiers
(above 200k/272k tokens), priority and flex tiers, batch discounts, per-image
and per-search charges.

## Development

```bash
bun install
export DATABASE_URL=postgres://...       # any Postgres 17
# plus PROXY_URL and PROXY_MANAGEMENT_KEY to collect from a real proxy
bun run src/server/seed.ts               # a few weeks of invented usage (--reset to redo)
COLLECTOR_ENABLED=false bun run dev      # http://localhost:8318
bun run typecheck
bun test                                 # needs Docker: starts and removes a postgres:17 container
```

The tests never talk to a real proxy; `src/server/test/fake-proxy.ts` stands in
for its two management endpoints.

| File | Role |
| --- | --- |
| `src/shared/api.ts` | The contract between server and UI. |
| `src/server/main.ts` | Entry point: migrations, collector, price refresh, HTTP. |
| `src/server/collector.ts` | Poll loop, back-off, the in-memory buffer. |
| `src/server/ingest.ts` | Proxy record to `events` row; insert; thread resolution. |
| `src/server/proxy.ts` | Client for the proxy's management API. |
| `src/server/board.ts`, `awards.ts`, `format.ts` | The board, its awards and records, their wording. |
| `src/server/prices.ts` | LiteLLM price list. |
| `src/server/sqlapi.ts` | `POST /api/sql`. |
| `src/server/http.ts` | Routes. |
| `src/server/keys.ts`, `cli.ts` | People, keys, the admin CLI. |
| `src/server/db.ts` | Connections, migrations, the read-only role. |
| `src/server/seed.ts`, `synthetic.ts` | Synthetic data. |
| `src/server/migrations/` | SQL, applied in order at boot. Never edit one that has run; add the next number. |
