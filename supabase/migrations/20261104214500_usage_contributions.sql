-- COR-5162: precomputed per-event usage contributions for query_usage.
--
-- query_usage reconciles every usage/turn_context event in each touched
-- session's full history (canonical ranking, byte-range source conflicts,
-- model context, cumulative differencing). A 1-day window touches ~200k
-- history rows plus native_records/ingest_batches joins and cannot finish in
-- the 20 s MCP budget. All of that assessment is window-independent once it
-- runs over a session's full history, so it is computed here once per session
-- and stored per usage event. The window-dependent parts stay in the query:
-- which events fall in the window, and whether a stream's first observation
-- counts (session started inside the window) or is a missing baseline.
--
-- Keeping it current:
--   * Statement triggers on telemetry.events mark a session dirty in the same
--     transaction that inserts or updates its usage/turn_context events, so a
--     late-committing event cannot be missed. Each mark carries a sequence
--     number; the refresh clears only the mark it computed from.
--   * refresh_usage_contributions() runs every minute from pg_cron. It
--     recomputes dirty sessions oldest mark first, once they have been quiet
--     for 30 s or marked for 90 s, then backfills one hour of history per run,
--     newest first. backfill_cursor is the coverage boundary: every session
--     with usage at or after it has been computed.
-- The dashboard uses the table only for windows starting at or after
-- backfill_cursor while the refresh is current and no session has waited more
-- than 5 minutes; otherwise it keeps the live query. A normalizer cutover
-- change or a new USAGE_CONTRIBUTIONS_VERSION clears the table and restarts
-- backfill.
--
-- The assessment SQL below is USAGE_ASSESSED_SQL + USAGE_CONTRIBUTIONS_SQL from
-- apps/dashboard/src/server/mcp-query-source.js, verbatim (enforced by
-- usage-contributions.test.js), evaluated with an unbounded window.
--
-- Rows are computed as the function owner, outside reader RLS. The reader sees
-- a row only while its session is visible to it (policy below), and
-- query_usage joins telemetry.sessions under RLS as before.

create table if not exists analytics.usage_contributions (
  workspace_id uuid not null,
  event_id bigint not null,
  session_id uuid not null,
  provider text not null,
  model text not null,
  usage_stream_key text,
  usage_is_cumulative boolean not null,
  usage_at timestamptz not null,
  first_in_stream boolean not null,
  regression boolean not null,
  source_uncertain boolean not null,
  excluded boolean not null,
  input_delta bigint not null,
  cached_delta bigint not null,
  output_delta bigint not null,
  reasoning_delta bigint not null,
  total_delta bigint not null,
  input_missing boolean not null,
  cached_missing boolean not null,
  output_missing boolean not null,
  reasoning_missing boolean not null,
  total_missing boolean not null,
  primary key (workspace_id, event_id)
);
comment on table analytics.usage_contributions is
  'Per-usage-event token contributions over full session history (COR-5162); query_usage sums a window of these.';
create index if not exists usage_contributions_window_idx
  on analytics.usage_contributions (workspace_id, usage_at);
create index if not exists usage_contributions_session_idx
  on analytics.usage_contributions (workspace_id, session_id);

create table if not exists analytics.usage_contribution_sessions (
  workspace_id uuid not null,
  session_id uuid not null,
  computed_at timestamptz not null default now(),
  primary key (workspace_id, session_id)
);

create sequence if not exists analytics.usage_contribution_mark_seq;
create table if not exists analytics.usage_contribution_dirty (
  workspace_id uuid not null,
  session_id uuid not null,
  mark_seq bigint not null,
  first_marked_at timestamptz not null,
  last_marked_at timestamptz not null,
  primary key (workspace_id, session_id)
);
create index if not exists usage_contribution_dirty_first_marked_idx
  on analytics.usage_contribution_dirty (workspace_id, first_marked_at);

create table if not exists analytics.usage_contribution_state (
  workspace_id uuid primary key,
  backfill_cursor timestamptz not null,
  backfill_floor timestamptz,
  cutover_fingerprint text not null,
  refreshed_at timestamptz
);

alter table analytics.usage_contributions enable row level security;
alter table analytics.usage_contribution_sessions enable row level security;
alter table analytics.usage_contribution_state enable row level security;
alter table analytics.usage_contribution_dirty enable row level security;
revoke all on table analytics.usage_contributions, analytics.usage_contribution_sessions,
  analytics.usage_contribution_state, analytics.usage_contribution_dirty from public;
revoke all on sequence analytics.usage_contribution_mark_seq from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table analytics.usage_contributions, analytics.usage_contribution_sessions,
      analytics.usage_contribution_state, analytics.usage_contribution_dirty
      from anon, authenticated, service_role;
    revoke all on sequence analytics.usage_contribution_mark_seq from anon, authenticated, service_role;
  end if;
end
$revoke$;
grant select on table analytics.usage_contributions, analytics.usage_contribution_state,
  analytics.usage_contribution_dirty to sherlock_reader;
drop policy if exists usage_contributions_reader_select on analytics.usage_contributions;
create policy usage_contributions_reader_select on analytics.usage_contributions
  for select to sherlock_reader using (exists (
    select 1 from telemetry.sessions s
     where s.workspace_id = usage_contributions.workspace_id and s.id = usage_contributions.session_id
  ));
drop policy if exists usage_contribution_state_reader_select on analytics.usage_contribution_state;
create policy usage_contribution_state_reader_select on analytics.usage_contribution_state
  for select to sherlock_reader using (true);
drop policy if exists usage_contribution_dirty_reader_select on analytics.usage_contribution_dirty;
create policy usage_contribution_dirty_reader_select on analytics.usage_contribution_dirty
  for select to sherlock_reader using (true);

create or replace function analytics.usage_cutover_fingerprint(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $body$
-- USAGE_CONTRIBUTIONS_VERSION: bump in any migration that replaces the
-- assessment in compute_usage_contributions(), so stored rows are rebuilt.
select pg_catalog.md5('usage-contributions-v1:' || coalesce(pg_catalog.string_agg(
  c.source_provider || '|' || c.from_normalizer_version || '|' || c.to_normalizer_version || '|'
    || pg_catalog.extract(epoch from c.cutover_at)::text,
  ',' order by c.source_provider, c.to_normalizer_version), ''))
  from analytics.normalizer_cutovers c
 where c.workspace_id = p_workspace_id
$body$;

-- Recompute every listed session from its full history. Returns rows written.
create or replace function analytics.compute_usage_contributions(p_workspace_id uuid, p_session_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_written integer;
begin
  if p_workspace_id is null or p_session_ids is null or pg_catalog.cardinality(p_session_ids) = 0 then
    return 0;
  end if;
  insert into analytics.usage_contribution_sessions as cs (workspace_id, session_id, computed_at)
  select p_workspace_id, ids.session_id, pg_catalog.now()
    from pg_catalog.unnest(p_session_ids) ids(session_id)
  on conflict (workspace_id, session_id) do update set computed_at = excluded.computed_at;

  delete from analytics.usage_contributions u
   where u.workspace_id = p_workspace_id and u.session_id = any (p_session_ids);

  with p as not materialized (
    select p_workspace_id workspace_id, '-infinity'::timestamptz start_at,
           'infinity'::timestamptz end_at
  ), eligible_sessions as materialized (
    select s.id session_id, s.person_id, null::text display_name, s.started_at,
           exists (
    select 1 from telemetry.events preferred
     where preferred.workspace_id = s.workspace_id
       and preferred.session_id = s.id
       and preferred.event_kind = 'usage' and not preferred.is_replay
       and preferred.event_subtype = 'token_count'
       and preferred.normalizer_version in (
         'sherlock.codex-rollout.v1', 'sherlock.codex-rollout.v2',
         'sherlock.codex-rollout.v3', 'sherlock.codex-rollout.v4'
       )
  ) has_token_count
      from telemetry.sessions s
     where s.workspace_id = p_workspace_id and s.id = any (p_session_ids)
  ), candidates as not materialized (
  select e.id, e.session_id, s.person_id, s.display_name, s.started_at,
         e.normalizer_version, e.event_kind, e.event_subtype, e.projection_index,
         e.canonical_scope_key, e.logical_event_key, e.usage_stream_key, e.usage_is_cumulative,
         e.model recorded_model, e.source_priority,
         case when ib.source_provider = 'claude_code' then 'claude' else 'codex' end provider,
         e.input_tokens, e.cached_input_tokens, e.output_tokens,
         e.reasoning_tokens, e.total_tokens, e.occurred_at usage_at,
         coalesce(nr.native_record_start_offset, nr.source_start_offset) native_start,
         coalesce(nr.native_record_end_offset, nr.source_end_offset) native_end,
         coalesce(nr.native_record_sha256, nr.record_sha256) native_hash,
         (e.occurred_at >= p.start_at and e.occurred_at < p.end_at) in_window
    from eligible_sessions s
    join telemetry.events e on e.session_id = s.session_id
    join telemetry.native_records nr
      on nr.workspace_id = e.workspace_id and nr.id = e.source_record_id
    join telemetry.ingest_batches ib
      on ib.workspace_id = nr.workspace_id and ib.id = nr.batch_id
    left join analytics.normalizer_cutovers c
      on c.workspace_id = e.workspace_id and c.source_provider = ib.source_provider
     and c.to_normalizer_version = 'sherlock.codex-rollout.v2'
    cross join p
   where e.workspace_id = p.workspace_id and not e.is_replay
     and s.started_at < p.end_at
     and (e.event_kind = 'usage' or
          e.event_kind = 'lifecycle' and e.event_subtype = 'turn_context')
     and case when ib.source_provider = 'claude_code'
    then e.normalizer_version = 'sherlock.claude-code-transcript.v1'
    when ib.source_provider = 'codex'
    then (
    ib.source_provider = 'claude_code'
    and e.normalizer_version = 'sherlock.claude-code-transcript.v1'
    or ib.source_provider = 'codex'
    and (
      e.normalizer_version = 'sherlock.codex-rollout.v4'
      or not exists (
        select 1 from telemetry.events upgraded
         where upgraded.workspace_id = e.workspace_id
           and upgraded.source_record_id = e.source_record_id
           and upgraded.normalizer_version = 'sherlock.codex-rollout.v4'
           and not upgraded.is_replay
      ) and (
      e.normalizer_version = 'sherlock.codex-rollout.v3'
      or not exists (
        select 1 from telemetry.events corrected
         where corrected.workspace_id = e.workspace_id
           and corrected.source_record_id = e.source_record_id
           and corrected.normalizer_version = 'sherlock.codex-rollout.v3'
           and not corrected.is_replay
      ) and (
      (c.cutover_at is null
       or s.started_at >= c.cutover_at)
      and e.normalizer_version = 'sherlock.codex-rollout.v2'
      or s.started_at < c.cutover_at
      and (
        e.normalizer_version = 'sherlock.codex-rollout.v1'
        or e.normalizer_version = 'sherlock.codex-rollout.v2'
        and not exists (
          select 1 from telemetry.events legacy
           where legacy.workspace_id = e.workspace_id
             and legacy.source_record_id = e.source_record_id
             and legacy.normalizer_version = 'sherlock.codex-rollout.v1'
             and not legacy.is_replay
        )
      )
      )
      )
    )
  )
    else false end
     and (e.event_subtype is distinct from 'token_usage_record' or not s.has_token_count)
), canonical_ranked as not materialized (
  select *, row_number() over (
    partition by session_id, normalizer_version, canonical_scope_key, logical_event_key, event_kind
    order by source_priority desc, usage_at, id
  ) canonical_rank
  from candidates
), canonical_events as not materialized (
  select * from canonical_ranked
   where canonical_rank = 1 or canonical_scope_key is null or logical_event_key is null
), position_assessed as not materialized (
  -- Peer groups are distinct native byte ranges. GROUPS frames assess adjacent
  -- ranges without joining a wide event history back to its grouped positions.
  select *, min(native_hash) over position_peers <> max(native_hash) over position_peers
    or coalesce(max(native_end) over (
      position_order groups between unbounded preceding and 1 preceding
    ) > native_start, false)
    or coalesce(min(native_start) over (
      position_order groups between 1 following and 1 following
    ) < native_end, false) source_conflict
    from canonical_events
  window position_peers as (
    partition by session_id, provider, canonical_scope_key, native_start, native_end
  ), position_order as (
    partition by session_id, provider, canonical_scope_key order by native_start, native_end
  )
), ranked as not materialized (
  select *, row_number() over (
    partition by session_id, provider, canonical_scope_key,
      native_start, native_end, native_hash, event_kind, projection_index
    order by source_priority desc, id
  ) source_rank
  from position_assessed
), native_events as not materialized (
  select * from ranked where source_rank = 1
), contextualized as not materialized (
  select *,
         count(*) filter (where event_subtype = 'turn_context') over source_order context_number,
         bool_or(source_conflict) over source_order source_uncertain
    from native_events
  window source_order as (
    partition by session_id, provider, canonical_scope_key
    order by native_start, native_end, id rows unbounded preceding
  )
), attributed as not materialized (
  select *, case when provider = 'claude'
                then coalesce(nullif(btrim(recorded_model), ''), 'unknown')
                when source_uncertain then 'unknown'
                else coalesce(max(nullif(btrim(recorded_model), '')) filter (
                  where event_subtype = 'turn_context'
                ) over (partition by session_id, provider, canonical_scope_key, context_number), 'unknown')
           end model
    from contextualized
), usage_attributed as materialized (
  -- Incremental facts need source/model assessment, but no cumulative windows.
  -- Retain only fields needed by arithmetic before sharing the two branches.
  select id, session_id, person_id, display_name, started_at, provider, model, normalizer_version,
         usage_stream_key, usage_is_cumulative, input_tokens, cached_input_tokens,
         output_tokens, reasoning_tokens, total_tokens, usage_at, native_start,
         native_end, in_window, source_uncertain
    from attributed where event_kind = 'usage'
), ordered as not materialized (
  select *,
         -- Cache writes were included in uncached input before v4. Across that
         -- boundary the component baseline is unknowable without reprocessing;
         -- inclusive totals/output remain comparable in the same stream.
         case when provider = 'codex' and
           (normalizer_version = 'sherlock.codex-rollout.v4') is distinct from
           (lag(normalizer_version) over stream_order = 'sherlock.codex-rollout.v4')
           then null else lag(input_tokens) over stream_order end previous_input,
         case when provider = 'codex' and
           (normalizer_version = 'sherlock.codex-rollout.v4') is distinct from
           (lag(normalizer_version) over stream_order = 'sherlock.codex-rollout.v4')
           then null else lag(cached_input_tokens) over stream_order end previous_cached,
         lag(output_tokens) over stream_order previous_output,
         lag(reasoning_tokens) over stream_order previous_reasoning,
         lag(total_tokens) over stream_order previous_total,
         lag(id) over stream_order previous_id
    from usage_attributed where usage_is_cumulative
  window stream_order as (
    partition by session_id, provider, usage_stream_key, usage_is_cumulative
    order by native_start, native_end, id
  )
), assessed_cumulative as not materialized (
  select *, bool_or(
    usage_is_cumulative and previous_id is not null and (
      input_tokens < previous_input or cached_input_tokens < previous_cached
      or output_tokens < previous_output or reasoning_tokens < previous_reasoning
      or total_tokens < previous_total
    )
  ) over (
    partition by session_id, provider, usage_stream_key, usage_is_cumulative
    order by native_start, native_end, id rows unbounded preceding
  ) stream_regressed,
    (usage_is_cumulative and previous_id is null
      and started_at < (select start_at from p)) missing_baseline
  from ordered
), assessed as not materialized (
  select * from assessed_cumulative
  union all
  select *, null::bigint previous_input, null::bigint previous_cached,
         null::bigint previous_output, null::bigint previous_reasoning,
         null::bigint previous_total, null::bigint previous_id,
         false stream_regressed, false missing_baseline
    from usage_attributed where not usage_is_cumulative
), contributions as not materialized (
  select *,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(input_tokens, 0)
         when previous_id is not null and previous_input is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(input_tokens, previous_input, 0) - coalesce(previous_input, 0), 0)
    end input_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(cached_input_tokens, 0)
         when previous_id is not null and previous_cached is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(cached_input_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(cached_input_tokens, previous_cached, 0) - coalesce(previous_cached, 0), 0)
    end cached_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(output_tokens, 0)
         when previous_id is not null and previous_output is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(output_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(output_tokens, previous_output, 0) - coalesce(previous_output, 0), 0)
    end output_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(reasoning_tokens, 0)
         when previous_id is not null and previous_reasoning is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(reasoning_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(reasoning_tokens, previous_reasoning, 0) - coalesce(previous_reasoning, 0), 0)
    end reasoning_delta,
    case when stream_regressed or source_uncertain then 0
         when not usage_is_cumulative then coalesce(total_tokens, 0)
         when previous_id is not null and previous_total is null then 0
         when previous_id is null and started_at >= (select start_at from p)
           then coalesce(total_tokens, 0)
         when previous_id is null then 0
         else greatest(coalesce(total_tokens, previous_total, 0) - coalesce(previous_total, 0), 0)
    end total_delta,
    stream_regressed regression
  from assessed where in_window
)
  insert into analytics.usage_contributions (
    workspace_id, event_id, session_id, provider, model, usage_stream_key,
    usage_is_cumulative, usage_at, first_in_stream, regression, source_uncertain, excluded,
    input_delta, cached_delta, output_delta, reasoning_delta, total_delta,
    input_missing, cached_missing, output_missing, reasoning_missing, total_missing
  )
  select p_workspace_id, c.id, c.session_id, c.provider, c.model, c.usage_stream_key,
         c.usage_is_cumulative, c.usage_at,
         c.usage_is_cumulative and c.previous_id is null,
         c.regression, c.source_uncertain,
         c.regression or c.source_uncertain
           or c.input_tokens is null or c.cached_input_tokens is null or c.output_tokens is null
           or c.reasoning_tokens is null or c.total_tokens is null
           or c.usage_is_cumulative and c.previous_id is not null and (
             c.previous_input is null or c.previous_cached is null or c.previous_output is null
             or c.previous_reasoning is null or c.previous_total is null
           ),
         c.input_delta, c.cached_delta, c.output_delta, c.reasoning_delta, c.total_delta,
         c.input_tokens is null or c.usage_is_cumulative and c.previous_id is not null and c.previous_input is null,
         c.cached_input_tokens is null or c.usage_is_cumulative and c.previous_id is not null and c.previous_cached is null,
         c.output_tokens is null or c.usage_is_cumulative and c.previous_id is not null and c.previous_output is null,
         c.reasoning_tokens is null or c.usage_is_cumulative and c.previous_id is not null and c.previous_reasoning is null,
         c.total_tokens is null or c.usage_is_cumulative and c.previous_id is not null and c.previous_total is null
    from contributions c;
  get diagnostics v_written = row_count;
  return v_written;
end
$body$;

-- One bounded refresh step per workspace: incremental first, then backfill.
create or replace function analytics.refresh_usage_contributions(
  p_max_sessions integer default 40,
  p_backfill_step interval default interval '1 hour'
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_workspace uuid;
  v_state analytics.usage_contribution_state;
  v_fingerprint text;
  v_sessions uuid[];
  v_dirty uuid[];
  v_marks bigint[];
  v_total integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('sherlock.usage_contributions')) then
    return 0;
  end if;
  for v_workspace in select w.id from telemetry.workspaces w order by w.id loop
    v_fingerprint := analytics.usage_cutover_fingerprint(v_workspace);
    select * into v_state from analytics.usage_contribution_state st
     where st.workspace_id = v_workspace for update;

    if not found or v_state.cutover_fingerprint is distinct from v_fingerprint then
      delete from analytics.usage_contributions u where u.workspace_id = v_workspace;
      delete from analytics.usage_contribution_sessions cs where cs.workspace_id = v_workspace;
      insert into analytics.usage_contribution_state as st (
        workspace_id, backfill_cursor, backfill_floor, cutover_fingerprint, refreshed_at
      ) values (
        v_workspace,
        greatest(pg_catalog.now(), coalesce((
          select e.occurred_at from telemetry.events e
           where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
             and e.occurred_at is not null
           order by e.occurred_at desc limit 1), pg_catalog.now())) + interval '1 second',
        (select e.occurred_at from telemetry.events e
          where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
            and e.occurred_at is not null
          order by e.occurred_at limit 1),
        v_fingerprint, null
      )
      on conflict (workspace_id) do update set
        backfill_cursor = excluded.backfill_cursor,
        backfill_floor = excluded.backfill_floor, cutover_fingerprint = excluded.cutover_fingerprint,
        refreshed_at = null;
      select * into v_state from analytics.usage_contribution_state st where st.workspace_id = v_workspace;
    end if;

    -- 1. Dirty sessions, oldest mark first, once quiet for 30 s or marked
    -- for 90 s. Only the mark that was read is cleared: a session marked again
    -- meanwhile has a new mark_seq and stays dirty.
    select pg_catalog.array_agg(t.session_id order by t.first_marked_at),
           pg_catalog.array_agg(t.mark_seq order by t.first_marked_at)
      into v_dirty, v_marks
      from (
        select d.session_id, d.mark_seq, d.first_marked_at
          from analytics.usage_contribution_dirty d
         where d.workspace_id = v_workspace
           and (d.last_marked_at < pg_catalog.now() - interval '30 seconds'
                or d.first_marked_at < pg_catalog.now() - interval '90 seconds')
         order by d.first_marked_at
         limit p_max_sessions
      ) t;
    v_total := v_total + analytics.compute_usage_contributions(v_workspace, v_dirty);

    -- 2. Backfill one step of history, newest first.
    if v_state.backfill_floor is not null and v_state.backfill_cursor > v_state.backfill_floor then
      select pg_catalog.array_agg(t.session_id) into v_sessions from (
        select distinct e.session_id
          from telemetry.events e
         where e.workspace_id = v_workspace and e.event_kind = 'usage' and not e.is_replay
           and e.occurred_at >= v_state.backfill_cursor - p_backfill_step
           and e.occurred_at < v_state.backfill_cursor
           and e.session_id is not null
           and not exists (
             select 1 from analytics.usage_contribution_sessions cs
              where cs.workspace_id = v_workspace and cs.session_id = e.session_id)
         limit p_max_sessions
      ) t;
      v_total := v_total + analytics.compute_usage_contributions(v_workspace, v_sessions);
      if coalesce(pg_catalog.cardinality(v_sessions), 0) < p_max_sessions then
        update analytics.usage_contribution_state st
           set backfill_cursor = st.backfill_cursor - p_backfill_step
         where st.workspace_id = v_workspace;
      end if;
    end if;

    update analytics.usage_contribution_state st set refreshed_at = pg_catalog.now()
     where st.workspace_id = v_workspace;
    -- Last, so a concurrent ingest waits on these row locks only until commit.
    if v_dirty is not null then
      delete from analytics.usage_contribution_dirty d
       using pg_catalog.unnest(v_dirty, v_marks) m(session_id, mark_seq)
       where d.workspace_id = v_workspace and d.session_id = m.session_id
         and d.mark_seq = m.mark_seq;
    end if;
  end loop;
  return v_total;
end
$body$;

revoke all on function analytics.usage_cutover_fingerprint(uuid) from public;
revoke all on function analytics.compute_usage_contributions(uuid, uuid[]) from public;
revoke all on function analytics.refresh_usage_contributions(integer, interval) from public;
do $revoke_functions$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function analytics.usage_cutover_fingerprint(uuid) from anon, authenticated, service_role;
    revoke all on function analytics.compute_usage_contributions(uuid, uuid[]) from anon, authenticated, service_role;
    revoke all on function analytics.refresh_usage_contributions(integer, interval) from anon, authenticated, service_role;
  end if;
end
$revoke_functions$;

-- Statement-level, so one ingest statement upserts each touched session once,
-- in session order (concurrent statements lock dirty rows in the same order).
create or replace function analytics.mark_usage_contribution_sessions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  insert into analytics.usage_contribution_dirty as d (
    workspace_id, session_id, mark_seq, first_marked_at, last_marked_at
  )
  select t.workspace_id, t.session_id, pg_catalog.nextval('analytics.usage_contribution_mark_seq'),
         pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    from (
      select distinct n.workspace_id, n.session_id
        from changed_events n
       where n.session_id is not null
         and (n.event_kind = 'usage' or n.event_kind = 'lifecycle' and n.event_subtype = 'turn_context')
       order by n.workspace_id, n.session_id
    ) t
  on conflict (workspace_id, session_id) do update
     set mark_seq = excluded.mark_seq, last_marked_at = excluded.last_marked_at;
  return null;
end
$body$;
revoke all on function analytics.mark_usage_contribution_sessions() from public;

drop trigger if exists events_mark_usage_contributions_insert on telemetry.events;
create trigger events_mark_usage_contributions_insert
  after insert on telemetry.events
  referencing new table as changed_events
  for each statement execute function analytics.mark_usage_contribution_sessions();
drop trigger if exists events_mark_usage_contributions_update on telemetry.events;
create trigger events_mark_usage_contributions_update
  after update on telemetry.events
  referencing new table as changed_events
  for each statement execute function analytics.mark_usage_contribution_sessions();

create extension if not exists pg_cron;
select cron.schedule(
  'sherlock-usage-contributions',
  '* * * * *',
  $cron$ select analytics.refresh_usage_contributions(); $cron$
);
