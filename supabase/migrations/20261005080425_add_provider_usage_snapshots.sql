-- Provider billing evidence is separate from native token telemetry.
create table telemetry.provider_usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  person_id uuid not null,
  native_thread_id text not null check (native_thread_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  provider text not null check (provider = 'codex'),
  source_endpoint text not null check (source_endpoint = 'https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2'),
  observed_at timestamptz not null default now(),
  raw_response text not null check (octet_length(raw_response) <= 1048576),
  raw_sha256 text not null check (raw_sha256 = encode(sha256(convert_to(raw_response, 'UTF8')), 'hex')),
  foreign key (workspace_id, person_id) references telemetry.people(workspace_id, id),
  unique (workspace_id, person_id, native_thread_id, raw_sha256),
  check (jsonb_typeof(raw_response::jsonb -> 'threads') = 'array'),
  check ((raw_response::jsonb ->> 'data_as_of')::timestamptz is not null),
  check (jsonb_path_exists(raw_response::jsonb, '$.threads[*] ? (@.thread_id == $id)', jsonb_build_object('id', native_thread_id)))
);
create index provider_usage_snapshots_scope on telemetry.provider_usage_snapshots(workspace_id, person_id, native_thread_id, observed_at desc);
alter table telemetry.provider_usage_snapshots enable row level security;
revoke all on telemetry.provider_usage_snapshots from public, anon, authenticated;
grant select on telemetry.provider_usage_snapshots to sherlock_reader;
create policy provider_usage_reader on telemetry.provider_usage_snapshots for select to sherlock_reader using (true);
create function telemetry.reject_provider_usage_mutation() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'provider usage evidence is append-only';
end;
$$;
create trigger provider_usage_immutable before update or delete on telemetry.provider_usage_snapshots for each row execute function telemetry.reject_provider_usage_mutation();
revoke all on function telemetry.reject_provider_usage_mutation() from public;
comment on table telemetry.provider_usage_snapshots is 'Immutable provider billing responses. Plan allowance percentages are not token counts or a claim of complete session coverage.';
