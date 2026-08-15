create schema if not exists telemetry;
create schema if not exists analytics;

revoke all on schema telemetry from public, anon, authenticated;
revoke all on schema analytics from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_ingest') then
    create role sherlock_ingest nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'sherlock_normalizer') then
    create role sherlock_normalizer nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'sherlock_reader') then
    create role sherlock_reader nologin;
  end if;
end
$$;

create table telemetry.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  constraint workspaces_slug_nonempty check (btrim(slug) <> ''),
  constraint workspaces_name_nonempty check (btrim(name) <> '')
);

create table telemetry.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references telemetry.workspaces (id),
  identity_key text not null,
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  constraint people_workspace_identity_key_key unique (workspace_id, identity_key),
  constraint people_workspace_id_id_key unique (workspace_id, id),
  constraint people_identity_key_nonempty check (btrim(identity_key) <> ''),
  constraint people_display_name_nonempty check (
    display_name is null or btrim(display_name) <> ''
  ),
  constraint people_email_normalized check (
    email is null or (btrim(email) <> '' and email = lower(btrim(email)))
  )
);

create table telemetry.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references telemetry.workspaces (id),
  person_id uuid not null,
  collector_key text not null,
  native_session_id text not null,
  native_thread_id text,
  parent_session_id uuid,
  parent_native_session_id text,
  actor_role text not null,
  role_version text not null,
  title text,
  project_key text,
  repo_remote text,
  branch text,
  cwd text,
  model text,
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_workspace_id_id_key unique (workspace_id, id),
  constraint sessions_native_identity_key unique (
    workspace_id, collector_key, native_session_id
  ),
  constraint sessions_person_fkey foreign key (workspace_id, person_id)
    references telemetry.people (workspace_id, id),
  constraint sessions_parent_fkey foreign key (workspace_id, parent_session_id)
    references telemetry.sessions (workspace_id, id),
  constraint sessions_collector_key_nonempty check (btrim(collector_key) <> ''),
  constraint sessions_native_session_id_nonempty check (btrim(native_session_id) <> ''),
  constraint sessions_optional_identity_nonempty check (
    (native_thread_id is null or btrim(native_thread_id) <> '') and
    (parent_native_session_id is null or btrim(parent_native_session_id) <> '')
  ),
  constraint sessions_parent_not_self check (parent_session_id is null or parent_session_id <> id),
  constraint sessions_actor_role_check check (
    actor_role in ('primary', 'worker', 'guardian', 'automation', 'unknown')
  ),
  constraint sessions_role_version_nonempty check (btrim(role_version) <> ''),
  constraint sessions_time_order_check check (ended_at is null or ended_at >= started_at)
);

create table telemetry.ingest_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references telemetry.workspaces (id),
  person_id uuid not null,
  collector_key text not null,
  observed_native_session_id text,
  source_kind text not null,
  source_stream_key text not null,
  generation_key text not null,
  generation_seq bigint not null,
  start_offset bigint not null,
  end_offset bigint not null,
  source_byte_count bigint not null,
  source_sha256 text not null,
  storage_path text not null unique,
  storage_encoding text not null,
  stored_byte_count bigint not null,
  stored_sha256 text not null,
  record_count integer not null,
  first_occurred_at timestamptz,
  last_occurred_at timestamptz,
  codex_version text,
  collector_version text,
  contract_version text not null,
  committed_at timestamptz not null default now(),
  constraint ingest_batches_workspace_id_id_key unique (workspace_id, id),
  constraint ingest_batches_range_key unique (
    workspace_id,
    collector_key,
    source_kind,
    source_stream_key,
    generation_seq,
    generation_key,
    start_offset,
    end_offset
  ),
  constraint ingest_batches_person_fkey foreign key (workspace_id, person_id)
    references telemetry.people (workspace_id, id),
  constraint ingest_batches_identity_nonempty check (
    btrim(collector_key) <> '' and
    btrim(source_stream_key) <> '' and
    btrim(generation_key) <> '' and
    btrim(storage_path) <> '' and
    btrim(contract_version) <> '' and
    (observed_native_session_id is null or btrim(observed_native_session_id) <> '')
  ),
  constraint ingest_batches_source_kind_check check (
    source_kind in ('rollout', 'hook', 'collector')
  ),
  constraint ingest_batches_storage_encoding_check check (
    storage_encoding in ('gzip', 'identity')
  ),
  constraint ingest_batches_range_check check (
    generation_seq >= 0 and
    start_offset >= 0 and
    end_offset > start_offset and
    source_byte_count = end_offset - start_offset and
    stored_byte_count > 0 and
    record_count > 0
  ),
  constraint ingest_batches_source_sha256_check check (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ingest_batches_stored_sha256_check check (
    stored_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint ingest_batches_occurred_pair_check check (
    (first_occurred_at is null) = (last_occurred_at is null) and
    (first_occurred_at is null or first_occurred_at <= last_occurred_at)
  )
);

create table telemetry.native_records (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  batch_id uuid not null,
  record_index integer not null,
  source_start_offset bigint not null,
  source_end_offset bigint not null,
  record_sha256 text not null,
  native_type text,
  native_payload_type text,
  occurred_at timestamptz,
  parse_status text not null,
  created_at timestamptz not null default now(),
  constraint native_records_workspace_id_id_key unique (workspace_id, id),
  constraint native_records_batch_record_index_key unique (batch_id, record_index),
  constraint native_records_batch_source_offset_key unique (batch_id, source_start_offset),
  constraint native_records_batch_fkey foreign key (workspace_id, batch_id)
    references telemetry.ingest_batches (workspace_id, id),
  constraint native_records_range_check check (
    record_index >= 0 and
    source_start_offset >= 0 and
    source_end_offset > source_start_offset
  ),
  constraint native_records_sha256_check check (
    record_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint native_records_parse_status_check check (
    parse_status in ('ok', 'unknown', 'malformed')
  ),
  constraint native_records_native_labels_nonempty check (
    (native_type is null or btrim(native_type) <> '') and
    (native_payload_type is null or btrim(native_payload_type) <> '')
  )
);

create table telemetry.events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  session_id uuid,
  source_record_id bigint not null,
  normalizer_version text not null,
  projection_index integer not null,
  canonical_scope_key text,
  logical_event_key text,
  source_priority integer not null,
  is_replay boolean not null default false,
  event_kind text not null,
  event_subtype text,
  phase text,
  actor_role text,
  occurred_at timestamptz,
  observed_at timestamptz,
  server_received_at timestamptz not null,
  wall_started_at timestamptz,
  wall_ended_at timestamptz,
  native_duration_ms bigint,
  native_item_id text,
  turn_id text,
  tool_call_id text,
  related_session_id uuid,
  message_role text,
  message_origin text,
  tool_name text,
  tool_status text,
  model text,
  project_key text,
  repo_remote text,
  branch text,
  cwd text,
  usage_stream_key text,
  usage_scope text,
  usage_is_cumulative boolean,
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  reasoning_tokens bigint,
  total_tokens bigint,
  collector_key text,
  lease_state text,
  source_kind text,
  source_stream_key text,
  generation_seq bigint,
  observed_size bigint,
  captured_offset bigint,
  committed_offset bigint,
  pending_record_count bigint,
  pending_byte_count bigint,
  error_code text,
  content_sha256 text,
  content_byte_size bigint,
  content_excerpt text,
  attributes jsonb,
  created_at timestamptz not null default now(),
  constraint events_source_projection_key unique (
    source_record_id, normalizer_version, projection_index
  ),
  constraint events_workspace_session_id_key unique (workspace_id, session_id, id),
  constraint events_source_record_fkey foreign key (workspace_id, source_record_id)
    references telemetry.native_records (workspace_id, id),
  constraint events_session_fkey foreign key (workspace_id, session_id)
    references telemetry.sessions (workspace_id, id),
  constraint events_related_session_fkey foreign key (workspace_id, related_session_id)
    references telemetry.sessions (workspace_id, id),
  constraint events_projection_index_check check (projection_index >= 0),
  constraint events_source_priority_check check (source_priority >= 0),
  constraint events_normalizer_version_nonempty check (btrim(normalizer_version) <> ''),
  constraint events_event_kind_check check (
    event_kind in (
      'message', 'reasoning', 'tool_call', 'tool_result', 'agent_spawn',
      'agent_message', 'usage', 'lifecycle', 'collector_heartbeat',
      'session_presence', 'stream_watermark', 'error', 'ignored', 'unknown'
    )
  ),
  constraint events_actor_role_check check (
    actor_role is null or actor_role in (
      'primary', 'worker', 'guardian', 'automation', 'unknown'
    )
  ),
  constraint events_message_origin_check check (
    message_origin is null or message_origin in (
      'human', 'parent_agent', 'worker', 'system', 'resumed_context', 'unknown'
    )
  ),
  constraint events_wall_time_check check (
    (wall_started_at is null) = (wall_ended_at is null) and
    (wall_started_at is null or wall_ended_at >= wall_started_at)
  ),
  constraint events_native_duration_check check (
    native_duration_ms is null or native_duration_ms >= 0
  ),
  constraint events_nonnegative_counters_check check (
    (input_tokens is null or input_tokens >= 0) and
    (cached_input_tokens is null or cached_input_tokens >= 0) and
    (output_tokens is null or output_tokens >= 0) and
    (reasoning_tokens is null or reasoning_tokens >= 0) and
    (total_tokens is null or total_tokens >= 0) and
    (observed_size is null or observed_size >= 0) and
    (captured_offset is null or captured_offset >= 0) and
    (committed_offset is null or committed_offset >= 0) and
    (pending_record_count is null or pending_record_count >= 0) and
    (pending_byte_count is null or pending_byte_count >= 0) and
    (content_byte_size is null or content_byte_size >= 0) and
    (generation_seq is null or generation_seq >= 0)
  ),
  constraint events_canonical_key_check check (
    logical_event_key is null or canonical_scope_key is not null
  ),
  constraint events_usage_required_check check (
    event_kind <> 'usage' or (
      usage_stream_key is not null and
      btrim(usage_stream_key) <> '' and
      usage_is_cumulative is not null
    )
  ),
  constraint events_capture_offsets_check check (
    (captured_offset is null or (
      observed_size is not null and captured_offset <= observed_size
    )) and
    (committed_offset is null or (
      observed_size is not null and committed_offset <= observed_size
    )) and
    (committed_offset is null or captured_offset is null or committed_offset <= captured_offset)
  ),
  constraint events_content_sha256_check check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint events_content_excerpt_size_check check (
    content_excerpt is null or octet_length(content_excerpt) <= 1024
  ),
  constraint events_attributes_size_check check (
    attributes is null or (
      jsonb_typeof(attributes) = 'object' and pg_column_size(attributes) <= 8192
    )
  ),
  constraint events_optional_identity_nonempty check (
    (canonical_scope_key is null or btrim(canonical_scope_key) <> '') and
    (logical_event_key is null or btrim(logical_event_key) <> '') and
    (native_item_id is null or btrim(native_item_id) <> '') and
    (turn_id is null or btrim(turn_id) <> '') and
    (tool_call_id is null or btrim(tool_call_id) <> '') and
    (collector_key is null or btrim(collector_key) <> '') and
    (source_stream_key is null or btrim(source_stream_key) <> '')
  )
);

create table analytics.activity_spans (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  session_id uuid not null,
  person_id uuid not null,
  span_key text not null,
  activity_version text not null,
  valid_from_event_id bigint not null,
  started_at timestamptz,
  ended_at timestamptz,
  span_state text not null,
  activity_kind text not null,
  timing_basis text not null,
  confidence text not null,
  estimated_start boolean not null,
  estimated_end boolean not null,
  actor_role text not null,
  project_key text,
  start_event_id bigint,
  end_event_id bigint,
  is_tombstone boolean not null default false,
  created_at timestamptz not null default now(),
  constraint activity_spans_session_fkey foreign key (workspace_id, session_id)
    references telemetry.sessions (workspace_id, id),
  constraint activity_spans_person_fkey foreign key (workspace_id, person_id)
    references telemetry.people (workspace_id, id),
  constraint activity_spans_valid_event_fkey foreign key (
    workspace_id, session_id, valid_from_event_id
  ) references telemetry.events (workspace_id, session_id, id),
  constraint activity_spans_start_event_fkey foreign key (
    workspace_id, session_id, start_event_id
  ) references telemetry.events (workspace_id, session_id, id),
  constraint activity_spans_end_event_fkey foreign key (
    workspace_id, session_id, end_event_id
  ) references telemetry.events (workspace_id, session_id, id),
  constraint activity_spans_identity_nonempty check (
    btrim(span_key) <> '' and btrim(activity_version) <> ''
  ),
  constraint activity_spans_span_state_check check (
    span_state in ('active', 'detected_open')
  ),
  constraint activity_spans_activity_kind_check check (
    activity_kind in ('turn', 'tool', 'point', 'hook_tail', 'presence')
  ),
  constraint activity_spans_timing_basis_check check (
    timing_basis in ('lifecycle', 'native_duration', 'paired_events', 'point', 'provisional')
  ),
  constraint activity_spans_confidence_check check (
    confidence in ('exact', 'inferred')
  ),
  constraint activity_spans_actor_role_check check (
    actor_role in ('primary', 'worker', 'guardian', 'automation', 'unknown')
  ),
  constraint activity_spans_tombstone_shape_check check (
    (is_tombstone and started_at is null and ended_at is null) or
    (not is_tombstone and started_at is not null and ended_at > started_at)
  ),
  constraint activity_spans_evidence_order_check check (
    (start_event_id is null or start_event_id <= valid_from_event_id) and
    (end_event_id is null or end_event_id <= valid_from_event_id)
  )
);

create index sessions_person_started_idx
  on telemetry.sessions (workspace_id, person_id, started_at, id);
create index sessions_parent_started_idx
  on telemetry.sessions (workspace_id, parent_session_id, started_at, id)
  where parent_session_id is not null;

create index ingest_batches_person_committed_idx
  on telemetry.ingest_batches (workspace_id, person_id, committed_at, id);

create index native_records_workspace_occurred_idx
  on telemetry.native_records (workspace_id, occurred_at, id);

create index events_session_occurred_idx
  on telemetry.events (workspace_id, session_id, occurred_at, id);
create index events_canonical_selection_idx
  on telemetry.events (
    workspace_id,
    canonical_scope_key,
    normalizer_version,
    logical_event_key,
    event_kind,
    source_priority desc,
    occurred_at asc nulls last,
    id
  ) where canonical_scope_key is not null and logical_event_key is not null;
create index events_human_messages_idx
  on telemetry.events (workspace_id, occurred_at, id)
  where event_kind = 'message' and message_origin = 'human';
create index events_related_session_idx
  on telemetry.events (workspace_id, related_session_id, occurred_at, id)
  where related_session_id is not null;
create index events_collector_health_idx
  on telemetry.events (workspace_id, collector_key, server_received_at desc, id desc)
  where event_kind in ('collector_heartbeat', 'stream_watermark');

create unique index activity_spans_latest_version_idx
  on analytics.activity_spans (
    workspace_id, activity_version, span_key, valid_from_event_id desc
  );
create index activity_spans_window_idx
  on analytics.activity_spans (
    workspace_id, activity_version, started_at, ended_at, span_key
  ) where is_tombstone = false;
create index activity_spans_session_idx
  on analytics.activity_spans (
    workspace_id, session_id, activity_version, started_at, id
  );
create index activity_spans_person_idx
  on analytics.activity_spans (
    workspace_id, person_id, activity_version, started_at, id
  );
create index activity_spans_valid_event_idx
  on analytics.activity_spans (workspace_id, valid_from_event_id);
create index activity_spans_start_event_idx
  on analytics.activity_spans (workspace_id, start_event_id)
  where start_event_id is not null;
create index activity_spans_end_event_idx
  on analytics.activity_spans (workspace_id, end_event_id)
  where end_event_id is not null;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'telemetry-raw',
  'telemetry-raw',
  false,
  52428800,
  array['application/gzip', 'application/x-gzip', 'application/octet-stream']
) on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

revoke all on all tables in schema telemetry from public, anon, authenticated;
revoke all on all tables in schema analytics from public, anon, authenticated;
revoke all on all sequences in schema telemetry from public, anon, authenticated;
revoke all on all sequences in schema analytics from public, anon, authenticated;

grant usage on schema telemetry to sherlock_ingest, sherlock_normalizer, sherlock_reader;
grant usage on schema analytics to sherlock_normalizer, sherlock_reader;

grant select on telemetry.workspaces, telemetry.people,
  telemetry.ingest_batches, telemetry.native_records to sherlock_ingest;
grant insert on telemetry.ingest_batches, telemetry.native_records to sherlock_ingest;
grant usage, select on sequence telemetry.native_records_id_seq to sherlock_ingest;

grant select on all tables in schema telemetry to sherlock_normalizer;
grant insert, update on telemetry.sessions to sherlock_normalizer;
grant insert on telemetry.events to sherlock_normalizer;
grant select, insert on analytics.activity_spans to sherlock_normalizer;
grant usage, select on sequence telemetry.events_id_seq to sherlock_normalizer;
grant usage, select on sequence analytics.activity_spans_id_seq to sherlock_normalizer;

grant select on all tables in schema telemetry to sherlock_reader;
grant select on all tables in schema analytics to sherlock_reader;

alter default privileges in schema telemetry
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema analytics
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema telemetry
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema analytics
  revoke all on sequences from public, anon, authenticated;
