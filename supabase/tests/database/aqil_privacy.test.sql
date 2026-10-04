-- Run as migration owner (postgres) using psql -v ON_ERROR_STOP=1 -f this file.
-- Fixture and role changes roll back. Uses actual session_user, not a spoofable GUC.
begin;
insert into telemetry.workspaces(id,slug,name)
values ('a4110000-0000-4000-8000-000000000001','aqil-privacy-proof','Privacy proof');
insert into telemetry.people(id,workspace_id,identity_key,email) values
('a4110000-0000-4000-8000-000000000002','a4110000-0000-4000-8000-000000000001','private-proof','aqil@e3group.ai'),
('a4110000-0000-4000-8000-000000000003','a4110000-0000-4000-8000-000000000001','ordinary-proof','ordinary@e3group.ai');
insert into telemetry.sessions(id,workspace_id,person_id,collector_key,native_session_id,actor_role,role_version,started_at)
values ('a4110000-0000-4000-8000-000000000004','a4110000-0000-4000-8000-000000000001','a4110000-0000-4000-8000-000000000002','privacy-proof','private-proof','primary','proof.v1',now()-interval '1 minute');
insert into telemetry.ingest_batches(id,workspace_id,person_id,collector_key,source_kind,source_stream_key,generation_key,generation_seq,start_offset,end_offset,source_byte_count,source_sha256,storage_path,storage_encoding,stored_byte_count,stored_sha256,record_count,contract_version)
values ('a4110000-0000-4000-8000-000000000005','a4110000-0000-4000-8000-000000000001','a4110000-0000-4000-8000-000000000002','privacy-proof','collector','proof','proof',0,0,1,1,repeat('a',64),'privacy-proof/raw','identity',1,repeat('a',64),1,'proof.v1');
insert into telemetry.native_records(workspace_id,batch_id,record_index,source_start_offset,source_end_offset,record_sha256,parse_status)
values ('a4110000-0000-4000-8000-000000000001','a4110000-0000-4000-8000-000000000005',0,0,1,repeat('a',64),'ok');
-- Null session must still be protected by immutable batch ownership.
insert into telemetry.events(workspace_id,source_record_id,normalizer_version,projection_index,source_priority,is_replay,event_kind,server_received_at,content_excerpt)
select workspace_id,id,'proof.v1',0,0,false,'collector_heartbeat',now(),'private-evidence'
from telemetry.native_records where batch_id='a4110000-0000-4000-8000-000000000005';
-- Historical protection survives an identity edit.
update telemetry.people set email='renamed-private@e3group.ai'
where id='a4110000-0000-4000-8000-000000000002';
do $$ begin
 if not exists(select 1 from sherlock_access.restricted_people where person_id='a4110000-0000-4000-8000-000000000002') then
  raise exception 'Protected identity was not pinned';
 end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where (n.nspname,c.relname) in (('telemetry','people'),('telemetry','sessions'),('telemetry','ingest_batches'),('telemetry','native_records'),('telemetry','events'),('telemetry','session_scm'),('analytics','activity_spans'),('analytics','frame_projection_receipts'),('analytics','frame_evidence_revisions'),('github','commit_pr_lookups'))
 and not c.relrowsecurity) then raise exception 'Protected reader table lacks RLS'; end if;
 if pg_has_role('sherlock_worker_login','sherlock_aqil_private_login','member') then
 raise exception 'Shared login inherits private principal'; end if;
end $$;
set local role sherlock_reader;
do $$ begin
 if exists(select 1 from telemetry.events where workspace_id='a4110000-0000-4000-8000-000000000001') then raise exception 'Null-session event leaks protected source'; end if;
 if exists(select 1 from telemetry.native_records where workspace_id='a4110000-0000-4000-8000-000000000001') then raise exception 'Native record leaks protected source'; end if;
 if exists(select 1 from telemetry.sessions where workspace_id='a4110000-0000-4000-8000-000000000001') then raise exception 'Session leaks protected identity'; end if;
 if exists(select 1 from telemetry.people where id='a4110000-0000-4000-8000-000000000002') then raise exception 'Public reader sees protected identity'; end if;
 if not exists(select 1 from telemetry.people where id='a4110000-0000-4000-8000-000000000003') then raise exception 'Public reader lost ordinary identity'; end if;
 if exists(select 1 from analytics.read_dashboard_freshness('a4110000-0000-4000-8000-000000000001','e3group.ai',array['sherlock.codex-rollout.v3'],500) where person_id='a4110000-0000-4000-8000-000000000002') then raise exception 'Definer function leaks protected identity'; end if;
 perform set_config('sherlock.viewer_email','aqil@e3group.ai',true);
 if sherlock_access.person_visible('a4110000-0000-4000-8000-000000000001','a4110000-0000-4000-8000-000000000002') then raise exception 'Spoofed setting bypasses isolation'; end if;
end $$;
reset role;
set local session authorization sherlock_aqil_private_login;
set local role sherlock_reader;
do $$ begin
 if not exists(select 1 from telemetry.events where workspace_id='a4110000-0000-4000-8000-000000000001') then raise exception 'Private source event not visible'; end if;
 if not exists(select 1 from telemetry.people where id='a4110000-0000-4000-8000-000000000002') then raise exception 'Private principal cannot see protected identity'; end if;
 if exists(select 1 from telemetry.people where id='a4110000-0000-4000-8000-000000000003') then raise exception 'Private principal sees ordinary identity'; end if;
end $$;
reset role;
reset session authorization;
rollback;
