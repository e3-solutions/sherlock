-- COR-5165: durable record of who read whose session excerpts.
--
-- The MCP excerpt tools (search_sessions, get_session_evidence,
-- list_prompt_evidence) return other people's session content. Every call,
-- including admin calls that the rate limit exempts, writes one row per
-- session read here: when, which Cosmos caller (from the signed identity
-- pass), which tool and outcome, the session, and the session owner's person.
-- Identifiers only; no query text and no excerpt content is ever stored.
--
-- The dashboard backend writes through record_excerpt_reads() only; the reader
-- role has no INSERT, UPDATE or DELETE on the table. Rows are append-only.

create schema if not exists sherlock_audit;
revoke all on schema sherlock_audit from public;
grant usage on schema sherlock_audit to sherlock_reader;

create table if not exists sherlock_audit.excerpt_reads (
  id bigint generated always as identity primary key,
  read_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  workspace_id uuid not null,
  tool text not null,
  outcome text not null,
  caller text,
  caller_tier text,
  request_id text,
  session_id uuid,
  owner_person_id uuid,
  constraint excerpt_reads_tool_check
    check (tool in ('search_sessions', 'get_session_evidence', 'list_prompt_evidence')),
  constraint excerpt_reads_outcome_check
    check (outcome in ('ok', 'error', 'rate_limited')),
  constraint excerpt_reads_caller_check
    check (caller is null or char_length(caller) between 1 and 256),
  constraint excerpt_reads_caller_tier_check
    check (caller_tier is null or char_length(caller_tier) between 1 and 32),
  constraint excerpt_reads_request_id_check
    check (request_id is null or char_length(request_id) between 1 and 128)
);
comment on table sherlock_audit.excerpt_reads is
  'One row per session read through a Sherlock MCP excerpt tool: caller, tool, outcome, session and owner ids. No content.';

create index if not exists excerpt_reads_workspace_read_at_idx
  on sherlock_audit.excerpt_reads (workspace_id, read_at desc);
create index if not exists excerpt_reads_owner_read_at_idx
  on sherlock_audit.excerpt_reads (workspace_id, owner_person_id, read_at desc);
create index if not exists excerpt_reads_caller_read_at_idx
  on sherlock_audit.excerpt_reads (workspace_id, caller, read_at desc);

alter table sherlock_audit.excerpt_reads enable row level security;
revoke all on table sherlock_audit.excerpt_reads from public;
do $revoke$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table sherlock_audit.excerpt_reads from anon, authenticated, service_role;
  end if;
end
$revoke$;
grant select on table sherlock_audit.excerpt_reads to sherlock_reader;
drop policy if exists excerpt_reads_reader_select on sherlock_audit.excerpt_reads;
create policy excerpt_reads_reader_select on sherlock_audit.excerpt_reads
  for select to sherlock_reader using (true);

-- p_rows: a JSON array of at most 1000 objects with read_at, tool, outcome,
-- caller, caller_tier, request_id, session_id and owner_person_id.
create or replace function sherlock_audit.record_excerpt_reads(p_workspace_id uuid, p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $body$
declare
  v_count integer;
begin
  if p_workspace_id is null or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_rows) > 1000 then
    raise exception using errcode = '22023', message = 'excerpt_read_audit_invalid';
  end if;
  insert into sherlock_audit.excerpt_reads (
    read_at, workspace_id, tool, outcome, caller, caller_tier, request_id, session_id, owner_person_id
  )
  -- Callers report when the read happened (rows are batched for a few
  -- seconds); a time outside the last hour cannot backdate or postdate it.
  select least(greatest(r.read_at, pg_catalog.now() - interval '1 hour'), pg_catalog.now()),
         p_workspace_id, r.tool, r.outcome, r.caller, r.caller_tier, r.request_id,
         r.session_id, r.owner_person_id
    from pg_catalog.jsonb_to_recordset(p_rows) as r(
      read_at timestamptz, tool text, outcome text, caller text, caller_tier text,
      request_id text, session_id uuid, owner_person_id uuid
    )
   where r.read_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end
$body$;
comment on function sherlock_audit.record_excerpt_reads(uuid, jsonb) is
  'Appends excerpt-read audit rows (ids only) for the dashboard MCP backend; returns rows written.';
revoke all on function sherlock_audit.record_excerpt_reads(uuid, jsonb) from public;
do $revoke_function$
begin
  if exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function sherlock_audit.record_excerpt_reads(uuid, jsonb)
      from anon, authenticated, service_role;
  end if;
end
$revoke_function$;
grant execute on function sherlock_audit.record_excerpt_reads(uuid, jsonb) to sherlock_reader;
