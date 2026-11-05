-- Wide-window excerpt search names its UTC days so the combined day and text
-- GIN index (events_message_search_day_idx) serves it (COR-5172). Same
-- signature, owner, grants, privacy predicates and policy gate; windows of 25
-- hours or less keep the window-first path from 20261104223000.
do $verify$ begin perform analytics._assert_excerpt_search_policy_shape(); end $verify$;

create or replace function analytics.search_excerpt_candidates(
  p_workspace uuid,
  p_query text,
  p_start timestamptz,
  p_end timestamptz,
  p_read_at timestamptz,
  p_domain text,
  p_person uuid default null,
  p_session uuid default null,
  p_limit integer default 2000
)
returns table (event_id bigint, score real)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $search$
declare
  v_query tsquery;
  v_privacy boolean;
  v_protected_records bigint[] := '{}';
  v_hidden_sessions uuid[] := '{}';
  v_protected_people uuid[] := '{}';
  v_window_first boolean;
  v_first_message timestamptz;
  v_days date[];
begin
  -- The normal reader transaction sets this role; members that did not are refused.
  if pg_catalog.current_setting('role') is distinct from 'sherlock_reader' then
    raise exception using errcode = '42501', message = 'excerpt_search_role_required';
  end if;
  if p_workspace is null or p_query is null or p_domain is null or p_limit is null
     or p_start is null or p_end is null or p_read_at is null
     or not (pg_catalog.isfinite(p_start) and pg_catalog.isfinite(p_end) and pg_catalog.isfinite(p_read_at))
     or p_start >= p_end or p_end > p_read_at or p_read_at > pg_catalog.clock_timestamp() + interval '5 seconds'
     or p_domain not in ('e3group.ai', 'sixtyfour.ai')
     or p_limit not between 1 and 2000
     or pg_catalog.char_length(p_query) not between 2 and 256
  then
    raise exception using errcode = '22023', message = 'excerpt_search_invalid_argument';
  end if;
  -- Allow at most five seconds of app/DB clock skew; a caller cannot advance
  -- the transaction snapshot. Larger future cuts fail closed.
  -- Empty and negation-only queries cannot use the index.
  v_query := pg_catalog.websearch_to_tsquery('simple'::regconfig, p_query);
  if pg_catalog.numnode(v_query) not between 1 and 31
     or pg_catalog.querytree(v_query) in ('', 'T')
  then
    raise exception using errcode = '22023', message = 'excerpt_search_invalid_query';
  end if;

  -- The planner estimates text matches as if words were spread over every
  -- event kind, so a common word looks ~18x rarer than it is ('deploy':
  -- 3,052 estimated, 55,910 actual) and it always walks the GIN index, which
  -- has no time column: a 1-day window then visited ~44k heap blocks across
  -- all history and timed out cold. A window of 25 hours or less reads that
  -- slice of messages instead through events_message_window_idx: ~24k
  -- messages a day on Nov 4, about 2 s cold. Re-tune if a day of messages
  -- passes ~60k (cold reads then near the 10 s statement timeout). Wider
  -- windows, and a sessionId without a short window (a session may span
  -- weeks), keep the GIN path, which is right for rare words.
  v_window_first := p_end - p_start <= interval '25 hours';

  v_privacy := analytics._assert_excerpt_search_policy_shape();
  if v_privacy then
    if sherlock_access.private_principal() is distinct from false then
      raise exception using errcode = '0A000', message = 'excerpt_search_private_principal_unsupported';
    end if;
    -- array_agg keeps NULL members, so the = any tests below stay as
    -- three-valued as the policies' NOT IN.
    select coalesce(pg_catalog.array_agg(r.id), '{}') into v_protected_records
      from sherlock_access.protected_record_ids() r(id);
    select coalesce(pg_catalog.array_agg(h.id), '{}') into v_hidden_sessions
      from sherlock_access.hidden_session_ids() h(id);
    select coalesce(pg_catalog.array_agg(pp.id), '{}') into v_protected_people
      from sherlock_access.protected_person_ids() pp(id);
  end if;

  -- A wider window names its UTC days, from the first stored message on (the
  -- default window starts in 1970), so events_message_search_day_idx reads
  -- one exact day entry per day intersected with the words. A span of 400
  -- days or more (both ends counted) keeps the plain text-only match.
  if not v_window_first then
    select min(e.occurred_at) into v_first_message
      from telemetry.events e
     where e.workspace_id = p_workspace
       and e.event_kind in ('message', 'agent_message')
       and not e.is_replay
       and e.occurred_at >= p_start and e.occurred_at < p_end;
    -- No stored message in the window means no candidate either.
    if v_first_message is null then
      return;
    end if;
    if ((p_end - interval '1 microsecond') at time zone 'UTC')::date
       - (v_first_message at time zone 'UTC')::date < 400
    then
      select pg_catalog.array_agg(day::date) into v_days
        from pg_catalog.generate_series(
          (v_first_message at time zone 'UTC')::date::timestamp,
          ((p_end - interval '1 microsecond') at time zone 'UTC')::date::timestamp,
          interval '1 day'
        ) day;
    end if;
  end if;

  -- Every filter applies before the LIMIT; the subset is unordered on overflow.
  return query
  select e.id, pg_catalog.ts_rank_cd(e.message_search, v_query, 32)
    from telemetry.events e
    join telemetry.sessions s on s.workspace_id = e.workspace_id and s.id = e.session_id
    join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
   where e.workspace_id = p_workspace
     and e.event_kind in ('message', 'agent_message')
     -- force_custom_plan makes v_window_first a constant, so this folds to a
     -- plain GIN-indexable match or to one only a window index can serve.
     and case when v_window_first
              then (e.message_search operator(pg_catalog.@@) v_query) is true
              else e.message_search operator(pg_catalog.@@) v_query
         end
     and not e.is_replay
     and e.content_excerpt is not null
     -- Versioned product-view filter: runtime user envelopes cannot consume
     -- the candidate budget. This does not change canonical prompt counts.
     and (e.message_role is distinct from 'user' or e.content_excerpt !~ '^[[:space:]]*(<recommended_plugins>|<in\-app\-browser\-context|<app\-context|<skills_instructions|<permissions instructions|<permissions_instructions>|<environment_context>|<collaboration_mode>|<apps_instructions>|<plugins_instructions>|<codex_delegation>|<heartbeat>|<turn_aborted>|<automation|<skill>|\# AGENTS\.md instructions|\# Bonaparte Implementation|The configured soft phase budget has expired\.|<external_codex_apps_open_page>|The following is the Codex agent history)')
     and e.occurred_at >= p_start and e.occurred_at < p_end
     -- Folds to true, or to a day list the day index can serve; the exact
     -- bounds above still decide.
     and case when v_days is null then true
              else (e.occurred_at at time zone 'UTC')::date = any(v_days)
         end
     and e.server_received_at <= p_read_at
     and pe.github_id is distinct from 'sherlock-smoke'
     and pg_catalog.split_part(pe.email, '@', 2) = p_domain
     and pg_catalog.split_part(pe.email, '@', 3) = ''
     and (p_person is null or s.person_id = p_person)
     and (p_session is null or s.id = p_session)
     and s.actor_role not in ('guardian', 'automation')
     -- The public branch of the pinned reader policies.
     and not (e.source_record_id in (select pg_catalog.unnest(v_protected_records)))
     and (e.session_id is null or not (e.session_id in (select pg_catalog.unnest(v_hidden_sessions))))
     and (e.related_session_id is null or not (e.related_session_id in (select pg_catalog.unnest(v_hidden_sessions))))
     and not (s.id in (select pg_catalog.unnest(v_hidden_sessions)))
     and not (pe.id in (select pg_catalog.unnest(v_protected_people)))
   limit p_limit + 1;
end
$search$;

do $verify_after$ begin perform analytics._assert_excerpt_search_policy_shape(); end $verify_after$;
