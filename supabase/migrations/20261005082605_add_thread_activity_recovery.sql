-- Derived timing metadata remains separate from canonical native event telemetry.
-- Original read_thread response bytes are retained in the private recovery archive;
-- this append-only manifest records their hashes and the extracted timing fields.
create table telemetry.thread_activity_recovery_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  person_id uuid not null,
  imported_at timestamptz not null default now(),
  manifest_text text not null check (octet_length(manifest_text) <= 1048576),
  manifest_sha256 text not null check (manifest_sha256 = encode(sha256(convert_to(manifest_text, 'UTF8')), 'hex')),
  foreign key (workspace_id, person_id) references telemetry.people(workspace_id, id),
  unique(workspace_id, person_id, manifest_sha256),
  check (manifest_text::jsonb ->> 'schemaVersion' = 'thread-api-timing-manifest-v1'),
  check (jsonb_typeof(manifest_text::jsonb -> 'sessions') = 'array'),
  check (jsonb_array_length(manifest_text::jsonb -> 'sessions') between 1 and 200),
  check (jsonb_typeof(manifest_text::jsonb -> 'sourcePages') = 'array')
);
create index thread_activity_recovery_scope on telemetry.thread_activity_recovery_batches(workspace_id, person_id, imported_at desc);
alter table telemetry.thread_activity_recovery_batches enable row level security;
revoke all on telemetry.thread_activity_recovery_batches from public, anon, authenticated;
grant select on telemetry.thread_activity_recovery_batches to sherlock_reader;
grant insert on telemetry.thread_activity_recovery_batches to sherlock_ingest;
create policy thread_activity_recovery_read on telemetry.thread_activity_recovery_batches for select to sherlock_reader using (true);
create policy thread_activity_recovery_insert on telemetry.thread_activity_recovery_batches for insert to sherlock_ingest with check (true);
create function telemetry.reject_thread_recovery_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'thread recovery evidence is append-only'; end;
$$;
create trigger thread_recovery_immutable before update or delete on telemetry.thread_activity_recovery_batches for each row execute function telemetry.reject_thread_recovery_mutation();
revoke all on function telemetry.reject_thread_recovery_mutation() from public;
