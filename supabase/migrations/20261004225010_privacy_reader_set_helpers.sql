set local lock_timeout='90s';
create function sherlock_access.private_principal() returns boolean
language sql stable security definer set search_path='' as $$
 select session_user='sherlock_aqil_private_login'
 and pg_has_role(session_user,'sherlock_reader','member')
$$;
create function sherlock_access.protected_person_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
 select person_id from sherlock_access.restricted_people
$$;
create function sherlock_access.protected_batch_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
 select b.id from telemetry.ingest_batches b
 join sherlock_access.restricted_people r on r.workspace_id=b.workspace_id and r.person_id=b.person_id
$$;
create function sherlock_access.protected_record_ids() returns setof bigint
language sql stable security definer set search_path='' as $$
 select n.id from sherlock_access.restricted_people r
 join telemetry.ingest_batches b on b.workspace_id=r.workspace_id and b.person_id=r.person_id
 join telemetry.native_records n on n.workspace_id=b.workspace_id and n.batch_id=b.id
$$;
-- Public readers also hide sessions carrying a private parent's ID.
create function sherlock_access.hidden_session_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 union
 select child.id from telemetry.sessions parent
 join sherlock_access.restricted_people r on r.workspace_id=parent.workspace_id and r.person_id=parent.person_id
 join telemetry.sessions child on child.workspace_id=parent.workspace_id and child.parent_session_id=parent.id
$$;
-- Private readers see protected ownership only, including allowed parent links.
create function sherlock_access.private_session_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 where s.parent_session_id is null or exists(
 select 1 from telemetry.sessions parent
 join sherlock_access.restricted_people pr on pr.workspace_id=parent.workspace_id and pr.person_id=parent.person_id
 where parent.workspace_id=s.workspace_id and parent.id=s.parent_session_id)
$$;
revoke all on function sherlock_access.private_principal(),
 sherlock_access.protected_person_ids(), sherlock_access.protected_batch_ids(),
 sherlock_access.protected_record_ids(), sherlock_access.hidden_session_ids(),
 sherlock_access.private_session_ids() from public,anon,authenticated;
grant execute on function sherlock_access.private_principal(),
 sherlock_access.protected_person_ids(), sherlock_access.protected_batch_ids(),
 sherlock_access.protected_record_ids(), sherlock_access.hidden_session_ids(),
 sherlock_access.private_session_ids() to sherlock_reader;
