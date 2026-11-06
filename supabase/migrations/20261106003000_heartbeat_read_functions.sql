-- COR-5215: read-only functions for heartbeat-dashboard (COR-5208 step 3.1).
--
-- Heartbeat read tokens, its 10-minute timeline and "running now" from the old
-- logger store, which has had no Codex data since Nov 4. These functions give
-- it the same facts from Sherlock:
--   people()                         who exists, and when they were last active
--   fresh_token_sessions(start, end) tokens per session from precomputed usage
--   usage_receipt(start, end)        how fresh and complete those tokens are
--   timeline_activity(start, end, bucket_minutes)
--                                    activity per person, session and bucket
--
-- Every function:
--   * runs as its owner and covers the E3 workspace (slug e3-development) only;
--   * drops sessions in sherlock_access.hidden_session_ids() (restricted people,
--     their child sessions, owner-excluded sessions) and the smoke-test account;
--   * returns no content: no titles, prompts, messages, paths or excerpts. A
--     session is named by an opaque key, sha256 of its id, never the id;
--   * is executable only by the NOLOGIN role sherlock_presence_reader (made for
--     heartbeat_api.coding_presence). The Heartbeat login, with its password,
--     is created outside migrations and granted that role.

set lock_timeout = '1s';

-- Private helpers: no grants, called only from the functions below.
create or replace function heartbeat_api.e3_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $body$
select w.id from telemetry.workspaces w where w.slug = 'e3-development'
$body$;

create or replace function heartbeat_api.hidden_sessions()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $body$
begin
  -- sherlock_access is production-only; without it nothing is hidden.
  if pg_catalog.to_regprocedure('sherlock_access.hidden_session_ids()') is not null then
    return query execute 'select h from sherlock_access.hidden_session_ids() h';
  end if;
end
$body$;

create or replace function heartbeat_api.session_key(p_session_id uuid)
returns text
language sql
immutable
set search_path = ''
as $body$
select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  'sherlock-heartbeat-session:' || p_session_id::text, 'UTF8')), 'hex')
$body$;

-- People of the E3 workspace. last_activity_at is the latest model activity
-- in the last 7 days (basis 'usage'), else the latest session start
-- (basis 'session_start'), counting only sessions Heartbeat may see.
create or replace function heartbeat_api.people()
returns table (
  person_id uuid,
  email text,
  display_name text,
  last_activity_at timestamptz,
  last_activity_basis text
)
language sql
stable
security definer
set search_path = ''
as $body$
with ws as materialized (
  select heartbeat_api.e3_workspace_id() id
), hidden as materialized (
  select h from heartbeat_api.hidden_sessions() h
), recent as materialized (
  select s.person_id, pg_catalog.max(u.usage_at) last_usage_at
    from analytics.usage_contributions u
    join ws on u.workspace_id = ws.id
    join telemetry.sessions s on s.workspace_id = u.workspace_id and s.id = u.session_id
   where u.usage_at >= pg_catalog.now() - interval '7 days'
     and not exists (select 1 from hidden where hidden.h = u.session_id)
   group by s.person_id
), started as materialized (
  select s.person_id, pg_catalog.max(s.started_at) last_started_at
    from telemetry.sessions s
    join ws on s.workspace_id = ws.id
   where not exists (select 1 from hidden where hidden.h = s.id)
   group by s.person_id
)
select pe.id, pe.email, coalesce(nullif(pg_catalog.btrim(pe.display_name), ''), 'Unknown'),
       coalesce(r.last_usage_at, st.last_started_at),
       case when r.last_usage_at is not null then 'usage'
            when st.last_started_at is not null then 'session_start' end
  from telemetry.people pe
  join ws on pe.workspace_id = ws.id
  left join recent r on r.person_id = pe.id
  left join started st on st.person_id = pe.id
 where pe.github_id is distinct from 'sherlock-smoke'
 order by pe.id
$body$;
comment on function heartbeat_api.people() is
  'COR-5215: E3 people (id, email, name) and their latest visible activity. No content.';

-- How fresh the precomputed usage is for [p_start, p_end). path:
--   precomputed           fresh_token_sessions is complete for the window
--   precomputed_catching_up  covered, but the refresh is behind, a session has
--                         waited over 10 minutes, or the daily check found an
--                         open gap; affected sessions come back pending
--   not_covered           the window starts before the backfill cursor
create or replace function heartbeat_api.usage_receipt(p_start timestamptz, p_end timestamptz)
returns table (
  read_at timestamptz,
  path text,
  backfill_cursor timestamptz,
  refreshed_at timestamptz,
  raw_watermark timestamptz,
  canonical_watermark timestamptz,
  pending_normalize_count bigint,
  oldest_pending_normalize timestamptz,
  dirty_sessions bigint,
  oldest_dirty_mark timestamptz,
  gap_open boolean,
  last_checked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ws uuid := heartbeat_api.e3_workspace_id();
  v_state analytics.usage_contribution_state;
  v_fresh record;
  v_dirty bigint;
  v_oldest timestamptz;
  v_gap boolean;
  v_checked timestamptz;
begin
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > interval '7 days' then
    raise exception using errcode = '22023', message = 'heartbeat_usage_window_invalid';
  end if;
  select * into v_state from analytics.usage_contribution_state st where st.workspace_id = v_ws;
  select f.raw_watermark, f.canonical_watermark, f.pending_normalize_count, f.oldest_pending_normalize
    into v_fresh
    from analytics.read_dashboard_freshness(v_ws, 'e3group.ai', array[
      'sherlock.codex-rollout.v1', 'sherlock.codex-rollout.v2', 'sherlock.codex-rollout.v3',
      'sherlock.codex-rollout.v4', 'sherlock.claude-code-transcript.v1'], 500) f
   limit 1;
  select pg_catalog.count(*), pg_catalog.min(d.first_marked_at) into v_dirty, v_oldest
    from analytics.usage_contribution_dirty d where d.workspace_id = v_ws;
  v_gap := analytics.usage_contribution_gap_open(v_ws, p_start, p_end);
  select pg_catalog.max(c.checked_at) into v_checked
    from analytics.usage_contribution_checks c
   where c.workspace_id = v_ws
     and c.day::timestamp at time zone 'UTC' < p_end
     and c.day::timestamp at time zone 'UTC' + interval '1 day' > p_start;
  return query select
    pg_catalog.now(),
    case
      when v_state.backfill_cursor is null or v_state.backfill_cursor > p_start then 'not_covered'
      when v_state.refreshed_at < pg_catalog.now() - interval '10 minutes'
        or v_oldest < pg_catalog.now() - interval '10 minutes' or v_gap
        then 'precomputed_catching_up'
      else 'precomputed' end,
    v_state.backfill_cursor, v_state.refreshed_at,
    v_fresh.raw_watermark, v_fresh.canonical_watermark,
    v_fresh.pending_normalize_count, v_fresh.oldest_pending_normalize,
    v_dirty, v_oldest, v_gap, v_checked;
end
$body$;
comment on function heartbeat_api.usage_receipt(timestamptz, timestamptz) is
  'COR-5215: freshness receipt for fresh_token_sessions over [p_start, p_end): path, backfill cursor, watermarks, pending normalization, dirty queue, daily-check gap.';

-- Tokens per visible session for [p_start, p_end), at most 7 days, from
-- analytics.usage_contributions with the same rules as sherlock__query_usage:
-- a cumulative stream's first observation counts only when the session
-- started inside the window (otherwise missing_baseline and 0).
--   input_delta  uncached input
--   output_delta output + reasoning
--   cached_delta cached input reads
-- status, first match wins: source_conflict, regressed, component_missing,
-- missing_baseline, measured. pending: the session is waiting to be
-- recomputed, so its numbers may be a few minutes behind. Raises
-- heartbeat_usage_window_not_covered before the backfill cursor.
create or replace function heartbeat_api.fresh_token_sessions(p_start timestamptz, p_end timestamptz)
returns table (
  person_id uuid,
  email text,
  display_name text,
  session_key text,
  provider text,
  started_in_window boolean,
  status text,
  pending boolean,
  usage_events bigint,
  input_delta bigint,
  output_delta bigint,
  cached_delta bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ws uuid := heartbeat_api.e3_workspace_id();
  v_cursor timestamptz;
begin
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > interval '7 days' then
    raise exception using errcode = '22023', message = 'heartbeat_usage_window_invalid';
  end if;
  select st.backfill_cursor into v_cursor from analytics.usage_contribution_state st where st.workspace_id = v_ws;
  if v_cursor is null or v_cursor > p_start then
    raise exception using errcode = '22023', message = 'heartbeat_usage_window_not_covered',
      detail = 'Precomputed usage starts at ' || coalesce(v_cursor::text, 'nothing') || '.';
  end if;
  return query
  with hidden as materialized (
    select h from heartbeat_api.hidden_sessions() h
  ), gaps as materialized (
    select distinct g.session_id
      from analytics.usage_contribution_checks c
      cross join lateral pg_catalog.unnest(c.gap_session_ids) g(session_id)
      left join analytics.usage_contribution_sessions cs
        on cs.workspace_id = c.workspace_id and cs.session_id = g.session_id
     where c.workspace_id = v_ws
       and c.day::timestamp at time zone 'UTC' < p_end
       and c.day::timestamp at time zone 'UTC' + interval '1 day' > p_start
       and (cs.computed_at is null or cs.computed_at < c.checked_at)
  ), contributions as materialized (
    select u.session_id, s.person_id, s.started_at, u.provider, u.regression, u.source_uncertain,
           u.input_missing or u.cached_missing or u.output_missing or u.reasoning_missing
             or u.total_missing component_missing,
           u.first_in_stream and s.started_at < p_start missing_baseline,
           case when u.first_in_stream and s.started_at < p_start then 0 else u.input_delta end input_delta,
           case when u.first_in_stream and s.started_at < p_start then 0 else u.cached_delta end cached_delta,
           case when u.first_in_stream and s.started_at < p_start then 0
                else u.output_delta + u.reasoning_delta end output_delta
      from analytics.usage_contributions u
      join telemetry.sessions s on s.workspace_id = u.workspace_id and s.id = u.session_id
     where u.workspace_id = v_ws
       and u.usage_at >= p_start and u.usage_at < p_end
       and s.started_at < p_end
       and not exists (select 1 from hidden where hidden.h = u.session_id)
  )
  select pe.id, pe.email, coalesce(nullif(pg_catalog.btrim(pe.display_name), ''), 'Unknown'),
         heartbeat_api.session_key(c.session_id),
         pg_catalog.min(c.provider),
         pg_catalog.min(c.started_at) >= p_start,
         case when pg_catalog.bool_or(c.source_uncertain) then 'source_conflict'
              when pg_catalog.bool_or(c.regression) then 'regressed'
              when pg_catalog.bool_or(c.component_missing) then 'component_missing'
              when pg_catalog.bool_or(c.missing_baseline) then 'missing_baseline'
              else 'measured' end,
         exists (select 1 from analytics.usage_contribution_dirty d
                  where d.workspace_id = v_ws and d.session_id = c.session_id)
           or exists (select 1 from gaps where gaps.session_id = c.session_id),
         pg_catalog.count(*)::bigint,
         pg_catalog.sum(c.input_delta)::bigint,
         pg_catalog.sum(c.output_delta)::bigint,
         pg_catalog.sum(c.cached_delta)::bigint
    from contributions c
    join telemetry.people pe on pe.workspace_id = v_ws and pe.id = c.person_id
   where pe.github_id is distinct from 'sherlock-smoke'
   group by pe.id, pe.email, pe.display_name, c.session_id
   order by pe.id, 4;
end
$body$;
comment on function heartbeat_api.fresh_token_sessions(timestamptz, timestamptz) is
  'COR-5215: tokens per visible E3 session over [p_start, p_end) (at most 7 days) from precomputed usage; opaque session keys, no content.';

-- Activity per (person, session, bucket) for [p_start, p_end), at most 24
-- hours, bucket 5-60 minutes, from the dashboard's frame evidence (the active
-- frame version), so prompts are deduplicated the same way:
--   prompts       distinct human prompts first seen in the bucket
--   tool_calls / tool_results  tool activity evidence in the bucket
--   tools         up to 20 tool names
--   active_seconds  union of activity spans (sherlock.activity.v1) in the bucket;
--                 spans starting over 12 hours before the window are not counted
-- Reviewer (guardian) sessions and automation sessions are left out. Frame
-- evidence trails ingest by the projector's lag; stats.evidence_watermark is
-- the latest evidence observed in the window. Returns jsonb:
--   schema_version, source, frame_version, window, bucket_minutes, truncated,
--   buckets[], sessions[], stats.
create or replace function heartbeat_api.timeline_activity(
  p_start timestamptz,
  p_end timestamptz,
  p_bucket_minutes integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_ws uuid := heartbeat_api.e3_workspace_id();
  v_frame text;
  v_result jsonb;
begin
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > interval '24 hours'
     or p_bucket_minutes is null or p_bucket_minutes < 5 or p_bucket_minutes > 60 then
    raise exception using errcode = '22023', message = 'heartbeat_timeline_window_invalid';
  end if;
  select a.frame_version into v_frame
    from analytics.frame_projection_activations a
   where a.workspace_id = v_ws
   order by a.activated_at desc
   limit 1;

  with hidden as materialized (
    select h from heartbeat_api.hidden_sessions() h
  ), ranked as materialized (
    select distinct on (r.evidence_kind, r.source_event_id)
           r.evidence_kind, r.source_event_id, r.session_id, r.person_id, r.observed_at,
           r.actor_role, r.event_kind, r.prompt_identity, r.is_tombstone
      from analytics.frame_evidence_revisions r
     where r.workspace_id = v_ws and r.frame_version = v_frame
       and r.anchor_observed_at >= p_start - interval '1 minute'
       and r.anchor_observed_at < p_end + interval '1 minute'
     order by r.evidence_kind, r.source_event_id, r.id desc
  ), evidence as materialized (
    select e.*, s.actor_role session_role
      from ranked e
      join telemetry.sessions s on s.workspace_id = v_ws and s.id = e.session_id
      join telemetry.people pe on pe.workspace_id = v_ws and pe.id = e.person_id
     where not e.is_tombstone
       and e.observed_at >= p_start and e.observed_at < p_end
       and e.actor_role is distinct from 'guardian'
       and s.actor_role not in ('guardian', 'automation')
       and pe.github_id is distinct from 'sherlock-smoke'
       and not exists (select 1 from hidden where hidden.h = e.session_id)
  ), first_prompts as materialized (
    select distinct on (e.person_id, e.prompt_identity) e.person_id, e.session_id, e.observed_at
      from evidence e
     where e.evidence_kind = 'prompt' and e.prompt_identity is not null
     order by e.person_id, e.prompt_identity, e.observed_at, e.source_event_id
  ), binned as materialized (
    select e.person_id, e.session_id, e.session_role,
           pg_catalog.date_bin(pg_catalog.make_interval(mins => p_bucket_minutes), e.observed_at, p_start) bucket_start,
           e.evidence_kind, e.event_kind, e.source_event_id, e.observed_at
      from evidence e
     where e.evidence_kind = 'activity'
  ), bucket_rows as materialized (
    select b.person_id, b.session_id, b.bucket_start, pg_catalog.min(b.session_role) actor_role,
           pg_catalog.min(b.observed_at) first_activity_at, pg_catalog.max(b.observed_at) last_activity_at,
           pg_catalog.count(*) filter (where b.event_kind = 'tool_call') tool_calls,
           pg_catalog.count(*) filter (where b.event_kind = 'tool_result') tool_results,
           pg_catalog.array_agg(b.source_event_id) filter (where b.event_kind = 'tool_call') tool_event_ids
      from binned b
     group by b.person_id, b.session_id, b.bucket_start
  ), prompt_rows as (
    select f.person_id, f.session_id,
           pg_catalog.date_bin(pg_catalog.make_interval(mins => p_bucket_minutes), f.observed_at, p_start) bucket_start,
           pg_catalog.count(*) prompts
      from first_prompts f
     group by 1, 2, 3
  ), all_buckets as materialized (
    select coalesce(b.person_id, p.person_id) person_id, coalesce(b.session_id, p.session_id) session_id,
           coalesce(b.bucket_start, p.bucket_start) bucket_start, b.actor_role,
           b.first_activity_at, b.last_activity_at,
           coalesce(b.tool_calls, 0) tool_calls, coalesce(b.tool_results, 0) tool_results,
           coalesce(p.prompts, 0) prompts, b.tool_event_ids
      from bucket_rows b
      full join prompt_rows p
        on p.person_id = b.person_id and p.session_id = b.session_id and p.bucket_start = b.bucket_start
  ), limited as materialized (
    select * from all_buckets order by bucket_start, session_id limit 50000
  ), spans as materialized (
    -- Spans that start more than 12 hours before the window are not counted.
    select sp.session_id, greatest(sp.started_at, p_start) started_at, least(sp.ended_at, p_end) ended_at
      from analytics.activity_spans sp
     where sp.workspace_id = v_ws and sp.activity_version = 'sherlock.activity.v1'
       and sp.session_id in (select l.session_id from limited l)
       and sp.started_at >= p_start - interval '12 hours' and sp.started_at < p_end
       and sp.ended_at > p_start
       and not sp.is_tombstone
       and not exists (
         select 1 from analytics.activity_spans newer
          where newer.workspace_id = sp.workspace_id and newer.activity_version = sp.activity_version
            and newer.span_key = sp.span_key and newer.valid_from_event_id > sp.valid_from_event_id)
  ), span_buckets as materialized (
    select sp.session_id, b.bucket_start,
           pg_catalog.tstzrange(greatest(sp.started_at, b.bucket_start),
             least(sp.ended_at, b.bucket_start + pg_catalog.make_interval(mins => p_bucket_minutes))) part
      from spans sp
      cross join lateral pg_catalog.generate_series(
        pg_catalog.date_bin(pg_catalog.make_interval(mins => p_bucket_minutes), sp.started_at, p_start),
        sp.ended_at, pg_catalog.make_interval(mins => p_bucket_minutes)) b(bucket_start)
     where b.bucket_start < sp.ended_at
  ), active as materialized (
    select u.session_id, u.bucket_start,
           pg_catalog.sum(extract(epoch from (pg_catalog.upper(u.part) - pg_catalog.lower(u.part))))::bigint active_seconds
      from (
        select sb.session_id, sb.bucket_start, pg_catalog.unnest(pg_catalog.range_agg(sb.part)) part
          from span_buckets sb
         where not pg_catalog.isempty(sb.part)
         group by sb.session_id, sb.bucket_start
      ) u
     group by u.session_id, u.bucket_start
  ), session_rows as materialized (
    select s.id, s.person_id, s.parent_session_id, s.actor_role, s.model, s.branch,
           pg_catalog.regexp_replace(s.repo_remote, '://[^/@]*@', '://') repo_remote,
           s.started_at, s.ended_at,
           (select case when x.normalizer_version like 'sherlock.claude-code-transcript.%' then 'claude'
                        when x.normalizer_version like 'sherlock.codex-rollout.%' then 'codex'
                        else 'unknown' end
              from telemetry.events x
             where x.workspace_id = v_ws and x.session_id = s.id
               and x.occurred_at is not null and not x.is_replay
             order by x.occurred_at desc limit 1) agent
      from telemetry.sessions s
     where s.workspace_id = v_ws and s.id in (select distinct l.session_id from limited l)
  )
  select pg_catalog.jsonb_build_object(
    'schema_version', 'sherlock.heartbeat.timeline.v1',
    'source', 'sherlock_database',
    'frame_version', v_frame,
    'window', pg_catalog.jsonb_build_object('start_inclusive', p_start, 'end_exclusive', p_end),
    'bucket_minutes', p_bucket_minutes,
    'truncated', (select pg_catalog.count(*) from all_buckets) > (select pg_catalog.count(*) from limited),
    'buckets', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'person_id', l.person_id,
        'session_key', heartbeat_api.session_key(l.session_id),
        'bucket_start', l.bucket_start,
        'agent', sr.agent,
        'actor_role', coalesce(l.actor_role, sr.actor_role),
        'first_activity_at', l.first_activity_at,
        'last_activity_at', l.last_activity_at,
        'active_seconds', coalesce(a.active_seconds, 0),
        'prompts', l.prompts,
        'tool_calls', l.tool_calls,
        'tool_results', l.tool_results,
        'tools', coalesce((
          select pg_catalog.to_jsonb(pg_catalog.array_agg(t.tool_name order by t.tool_name))
            from (select distinct ev.tool_name
                    from telemetry.events ev
                   where ev.id = any (l.tool_event_ids) and ev.tool_name is not null
                   order by ev.tool_name limit 20) t), '[]'::jsonb)
      ) order by l.bucket_start, l.session_id)
        from limited l
        left join active a on a.session_id = l.session_id and a.bucket_start = l.bucket_start
        left join session_rows sr on sr.id = l.session_id), '[]'::jsonb),
    'sessions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'session_key', heartbeat_api.session_key(sr.id),
        'parent_session_key', case when sr.parent_session_id is not null
                                   then heartbeat_api.session_key(sr.parent_session_id) end,
        'person_id', sr.person_id,
        'agent', sr.agent,
        'actor_role', sr.actor_role,
        'repo_remote', sr.repo_remote,
        'branch', sr.branch,
        'model', sr.model,
        'started_at', sr.started_at,
        'ended_at', sr.ended_at
      ) order by sr.id)
        from session_rows sr), '[]'::jsonb),
    'stats', pg_catalog.jsonb_build_object(
      'evidence_rows', (select pg_catalog.count(*) from evidence),
      'bucket_rows', (select pg_catalog.count(*) from limited),
      'bucket_rows_available', (select pg_catalog.count(*) from all_buckets),
      'session_rows', (select pg_catalog.count(*) from session_rows),
      'prompt_rows', (select pg_catalog.count(*) from first_prompts),
      'evidence_watermark', (select pg_catalog.max(e.observed_at) from evidence e)
    )
  ) into v_result;
  return v_result;
end
$body$;
comment on function heartbeat_api.timeline_activity(timestamptz, timestamptz, integer) is
  'COR-5215: activity per E3 person, session and bucket over [p_start, p_end) (at most 24 h) from frame evidence; opaque session keys, counts and tool names only.';

revoke all on function heartbeat_api.e3_workspace_id() from public;
revoke all on function heartbeat_api.hidden_sessions() from public;
revoke all on function heartbeat_api.session_key(uuid) from public;
revoke all on function heartbeat_api.people() from public;
revoke all on function heartbeat_api.usage_receipt(timestamptz, timestamptz) from public;
revoke all on function heartbeat_api.fresh_token_sessions(timestamptz, timestamptz) from public;
revoke all on function heartbeat_api.timeline_activity(timestamptz, timestamptz, integer) from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function heartbeat_api.e3_workspace_id() from anon, authenticated, service_role;
    revoke all on function heartbeat_api.hidden_sessions() from anon, authenticated, service_role;
    revoke all on function heartbeat_api.session_key(uuid) from anon, authenticated, service_role;
    revoke all on function heartbeat_api.people() from anon, authenticated, service_role;
    revoke all on function heartbeat_api.usage_receipt(timestamptz, timestamptz) from anon, authenticated, service_role;
    revoke all on function heartbeat_api.fresh_token_sessions(timestamptz, timestamptz) from anon, authenticated, service_role;
    revoke all on function heartbeat_api.timeline_activity(timestamptz, timestamptz, integer) from anon, authenticated, service_role;
  end if;
end
$revoke$;
grant execute on function heartbeat_api.people() to sherlock_presence_reader;
grant execute on function heartbeat_api.usage_receipt(timestamptz, timestamptz) to sherlock_presence_reader;
grant execute on function heartbeat_api.fresh_token_sessions(timestamptz, timestamptz) to sherlock_presence_reader;
grant execute on function heartbeat_api.timeline_activity(timestamptz, timestamptz, integer) to sherlock_presence_reader;

reset lock_timeout;
