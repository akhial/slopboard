-- Allow hyphenated thinking/effort suffixes on upstream model IDs (e.g.
-- "gemini-4-neon-high", "gemini-4-neon-medium", "gemini-3.8-flash-low") to
-- fall back to their base LiteLLM entry ("gemini/gemini-4-neon", etc.) when
-- no exact entry exists for the suffixed name.

create or replace view model_pricing as
with resolved as materialized (
  select
    m.model,
    m.provider,
    case
      when o.input_cost_per_token is not null then 'manual'
      when l.id is null then null
      when l.id = o.litellm_id then 'alias'
      when l.id in (k.price_key, k.base_key) then 'exact'
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
    select
      lower(regexp_replace(m.model, '\([^()]*\)$', '')) as price_key,
      lower(regexp_replace(regexp_replace(m.model, '\([^()]*\)$', ''), '-(minimal|low|medium|high|xhigh|max|auto)$', '')) as base_key
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
      and p.id in (
        o.litellm_id,
        k.price_key,
        litellm_prefix(m.provider) || '/' || k.price_key,
        k.base_key,
        litellm_prefix(m.provider) || '/' || k.base_key
      )
    order by case
      when p.id = o.litellm_id then 0
      when p.id = k.price_key then 1
      when p.id = litellm_prefix(m.provider) || '/' || k.price_key then 2
      when p.id = k.base_key then 3
      else 4
    end
    limit 1
  ) l on true
)
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
