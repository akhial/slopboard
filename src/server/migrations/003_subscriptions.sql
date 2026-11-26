-- Subscription-based real cost accounting.
--
-- Stores per-account subscription config (`subscriptions`), persisted weekly
-- quota history synced from CLIProxyAPI (`quota_samples`), and per-event
-- weekly quota / real subscription cost columns on `events`.

-- ---------------------------------------------------------------- events

alter table events
  add column quota_used_pct double precision,
  add column quota_reset_at timestamptz,
  add column quota_weeks    double precision,
  add column sub_cost_usd   double precision;

create index events_provider_source_ts_idx
  on events (provider, source, ts, event_id)
  where source is not null;

-- Backfill quota observations already present in stored response headers.
-- Claude reports 7d utilization as a 0..1 fraction and reset as Unix seconds.
-- Codex reports primary window used percent (0..100), window minutes (10080 = 7d)
-- and reset as Unix seconds; imagegen limits are not plan quota.
update events
set
  quota_used_pct = case
    when provider = 'claude'
      and raw->'response_headers'->'Anthropic-Ratelimit-Unified-7d-Utilization'->>0 ~ '^[0-9]+(\.[0-9]+)?$'
    then least(100.0, greatest(0.0, (raw->'response_headers'->'Anthropic-Ratelimit-Unified-7d-Utilization'->>0)::double precision * 100.0))
    when provider = 'codex'
      and raw->'response_headers'->'X-Codex-Primary-Used-Percent'->>0 ~ '^[0-9]+(\.[0-9]+)?$'
      and raw->'response_headers'->'X-Codex-Primary-Window-Minutes'->>0 = '10080'
      and coalesce(raw->'response_headers'->'X-Codex-Active-Limit'->>0, '') not ilike 'imagegen%'
    then least(100.0, greatest(0.0, (raw->'response_headers'->'X-Codex-Primary-Used-Percent'->>0)::double precision))
    else null
  end,
  quota_reset_at = case
    when provider = 'claude'
      and raw->'response_headers'->'Anthropic-Ratelimit-Unified-7d-Reset'->>0 ~ '^[0-9]+(\.[0-9]+)?$'
      and (raw->'response_headers'->'Anthropic-Ratelimit-Unified-7d-Reset'->>0)::double precision > 0
    then to_timestamp((raw->'response_headers'->'Anthropic-Ratelimit-Unified-7d-Reset'->>0)::double precision)
    when provider = 'codex'
      and raw->'response_headers'->'X-Codex-Primary-Window-Minutes'->>0 = '10080'
      and coalesce(raw->'response_headers'->'X-Codex-Active-Limit'->>0, '') not ilike 'imagegen%'
      and raw->'response_headers'->'X-Codex-Primary-Reset-At'->>0 ~ '^[0-9]+(\.[0-9]+)?$'
      and (raw->'response_headers'->'X-Codex-Primary-Reset-At'->>0)::double precision > 0
    then to_timestamp((raw->'response_headers'->'X-Codex-Primary-Reset-At'->>0)::double precision)
    else null
  end
where provider in ('claude', 'codex')
  and raw ? 'response_headers';

-- ---------------------------------------------------------------- subscriptions

-- One row per upstream subscription account (e.g. a Claude Max 20x or Codex Pro
-- OAuth credential). Accounts discovered in CLIProxyAPI's quota history are also
-- priced by their plan defaults when no explicit row exists; a row here sets the
-- exact monthly price, billing day of month (1..31), or ignores an account.
create table subscriptions (
  provider         text not null,
  source           text not null,
  plan             text,
  -- Null means "use the discovered plan default" (e.g. for an ignore-only row).
  monthly_cost_usd numeric check (monthly_cost_usd is null or monthly_cost_usd >= 0),
  billing_day      integer check (billing_day between 1 and 31),
  ignored          boolean not null default false,
  note             text,
  updated_at       timestamptz not null default now(),
  primary key (provider, source)
);

-- Persisted quota samples synced from CLIProxyAPI /v8/management/quota/history,
-- kept beyond the proxy's rolling JSONL retention so historical billing cycles
-- and mid-window/early resets remain exact.
create table quota_samples (
  provider   text not null,
  source     text not null,
  window_id  text not null,
  ts         timestamptz not null,
  used_pct   double precision not null check (used_pct >= 0 and used_pct <= 100),
  reset_at   timestamptz,
  plan       text,
  primary key (provider, source, window_id, ts)
);
create index quota_samples_lookup_idx on quota_samples (provider, source, window_id, ts);

-- ---------------------------------------------------------------- read views

drop view threads_v;
drop view events_v;

create view events_v as
select
  e.*,
  coalesce(k.person_id, 'shared') as person_id,
  coalesce(pe.name, 'Shared key') as person_name,
  (k.person_id is null) as unassigned,
  mp.price_source,
  calc.api_cost_usd,
  calc.api_cost_usd as cost_usd
from events e
left join api_keys k on k.key_hash = e.key_hash
left join people pe on pe.id = k.person_id
left join model_pricing mp on mp.model = e.model
cross join lateral (
  select case
    when mp.price_source is null or e.unclassified_tokens > 0 then null
    else ((
        e.input_tokens * mp.input_cost
      + e.cache_read_tokens * mp.cache_read_cost
      + (e.cache_write_tokens - e.cache_write_1h_tokens) * mp.cache_write_cost
      + e.cache_write_1h_tokens * mp.cache_write_1h_cost
      + (e.output_tokens - e.reasoning_tokens) * mp.output_cost
      + e.reasoning_tokens * mp.reasoning_cost
    ) * case when e.speed = 'fast' then coalesce(mp.fast_multiplier, 1) else 1 end)
  end as api_cost_usd
) calc;

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
  sum(api_cost_usd) as api_cost_usd,
  sum(sub_cost_usd) as sub_cost_usd,
  coalesce(mode() within group (order by requested_model) filter (where not is_subagent),
           mode() within group (order by requested_model)) as model
from events_v
where thread_id is not null
group by thread_id;
