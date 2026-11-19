-- Slopboard schema, version 1.
-- Applied once, inside a transaction, by src/server/db.ts.

-- ---------------------------------------------------------------- people

create table people (
  id         text primary key
             check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$' and id <> 'shared'),
  name       text not null,
  created_at timestamptz not null default now()
);

-- A client API key of the proxy, known only by its SHA-256. The plaintext is
-- never stored. Events point at key_hash, so (re)assigning a key to a person
-- re-attributes every event that key ever produced.
create table api_keys (
  key_hash   text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  person_id  text not null references people (id) on update cascade on delete cascade,
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index api_keys_person_idx on api_keys (person_id);

-- ---------------------------------------------------------------- events

-- One row per usage record of the proxy, which is one upstream attempt.
create table events (
  -- `execution_id` of the record: unique per upstream attempt.
  event_id              text primary key,
  ts                    timestamptz not null,
  ingested_at           timestamptz not null default now(),
  -- SHA-256 hex of the client API key, null when the request carried none.
  key_hash              text,
  -- Inbound request id of the proxy. Retries of one inbound request share it,
  -- and so do all turns sent over one Codex websocket connection.
  request_id            text,
  trace_id              text not null,
  session_id            text,
  parent_session_id     text,
  -- Root of the session tree this event belongs to (see `sessions`).
  thread_id             text,
  is_subagent           boolean not null default false,
  is_fork               boolean not null default false,
  is_compaction         boolean not null default false,
  node_kind             text,
  provider              text not null,
  executor_type         text,
  -- Upstream model that ran. Prices are looked up by this.
  model                 text not null,
  -- Model exactly as the client asked for it, thinking suffix included.
  alias                 text not null,
  -- `alias` without a "(...)" thinking suffix. The board groups by this.
  requested_model       text not null,
  response_model        text,
  endpoint              text,
  auth_type             text,
  auth_index            text,
  source                text,
  reasoning_effort      text,
  service_tier          text,
  speed                 text,
  stream                boolean not null default false,
  generate              boolean not null default true,
  failed                boolean not null default false,
  status_code           integer,
  fail_code             text,
  -- Non-overlapping token buckets (see README, "Token accounting").
  input_tokens          bigint not null default 0,
  cache_read_tokens     bigint not null default 0,
  cache_write_tokens    bigint not null default 0,
  -- The part of cache_write_tokens written with a 1 hour TTL.
  cache_write_1h_tokens bigint not null default 0,
  -- Reasoning included.
  output_tokens         bigint not null default 0,
  reasoning_tokens      bigint not null default 0,
  -- Tokens the proxy could not assign to a bucket. Counted, never priced.
  unclassified_tokens   bigint not null default 0,
  total_tokens          bigint generated always as
    (input_tokens + cache_read_tokens + cache_write_tokens + output_tokens + unclassified_tokens) stored,
  token_quality         text,
  latency_ms            bigint,
  ttft_ms               bigint,
  client_ip             text,
  user_agent            text,
  -- The whole record as the proxy sent it, minus the plaintext API key.
  raw                   jsonb not null
);
create index events_ts_idx on events (ts);
create index events_key_ts_idx on events (key_hash, ts);
create index events_thread_idx on events (thread_id);
create index events_session_idx on events (session_id);
create index events_trace_idx on events (trace_id);

-- Session tree. thread_id is the root reached by following parent links, and
-- is recomputed by the collector whenever a link appears.
create table sessions (
  session_id        text primary key,
  parent_session_id text,
  thread_id         text not null,
  first_seen        timestamptz not null default now()
);
create index sessions_thread_idx on sessions (thread_id);
create index sessions_parent_idx on sessions (parent_session_id);

-- Every upstream model ever seen, so prices can be resolved without scanning events.
create table models (
  model      text primary key,
  provider   text not null,
  first_seen timestamptz not null default now()
);

create table meta (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- prices

-- LiteLLM's public price list, one row per LiteLLM model id. Costs are USD per token.
create table model_prices (
  id                                        text primary key,
  provider                                  text,
  mode                                      text,
  input_cost_per_token                      numeric,
  output_cost_per_token                     numeric,
  cache_read_input_token_cost               numeric,
  cache_creation_input_token_cost           numeric,
  cache_creation_input_token_cost_above_1hr numeric,
  output_cost_per_reasoning_token           numeric,
  -- Multiplier LiteLLM publishes for responses served in fast mode.
  fast_multiplier                           numeric,
  raw                                       jsonb not null,
  updated_at                                timestamptz not null default now()
);

-- Manual corrections, keyed by the proxy's upstream model id. Either point the
-- model at a LiteLLM id (an alias) or give prices outright; prices win.
create table model_price_overrides (
  model                       text primary key,
  litellm_id                  text,
  input_cost_per_token        numeric,
  output_cost_per_token       numeric,
  cache_read_cost_per_token   numeric,
  cache_write_cost_per_token  numeric,
  cache_write_1h_cost_per_token numeric,
  note                        text,
  updated_at                  timestamptz not null default now(),
  check (litellm_id is not null
         or (input_cost_per_token is not null and output_cost_per_token is not null)),
  check ((input_cost_per_token is null) = (output_cost_per_token is null))
);

-- LiteLLM prefixes the ids of some providers, e.g. "gemini/gemini-2.5-pro".
create function litellm_prefix(provider text) returns text
language sql immutable as $$
  select case
    when provider ilike '%gemini%' or provider ilike '%aistudio%' or provider ilike '%antigravity%' then 'gemini'
    when provider ilike '%xai%' or provider ilike '%grok%' then 'xai'
    when provider ilike '%deepseek%' then 'deepseek'
    else null
  end
$$;

-- The price of each model seen, or price_source null when there is no confident
-- match. Order of preference: manual prices, manual alias, exact LiteLLM id,
-- LiteLLM id with the provider prefix. Nothing fuzzier than that, on purpose.
--
-- The CTE is MATERIALIZED so that a query joining events to this view resolves
-- the handful of models once, instead of once per event.
create view model_pricing as
with resolved as materialized (
  select
    m.model,
    m.provider,
    case
      when o.input_cost_per_token is not null then 'manual'
      when l.id is null then null
      when l.id = o.litellm_id then 'alias'
      when l.id = k.price_key then 'exact'
      else 'provider-prefix'
    end as price_source,
    l.id as litellm_id,
    coalesce(o.input_cost_per_token, l.input_cost_per_token) as input_cost,
    coalesce(o.output_cost_per_token, l.output_cost_per_token) as output_cost,
    case when o.input_cost_per_token is not null
      then coalesce(o.cache_read_cost_per_token, o.input_cost_per_token)
      else coalesce(l.cache_read_input_token_cost, l.input_cost_per_token)
    end as cache_read_cost,
    case when o.input_cost_per_token is not null
      then coalesce(o.cache_write_cost_per_token, o.input_cost_per_token)
      else coalesce(l.cache_creation_input_token_cost, l.input_cost_per_token)
    end as cache_write_cost,
    case when o.input_cost_per_token is not null
      then coalesce(o.cache_write_1h_cost_per_token, o.cache_write_cost_per_token, o.input_cost_per_token)
      else coalesce(l.cache_creation_input_token_cost_above_1hr, l.cache_creation_input_token_cost, l.input_cost_per_token)
    end as cache_write_1h_cost,
    case when o.input_cost_per_token is not null
      then o.output_cost_per_token
      else coalesce(l.output_cost_per_reasoning_token, l.output_cost_per_token)
    end as reasoning_cost,
    case when o.input_cost_per_token is not null then null else l.fast_multiplier end as fast_multiplier
  from models m
  cross join lateral (
    select lower(regexp_replace(m.model, '\([^()]*\)$', '')) as price_key
  ) k
  left join model_price_overrides o on o.model = m.model
  left join lateral (
    select p.id, p.input_cost_per_token, p.output_cost_per_token, p.cache_read_input_token_cost,
           p.cache_creation_input_token_cost, p.cache_creation_input_token_cost_above_1hr,
           p.output_cost_per_reasoning_token, p.fast_multiplier
    from model_prices p
    where o.input_cost_per_token is null
      and p.input_cost_per_token is not null
      and p.output_cost_per_token is not null
      and p.id in (o.litellm_id, k.price_key, litellm_prefix(m.provider) || '/' || k.price_key)
    order by case when p.id = o.litellm_id then 0 when p.id = k.price_key then 1 else 2 end
    limit 1
  ) l on true
)
-- float8 rates: per-event cost is then plain float arithmetic, which is much
-- faster than numeric and exact enough for dollars.
select
  model,
  provider,
  price_source,
  litellm_id,
  input_cost::float8 as input_cost,
  output_cost::float8 as output_cost,
  cache_read_cost::float8 as cache_read_cost,
  cache_write_cost::float8 as cache_write_cost,
  cache_write_1h_cost::float8 as cache_write_1h_cost,
  reasoning_cost::float8 as reasoning_cost,
  fast_multiplier::float8 as fast_multiplier
from resolved;

-- ---------------------------------------------------------------- read side

-- Events with the person and the cost worked out at read time. Query this.
--   person_id  the person the key belongs to now, 'shared' when it belongs to nobody
--   cost_usd   what the event would cost at public API prices; null when the
--              model has no price or the tokens could not be classified
create view events_v as
select
  e.*,
  coalesce(k.person_id, 'shared') as person_id,
  coalesce(pe.name, 'Shared key') as person_name,
  (k.person_id is null) as unassigned,
  mp.price_source,
  case
    when mp.price_source is null or e.unclassified_tokens > 0 then null
    else ((
        e.input_tokens * mp.input_cost
      + e.cache_read_tokens * mp.cache_read_cost
      + (e.cache_write_tokens - e.cache_write_1h_tokens) * mp.cache_write_cost
      + e.cache_write_1h_tokens * mp.cache_write_1h_cost
      + (e.output_tokens - e.reasoning_tokens) * mp.output_cost
      + e.reasoning_tokens * mp.reasoning_cost
    ) * case when e.speed = 'fast' then coalesce(mp.fast_multiplier, 1) else 1 end)
  end as cost_usd
from events e
left join api_keys k on k.key_hash = e.key_hash
left join people pe on pe.id = k.person_id
left join model_pricing mp on mp.model = e.model;

-- One row per thread: a root session plus every session under it.
create view threads_v as
select
  thread_id,
  mode() within group (order by person_id) as person_id,
  min(ts) as started_at,
  max(ts) as ended_at,
  count(*) as events,
  count(distinct session_id) as sessions,
  count(distinct session_id) filter (where is_subagent) as subagents,
  sum(total_tokens)::bigint as total_tokens,
  sum(cost_usd) as cost_usd,
  -- The model of the main conversation; subagents often run something cheaper.
  coalesce(mode() within group (order by requested_model) filter (where not is_subagent),
           mode() within group (order by requested_model)) as model
from events_v
where thread_id is not null
group by thread_id;
