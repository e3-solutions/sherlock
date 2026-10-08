-- Acquire the policy change locks before reading/defining helpers. Busy live writers
-- cause a bounded transactional failure; retry the complete migration unchanged.
set local lock_timeout = '10s';
lock table telemetry.people, telemetry.ingest_batches, telemetry.native_records,
 telemetry.sessions, telemetry.events, telemetry.session_scm,
 analytics.activity_spans, analytics.frame_projection_receipts,
 analytics.frame_evidence_revisions, github.commit_pr_lookups
 in access exclusive mode;
-- Product read isolation; immutable telemetry and infrastructure writer grants remain intact.
create schema if not exists sherlock_access;
revoke all on schema sherlock_access from public, anon, authenticated;
create table sherlock_access.restricted_emails (
 email text primary key check (email = lower(btrim(email))),
 created_at timestamptz not null default now()
);
create table sherlock_access.restricted_people (
 workspace_id uuid not null, person_id uuid not null,
 email text not null references sherlock_access.restricted_emails(email),
 created_at timestamptz not null default now(),
 primary key(workspace_id, person_id)
);
insert into sherlock_access.restricted_emails(email) values ('aqil@e3group.ai');
insert into sherlock_access.restricted_people(workspace_id, person_id, email)
 select workspace_id,id,email from telemetry.people where email='aqil@e3group.ai';
revoke all on all tables in schema sherlock_access from public, anon, authenticated, sherlock_reader;
create function sherlock_access.pin_restricted_person() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into sherlock_access.restricted_people(workspace_id,person_id,email)
 select new.workspace_id,new.id,new.email
 where exists(select 1 from sherlock_access.restricted_emails where email=new.email)
 on conflict do nothing;
 return new;
end $$;
revoke all on function sherlock_access.pin_restricted_person() from public;
create trigger pin_restricted_person after insert or update of email on telemetry.people
 for each row execute function sherlock_access.pin_restricted_person();
-- Dedicated principal is provisioned with its secret separately; never grant it to the shared login.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='sherlock_aqil_private_login') then
  create role sherlock_aqil_private_login login noinherit;
 end if;
end $$;
grant sherlock_reader to sherlock_aqil_private_login;
create function sherlock_access.person_visible(w uuid,p uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (exists(select 1 from sherlock_access.restricted_people r
 where r.workspace_id=w and r.person_id=p)) =
 (session_user='sherlock_aqil_private_login' and pg_has_role(session_user,'sherlock_reader','member'))
 and exists(select 1 from telemetry.people pe where pe.workspace_id=w and pe.id=p)
$$;
create function sherlock_access.session_visible(w uuid,s uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from telemetry.sessions se where se.workspace_id=w and se.id=s
 and sherlock_access.person_visible(w,se.person_id)
 and (se.parent_session_id is null or exists(select 1 from telemetry.sessions parent
 where parent.workspace_id=w and parent.id=se.parent_session_id
 and sherlock_access.person_visible(w,parent.person_id))))
$$;
create function sherlock_access.batch_visible(w uuid,b uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from telemetry.ingest_batches ba where ba.workspace_id=w and ba.id=b
 and sherlock_access.person_visible(w,ba.person_id))
$$;
create function sherlock_access.record_visible(w uuid,r bigint) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from telemetry.native_records nr where nr.workspace_id=w and nr.id=r
 and sherlock_access.batch_visible(w,nr.batch_id))
$$;
grant usage on schema sherlock_access to sherlock_reader;
revoke all on all functions in schema sherlock_access from public, anon, authenticated;
grant execute on function sherlock_access.person_visible(uuid,uuid),
 sherlock_access.session_visible(uuid,uuid), sherlock_access.batch_visible(uuid,uuid),
 sherlock_access.record_visible(uuid,bigint) to sherlock_reader;

alter table telemetry.people enable row level security;
create policy sherlock_product_reader on telemetry.people for select to sherlock_reader using (sherlock_access.person_visible(workspace_id,id));
create policy sherlock_infrastructure on telemetry.people to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table telemetry.sessions enable row level security;
create policy sherlock_product_reader on telemetry.sessions for select to sherlock_reader using (sherlock_access.session_visible(workspace_id,id));
create policy sherlock_infrastructure on telemetry.sessions to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table telemetry.ingest_batches enable row level security;
create policy sherlock_product_reader on telemetry.ingest_batches for select to sherlock_reader using (sherlock_access.person_visible(workspace_id,person_id));
create policy sherlock_infrastructure on telemetry.ingest_batches to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table telemetry.native_records enable row level security;
create policy sherlock_product_reader on telemetry.native_records for select to sherlock_reader using (sherlock_access.batch_visible(workspace_id,batch_id));
create policy sherlock_infrastructure on telemetry.native_records to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table telemetry.events enable row level security;
create policy sherlock_product_reader on telemetry.events for select to sherlock_reader using (sherlock_access.record_visible(workspace_id,source_record_id) and (session_id is null or sherlock_access.session_visible(workspace_id,session_id)) and (related_session_id is null or sherlock_access.session_visible(workspace_id,related_session_id)));
create policy sherlock_infrastructure on telemetry.events to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table telemetry.session_scm enable row level security;
create policy sherlock_product_reader on telemetry.session_scm for select to sherlock_reader using (sherlock_access.session_visible(workspace_id,session_id) and sherlock_access.record_visible(workspace_id,source_record_id));
create policy sherlock_infrastructure on telemetry.session_scm to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table analytics.activity_spans enable row level security;
create policy sherlock_product_reader on analytics.activity_spans for select to sherlock_reader using (sherlock_access.person_visible(workspace_id,person_id) and sherlock_access.session_visible(workspace_id,session_id));
create policy sherlock_infrastructure on analytics.activity_spans to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table analytics.frame_projection_receipts enable row level security;
create policy sherlock_product_reader on analytics.frame_projection_receipts for select to sherlock_reader using (sherlock_access.person_visible(workspace_id,person_id) and sherlock_access.session_visible(workspace_id,session_id));
create policy sherlock_infrastructure on analytics.frame_projection_receipts to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table analytics.frame_evidence_revisions enable row level security;
create policy sherlock_product_reader on analytics.frame_evidence_revisions for select to sherlock_reader using (sherlock_access.person_visible(workspace_id,person_id) and sherlock_access.session_visible(workspace_id,session_id));
create policy sherlock_infrastructure on analytics.frame_evidence_revisions to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

alter table github.commit_pr_lookups enable row level security;
create policy sherlock_product_reader on github.commit_pr_lookups for select to sherlock_reader using (exists(select 1 from telemetry.session_scm scm where scm.workspace_id=commit_pr_lookups.workspace_id and scm.repository_full_name=commit_pr_lookups.repository_full_name and scm.commit_sha=commit_pr_lookups.commit_sha));
create policy sherlock_infrastructure on github.commit_pr_lookups to sherlock_ingest, sherlock_normalizer, sherlock_processor, sherlock_reducer, sherlock_frame_projector using (true) with check (true);

create or replace function analytics.read_dashboard_freshness(
  p_workspace_id uuid,
  p_expected_email_domain text,
  p_normalizer_versions text[],
  p_max_people integer
)
returns table (
  read_at timestamptz,
  raw_watermark timestamptz,
  canonical_watermark timestamptz,
  oldest_pending_normalize timestamptz,
  pending_normalize_count bigint,
  person_id uuid,
  latest_canonical_activity timestamptz
)
language sql
stable
security definer
set search_path = ''
set enable_nestloop = off
set enable_seqscan = off
as $$
with p as materialized (
    select p_workspace_id workspace_id,
           transaction_timestamp() read_at,
           p_expected_email_domain expected_email_domain
     where p_workspace_id is not null
       and p_expected_email_domain in ('e3group.ai', 'sixtyfour.ai')
       and cardinality(p_normalizer_versions) between 1 and 16
       and p_max_people between 1 and 1000
  ), roster as materialized (
    select pe.id person_id
      from telemetry.people pe
      cross join p
     where pe.workspace_id = p_workspace_id
       and sherlock_access.person_visible(pe.workspace_id, pe.id)
       and pe.github_id is distinct from 'sherlock-smoke'
       and split_part(pe.email, '@', 2) = p.expected_email_domain
       and split_part(pe.email, '@', 3) = ''
     order by lower(coalesce(nullif(btrim(pe.display_name), ''), pe.identity_key)), pe.id
     limit p_max_people + 1
  ), activity_candidates as materialized (
    select s.person_id, e.id, e.session_id, s.started_at session_started_at,
           e.server_received_at,
           coalesce(
             case
               when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then to_timestamp((
                 ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
               ) / 1000.0)
               else null
             end,
             coalesce(e.occurred_at, e.observed_at, e.server_received_at)
           ) observed_at,
           case when e.canonical_scope_key is not null and e.logical_event_key is not null
                then row_number() over (
                  partition by e.session_id, e.canonical_scope_key,
                               e.normalizer_version, e.logical_event_key, e.event_kind
                  order by e.source_priority desc, e.occurred_at asc nulls last, e.id
                ) else 1 end canonical_rank
      from telemetry.events e
      join telemetry.sessions s
        on s.workspace_id = e.workspace_id and s.id = e.session_id
      join roster r on r.person_id = s.person_id
      cross join p
     where e.workspace_id = p_workspace_id
       and sherlock_access.session_visible(e.workspace_id, e.session_id)
       and sherlock_access.record_visible(e.workspace_id, e.source_record_id)
       and (e.related_session_id is null or sherlock_access.session_visible(e.workspace_id, e.related_session_id))
       and e.normalizer_version = any(p_normalizer_versions)
       and not e.is_replay
       and e.actor_role <> 'automation'
       and e.event_kind in (
         'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
         'agent_message', 'lifecycle', 'error'
       )
       and (e.event_kind <> 'message' or e.native_item_id is not null or e.event_subtype = 'user_message')
       and (e.event_kind <> 'lifecycle' or e.event_subtype in ('task_started', 'task_complete', 'turn_started', 'turn_complete'))
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) >= transaction_timestamp() - interval '30 minutes'
       and coalesce(
         case
           when e.native_item_id ~ '^[a-z][a-z0-9]*_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then to_timestamp((
             ('x' || replace(substring(e.native_item_id from '[0-9a-f]{8}-[0-9a-f]{4}'), '-', ''))::bit(48)::bigint
           ) / 1000.0)
           else null
         end,
         coalesce(e.occurred_at, e.observed_at, e.server_received_at)
       ) < transaction_timestamp()
  ), latest_activity as materialized (
    select r.person_id, max(a.observed_at) latest_canonical_activity
      from roster r
      left join activity_candidates a
        on a.person_id = r.person_id
       and a.canonical_rank = 1
       and a.observed_at >= date_trunc('milliseconds', a.session_started_at)
     group by r.person_id
  ), pending_freshness as materialized (
    select min(b.committed_at) oldest_pending_normalize,
           count(*) pending_normalize_count
      from processing.telemetry_jobs j
      join telemetry.ingest_batches b
        on b.workspace_id = j.workspace_id and b.id = j.batch_id
      join roster r on r.person_id = b.person_id
      cross join p
     where j.workspace_id = p.workspace_id
       and j.job_kind = 'normalize'
       and j.workload_class = 'live'
       and j.status in ('queued', 'leased')
  ), global_freshness as materialized (
    select p.read_at,
           (
             select max(latest.committed_at)
               from roster r
               cross join lateral (
                 select b.committed_at
                   from telemetry.ingest_batches b
                  where b.workspace_id = p.workspace_id
                    and b.person_id = r.person_id
                  order by b.committed_at desc, b.id desc
                  limit 1
               ) latest
           ) raw_watermark,
           (
             select max(a.server_received_at)
               from activity_candidates a
              where a.canonical_rank = 1
           ) canonical_watermark,
           pending.oldest_pending_normalize,
           pending.pending_normalize_count
      from p
      cross join pending_freshness pending
  )
  select g.read_at, g.raw_watermark, g.canonical_watermark,
         g.oldest_pending_normalize, g.pending_normalize_count,
         a.person_id, a.latest_canonical_activity
    from global_freshness g
    left join latest_activity a on true
   order by a.person_id;
$$;

-- CREATE OR REPLACE preserves ownership and existing ACLs; restate the intended
-- reader-only boundary so a fresh installation has the same privileges.
revoke all on function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  from public, anon, authenticated, service_role,
       sherlock_ingest, sherlock_normalizer, sherlock_reducer, sherlock_processor;
grant execute on function analytics.read_dashboard_freshness(uuid, text, text[], integer)
  to sherlock_reader;
