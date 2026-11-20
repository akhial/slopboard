![Slopboard: the leader's card, the week's total and the team's numbers](docs/board.png)

Slopboard is a usage leaderboard for a small team sharing AI coding subscriptions through one [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) proxy.

It tracks who used the most tokens (the small chunks of text AI models read and write), on which model, in which conversation thread, with how many subagents (helper sessions started by a main session), and at what time of day.

Every attempt sent to an AI provider is saved as its own database row, and you can query all of it with SQL (the standard language for searching databases).

## How it works

```
 clients ──► CLIProxyAPI ──(in-memory usage queue)──┐
                 ▲                                  │ GET .../usage/queue   every 2 s
                 │ PUT .../access/api-keys          ▼
              key CLI ◄────────────────────────  slopboard ──► Postgres
                                                    │
                                 browser ◄── / , /api/board, /api/health, /api/sql
```

One Bun process (`src/server/main.ts`) does four jobs:

- **Collects usage.** Every two seconds (by default), it pulls usage records from the proxy's management API and saves them in Postgres in the `events` table. Pulling a record deletes it from the proxy's queue. If Postgres is down, records already pulled are held in a size-limited memory buffer and written once Postgres comes back. If that buffer fills up, Slopboard stops pulling and leaves new records in the proxy, which holds them for up to an hour. Each record has a unique per-attempt ID, so saving the same record twice is harmless.
- **Updates prices.** Once a day, it downloads LiteLLM's public list of model prices. Dollar costs are never stored on individual rows. Instead, the `events_v` database view calculates what each request would have cost at public API prices whenever you read it. If a model cannot be matched confidently to a price, it gets no cost rather than a guessed one.
- **Serves the leaderboard.** `GET /api/board?range=today|7d|30d|all` returns everything the web page draws — awards and records included — cached for a few seconds. The shared TypeScript types are in `src/shared/api.ts`, and the web UI is in `src/web`.
- **Answers SQL queries.** `POST /api/sql` runs read-only SQL queries for anyone who can reach the server (such as everyone on your tailnet, a private Tailscale network).

### Matching usage to people

Each person uses their own client API key. Slopboard never stores the plain key — only its SHA-256 hash (a one-way fingerprint that cannot be turned back into the key).

Events are matched to people using that hash when you read the data, not when the event is saved. That means if you assign an existing key to someone later, all of its past usage moves to them automatically. Any traffic from a key with no owner shows up under the name `shared`.

## Deploying Slopboard

1. **Configure the proxy.** Add these settings to CLIProxyAPI's config file (the proxy reloads changes on its own, so no restart is needed):

   ```yaml
   management:
     secret-key: "<a management key>"   # empty disables the management API and the queue
     allow-remote: true                 # slopboard calls from another container, not from localhost
   observability:
     usage:
       usage-statistics-enabled: true            # off by default; nothing is queued without it
       redis-usage-queue-retention-seconds: 3600 # how long records wait for a collector; 3600 is the maximum
   ```

   > **Important:** Slopboard must be the **only reader of the usage queue**. Reading the queue is destructive: once a record is read, it is removed. Anything taken by another reader — whether through the management API endpoint or the `SUBSCRIBE usage` RESP (Redis-protocol) channel on the same port — is gone before Slopboard ever sees it. While any RESP subscriber is connected, the proxy stops putting records into the queue altogether.

2. **Create `deploy/.env`.** Copy the template and fill it in: `cp .env.example deploy/.env`. Every setting is explained inside `.env.example`. The ones you must fill in are:

   - The two database passwords, used in `POSTGRES_PASSWORD`, `DATABASE_URL`, and `DATABASE_RO_URL` (use a different password for the read-only URL).
   - `PROXY_URL` and `PROXY_MANAGEMENT_KEY`.
   - `BOARD_TZ` (your IANA time zone, which decides what "today", a day, and an hour mean on the board).

   Keep this file in `deploy/.env`, next to `deploy/compose.yaml` — **not** in the repository root. Bun automatically loads a `.env` file from the project root, which would hand your production secrets to `bun test` and the local dev server.

3. **Start the containers.**

   ```bash
   docker compose -f deploy/compose.yaml up -d --build
   curl -s http://127.0.0.1:8318/api/health
   # {"ok":true,"db":true,"collectorLagSeconds":1,"events":0}
   ```

   Slopboard joins the proxy's Docker network (`PROXY_NETWORK`, which defaults to `cliproxyapi_default`) so it can reach the proxy at `PROXY_URL`. By default, it only binds to your local machine on `127.0.0.1:8318` unless `PUBLISH` sets another address or port. Put `tailscale serve` (or a similar private reverse proxy) in front of it to share it on your tailnet. Database migrations (schema updates) run automatically on every startup.

4. **Hand out keys.** Give each person their own API key (see [Managing keys and people](#managing-keys-and-people)). Until you do, all usage shows up as `shared`.

### Checking that collection is working

In the `/api/health` response, `collectorLagSeconds` is how many seconds ago the proxy last answered a poll. If it stays `null` or keeps growing, inspect the app logs:

`docker compose -f deploy/compose.yaml logs app`

After five wrong management keys, the proxy bans the caller for 30 minutes. Fix `PROXY_MANAGEMENT_KEY` and wait rather than restarting in a loop.

## Configuration

Slopboard follows the [twelve-factor](https://12factor.net) design rules. The same container image runs anywhere, and nothing specific to one deployment is stored in this repository.

- **Environment variables only.** Every setting is read in `src/server/config.ts` and listed with its default in `.env.example`. There is no config file and no per-host setting in the code. People, key hashes, and price overrides are stored in Postgres.
- **External services are URLs.** Postgres (`DATABASE_URL`, `DATABASE_RO_URL`), the proxy (`PROXY_URL`), and the price list (`PRICES_URL`) are all configured as URLs.
- **State lives in Postgres.** The running process holds only short caches and the bounded in-memory buffer of records pulled from the proxy that have not been written yet. On `SIGTERM` (a normal shutdown), it flushes that buffer to Postgres before exiting. The container never writes to its own filesystem.
- **One process on `PORT`.** A single process serves everything on `PORT` (default `8318`). Setting `COLLECTOR_ENABLED=false` runs an instance that serves the board without pulling from the proxy. Because it does not collect, it reports no collector lag (`null`), and the board displays a sync warning.
- **Logs** go to standard output and standard error.
- **Admin tasks** (keys, people, prices, migrations) run from the same container image with the same environment variables using `bun run src/server/cli.ts`.

## Managing keys and people

Define a short shell alias to run the admin CLI inside the Docker container:

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

### Important rules before changing keys

- **The first key turns authentication on for everyone.** A proxy with no client keys accepts every request without a key. Adding the first key turns authentication on for everyone at once, locking out anyone who does not have a key. Because of this, `keys add` refuses to add the first key unless you pass `--first-key`. For the same reason, `keys revoke` and `keys drop` refuse to remove the last key on the proxy; passing `--force` overrides that check and leaves the proxy open to anyone who can reach it.
- **Revoking a person removes every key assigned to them.** `keys revoke <name>` removes all active keys belonging to that person, including any key you only labelled with `keys assign`. If an old shared key was labelled as somebody's, revoking them cuts off everyone still using that key. To prevent accidents, `keys revoke` first lists the keys with their event counts and changes nothing until you run it again with `--yes`. Their past usage stays under their name.
- **Concurrent edits and failed writes are handled safely.** `keys add` reads the proxy's current key list, appends the new key, and writes it back using an HTTP `If-Match` check so keys added by anyone else in the meantime are not overwritten. If the write cannot be confirmed, Slopboard removes the new key again. If even that cleanup fails, the command prints the key's hash and how to remove it with `keys drop`. `keys add`, `keys revoke`, and `keys drop` all print how many keys the proxy accepted before and after the change.
- **Keys stay out of shell history.** `keys assign` reads the key from standard input (`stdin`) instead of a command-line argument so it does not end up in shell history or `ps` (the process list).
- **Comments in the proxy's `config.yaml` will be lost.** Every key change replaces the entire key list and rewrites the proxy's `config.yaml`, which wipes out comments written next to individual keys. Keep notes about who owns which key in Slopboard (`keys list`), not in `config.yaml`.

## Model prices

Slopboard refreshes LiteLLM's public price list once a day. For models that LiteLLM does not list — or lists under a different name — you can check status, point a model at a LiteLLM name, or trigger a manual refresh:

```bash
slop prices status                                      # each model seen and where its price comes from
slop prices alias my-proxy-model-id claude-opus-4-6     # price it like that LiteLLM id
slop prices unset my-proxy-model-id
slop prices refresh
```

To set explicit custom prices (in USD per token), insert a row into `model_price_overrides`:

```sql
insert into model_price_overrides (model, input_cost_per_token, output_cost_per_token, cache_read_cost_per_token)
values ('house-model', 3e-6, 15e-6, 0.3e-6);
```

### How costs are calculated

- Input tokens, cache reads, cache writes (both 5-minute and 1-hour), and output tokens are each priced at their own LiteLLM rate. If LiteLLM does not list a cache rate for a model, Slopboard falls back to that model's input rate.
- When the proxy marks a response `speed = fast`, LiteLLM's `fast` multiplier is applied.
- A model with no confident price match — or any event that contains unclassified tokens — gets no cost (`null`), rather than a guessed number.
- **Not modelled:** long-context pricing tiers (above 200k/272k tokens), priority and flex tiers, batch discounts, and per-image or per-search charges.

## Querying with SQL

Anyone who can reach the server can run read-only SQL queries through `POST /api/sql` (leave `DATABASE_RO_URL` empty to turn this endpoint off):

```bash
curl -s http://127.0.0.1:8318/api/sql -d '{"sql":
  "select person_id, requested_model, sum(total_tokens) as tokens, round(sum(cost_usd)::numeric, 2) as usd
   from events_v where ts > now() - interval ''7 days''
   group by 1, 2 order by tokens desc limit 20"}'
# {"columns":["person_id","requested_model","tokens","usd"],"rows":[["ada-lovelace","claude-opus-5-5","12345678","41.20"],...],
#  "rowCount":20,"truncated":false,"elapsedMs":12}
```

Rules and limits:

- **One query per request:** `SELECT`, `WITH`, `VALUES`, or `TABLE`, optionally prefixed with `EXPLAIN`.
- **No query parameters:** placeholders like `$1` are not supported.
- **Default limits** (all configurable via environment variables): 5-second statement timeout (`SQL_TIMEOUT_MS`), 1,000 rows (`SQL_MAX_ROWS`), and 4 MB of result data (`SQL_MAX_BYTES`). The `truncated` field tells you when rows were left out.
- **Large numbers:** Postgres `bigint` and `numeric` values come back as strings so precision is not lost.

There is no login in front of `POST /api/sql`; see [Security notes](#security-notes) for how queries are sandboxed and what data this endpoint exposes.

## The data model

### Tables and views

| Table or view | What it holds |
| --- | --- |
| `events` | One row per attempt sent to an AI provider. Holds extracted columns plus `raw`, the full record from the proxy with the plaintext key removed. |
| `events_v` | **Query this one.** `events` joined with `person_id`, `person_name`, `unassigned`, `price_source`, and `cost_usd`. |
| `threads_v` | One row per conversation thread: owner, start time, end time, tokens, cost, subagents, and model. |
| `people`, `api_keys` | People and which key hash belongs to whom (`revoked_at` is filled in once a key is revoked). |
| `sessions` | Session tree: `session_id`, `parent_session_id`, and `thread_id` (the root session of the tree). |
| `model_prices` | LiteLLM's downloaded price list. |
| `model_price_overrides` | Manual model aliases and custom per-token prices. |
| `model_pricing` | The price each model resolves to, and where it came from (`manual`, `alias`, `exact`, `provider-prefix`, or `null` if unpriced). |
| `models`, `meta` | Every model seen so far, plus small pieces of internal state. |

### Useful columns on `events`

The columns you will reach for most often are:

- **When and who:** `ts` (timestamp), `key_hash`, `client_ip`, `user_agent`
- **Model and provider:** `model` (what actually ran upstream), `alias` (what the client asked for), `requested_model` (`alias` without a `(high)`-style thinking suffix), `provider`
- **Threads and sessions:** `session_id`, `parent_session_id`, `thread_id`, `is_subagent`, `is_fork`, `is_compaction`
- **Status and timing:** `trace_id`, `failed`, `status_code`, `latency_ms`, `ttft_ms` (time to first token)
- **Tokens:** the token columns described below

### Token counting

AI providers disagree about what each token field includes:

- **Anthropic** reports cache reads and cache writes separately beside `input_tokens`, and counts thinking tokens inside `output_tokens`.
- **OpenAI and Codex** count cached tokens inside `input_tokens`, and reasoning tokens inside `output_tokens`.
- **Gemini** counts cached tokens inside the prompt count, and reports thought tokens separately beside the output candidates.

The proxy's flat `tokens` object keeps each provider's original numbers, so adding its fields together double-counts tokens. Slopboard reads `token_breakdown` instead, which the proxy has already normalised into non-overlapping buckets:

| Column | Meaning |
| --- | --- |
| `input_tokens` | Input tokens neither read from nor written to the cache |
| `cache_read_tokens` | Input tokens read from the cache |
| `cache_write_tokens` | Input tokens written to the cache (`cache_write_1h_tokens`: the part with the 1-hour cache lifetime) |
| `output_tokens` | Output tokens, with reasoning tokens included |
| `reasoning_tokens` | The part of `output_tokens` spent on reasoning |
| `unclassified_tokens` | Tokens the proxy could not place in a bucket (for example, from an unknown provider) |
| `total_tokens` | The sum of the columns above except `reasoning_tokens` (which is already inside `output_tokens`) |

Unclassified tokens are still counted (the board displays them as input) but never priced: an event with any unclassified tokens gets no cost.

### Requests vs. attempts

Each row in `events` is one upstream *attempt* (a single try sent to an AI provider). If the proxy retries a request, all attempts for that inbound request share the same `trace_id`. All turns sent over a single Codex WebSocket connection also share a `trace_id`.

To count user-level "requests", count every successful attempt plus any `trace_id` where no attempt succeeded:

```sql
count(*) filter (where not failed)
  + count(distinct trace_id) - count(distinct trace_id) filter (where not failed)   -- requests
count(distinct trace_id) - count(distinct trace_id) filter (where not failed)       -- failed requests
```

### Sessions, threads, and subagents

- `session_id` and `parent_session_id` are UUIDs (unique identifiers) assigned by the proxy — either the client's own session UUID when it sends one, or a hash made by the proxy.
- A subagent gets its own session whose `parent_session_id` points to the session that spawned it (usually the main conversation, sometimes another subagent).
- `thread_id` is the root of that tree, kept up to date even when records arrive out of order.
- `is_subagent` is true when a session has a parent and the link is not just a fork (branching a conversation) or a compaction (summarising an earlier conversation to save context).

## Security notes

- **No login screen.** Neither the leaderboard nor `POST /api/sql` has authentication in front of it. By default, Slopboard only listens on `127.0.0.1:8318`; expose it only to people you trust, such as through `tailscale serve` on your tailnet.
- **What `POST /api/sql` exposes.** Everyone on the tailnet who can reach `/api/sql` can read the stored data, including **client IP addresses, user agents, and the account names of the upstream subscriptions**. Leave `DATABASE_RO_URL` empty if you want to disable `/api/sql`.
- **How `POST /api/sql` is sandboxed.** Because there is no login, the SQL endpoint is locked down at the database level:
  - It connects as a dedicated Postgres role that can only `SELECT`, cannot create temporary tables, and cannot take advisory locks (locks that can outlive a query or block migrations).
  - Every request gets its own database connection and closes it right after, so nothing a query sets or locks can carry over to the next request.
  - Each query runs as a single prepared statement inside a read-only transaction, so Postgres itself rejects any attempt to run a second statement.
  - Rows and bytes are counted inside Postgres, so an oversized result never reaches the Slopboard process.
- **API keys.** Slopboard stores only SHA-256 hashes of client API keys, never the plaintext keys, and strips plaintext keys out of `events.raw`. Keep in mind the proxy auth rules under [Important rules before changing keys](#important-rules-before-changing-keys): adding the first key turns auth on for everyone (`--first-key`), and removing the last key opens the proxy to anyone who can reach it (`--force`).

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

The test suite never talks to a real proxy; `src/server/test/fake-proxy.ts` stands in for its two management endpoints.

### Project layout

| File | Role |
| --- | --- |
| `src/shared/api.ts` | Shared API contract between the server and the web UI. |
| `src/server/main.ts` | Entry point: runs migrations, the collector, price refreshes, and the HTTP server. |
| `src/server/collector.ts` | Poll loop, retry back-off, and the in-memory buffer. |
| `src/server/ingest.ts` | Converts proxy records into `events` rows, inserts them, and resolves `thread_id`. |
| `src/server/proxy.ts` | Client for the proxy's management API. |
| `src/server/board.ts`, `awards.ts`, `format.ts` | Builds the board, its awards and records, and their wording. |
| `src/server/prices.ts` | Downloads and stores LiteLLM's price list. |
| `src/server/sqlapi.ts` | `POST /api/sql` endpoint and read-only query safeguards. |
| `src/server/http.ts` | HTTP routes. |
| `src/server/keys.ts`, `cli.ts` | People, API keys, and the admin CLI. |
| `src/server/db.ts` | Database connections, migrations, and the read-only role. |
| `src/server/seed.ts`, `synthetic.ts` | Synthetic usage data for local development. |
| `src/server/migrations/` | SQL migrations, applied in order at startup. Never edit one that has already run; add the next number. |
