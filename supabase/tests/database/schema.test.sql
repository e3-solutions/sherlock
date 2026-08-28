begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(145);

select has_schema('telemetry', 'telemetry schema exists');
select has_schema('analytics', 'analytics schema exists');
select has_schema('processing', 'processing schema exists');
select has_schema('github', 'github source schema exists');

select has_table('telemetry', 'workspaces', 'workspaces table exists');
select has_table('telemetry', 'people', 'people table exists');
select has_table('telemetry', 'sessions', 'sessions table exists');
select has_table('telemetry', 'ingest_batches', 'ingest_batches table exists');
select has_table('telemetry', 'native_records', 'native_records table exists');
select has_table('telemetry', 'events', 'events table exists');
select has_table(
  'telemetry', 'session_scm',
  'session SCM facts are auditable'
);
select has_table(
  'github', 'commit_pr_lookups',
  'GitHub commit lookup outcomes are auditable'
);
select has_table('analytics', 'activity_spans', 'activity_spans table exists');
select has_table(
  'analytics', 'frame_projection_receipts',
  'frame projection receipts are auditable'
);
select has_table(
  'analytics', 'frame_evidence_revisions',
  'frame evidence revisions are append-only'
);
select has_table(
  'analytics', 'frame_projection_activations',
  'frame projection activation is explicit'
);
select has_table(
  'analytics', 'normalizer_cutovers',
  'normalizer cutovers are auditable facts'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'analytics.frame_projection_activations'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) =
        'PRIMARY KEY (workspace_id, frame_version)'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'analytics'
      and table_name = 'frame_projection_activations'
      and column_name = 'id'
  ),
  'frame activation uses only its exact workspace and version identity'
);
select has_table('processing', 'telemetry_jobs', 'durable telemetry queue exists');
select has_function(
  'analytics', 'read_dashboard_freshness', array['uuid', 'text', 'text[]', 'integer'],
  'dashboard freshness has an aggregate-only database contract'
);
select ok(
  has_function_privilege(
    'sherlock_reader',
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)',
    'execute'
  ),
  'only the dashboard reader receives the freshness aggregate'
);
select ok(
  not has_function_privilege(
    'anon', 'analytics.read_dashboard_freshness(uuid,text,text[],integer)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'analytics.read_dashboard_freshness(uuid,text,text[],integer)', 'execute'
  ) and not has_function_privilege(
    'service_role', 'analytics.read_dashboard_freshness(uuid,text,text[],integer)', 'execute'
  ) and not has_function_privilege(
    'sherlock_processor',
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)',
    'execute'
  ),
  'public and operational roles cannot execute dashboard freshness'
);
select is(
  (select count(*) from analytics.read_dashboard_freshness(
    '00000000-0000-0000-0000-000000000001', 'example.com', array['v1'], 500
  )),
  0::bigint,
  'freshness rejects an unapproved identity domain without revealing facts'
);
select is(
  (select count(*) from analytics.read_dashboard_freshness(
    '00000000-0000-0000-0000-000000000001', 'e3group.ai', array['v1'], 1001
  )),
  0::bigint,
  'freshness rejects an over-broad roster bound'
);
select ok(
  exists (
    select 1 from pg_indexes
     where schemaname = 'processing'
       and indexname = 'telemetry_jobs_dashboard_pending_normalize_idx'
       and indexdef like '%workload_class = ''live''%'
       and indexdef like '%status = ANY (ARRAY[''queued''::text, ''leased''::text])%'
  ),
  'pending freshness uses a narrow partial live-normalize index'
);
select ok(
  regexp_count(
    pg_get_functiondef(
      'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
    ),
    'workload_class[[:space:]]*=[[:space:]]*''live''',
    1,
    'i'
  ) = 1
  and regexp_count(
    pg_get_functiondef(
      'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
    ),
    'join[[:space:]]+roster[[:space:]]+r[[:space:]]+on[[:space:]]+r.person_id[[:space:]]*=[[:space:]]*b.person_id',
    1,
    'i'
  ) = 1
  and pg_get_functiondef(
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
  ) ~* 'interval[[:space:]]+''30 minutes'''
  and pg_get_functiondef(
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
  ) ~* 'order by[[:space:]]+b.committed_at[[:space:]]+desc,[[:space:]]*b.id[[:space:]]+desc[[:space:]]+limit[[:space:]]+1'
  and pg_get_functiondef(
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
  ) ~* 'pending_freshness[[:space:]]+as[[:space:]]+materialized'
  and pg_get_functiondef(
    'analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure
  ) ~* 'from[[:space:]]+roster[[:space:]]+r[[:space:]]+cross[[:space:]]+join[[:space:]]+lateral',
  'freshness watermarks and pending metrics use only the visible live roster'
);
select ok(
  to_regclass('processing.telemetry_jobs_kind_claim_idx') is not null,
  'kind-filtered queued claims have a bounded scheduler index'
);
select ok(
  to_regclass('processing.telemetry_jobs_kind_expired_lease_idx') is not null,
  'kind-filtered expired leases have a bounded recovery index'
);
select ok(
  to_regclass('processing.telemetry_jobs_live_normalize_age_idx') is not null,
  'live normalization overload sampling has a bounded partial index'
);
select has_column(
  'analytics', 'frame_projection_receipts', 'request_generation',
  'projection receipts preserve queue generation'
);
select has_column(
  'analytics', 'frame_projection_receipts', 'session_updated_at',
  'projection receipts preserve the consumed session-cache revision'
);
select has_column('telemetry', 'people', 'github_id', 'people records GitHub identity');
select has_column(
  'telemetry', 'ingest_batches', 'processing_class_hint',
  'transport workload class is an auditable ingest fact'
);
select has_column(
  'telemetry', 'ingest_batches', 'source_provider',
  'ingest batches preserve the native provider identity'
);
select has_column(
  'telemetry', 'ingest_batches', 'source_version',
  'ingest batches preserve a provider-neutral source version'
);
select has_column(
  'telemetry', 'ingest_batches', 'observed_parent_native_session_id',
  'ingest batches preserve hook-observed parent identity'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'telemetry.ingest_batches'::regclass
      and conname = 'ingest_batches_provider_kind_check'
      and contype = 'c'
  ),
  'source provider and source kind cannot be conflated'
);
select has_column(
  'telemetry', 'events', 'message_search',
  'normalized message excerpts have a generated search vector'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'telemetry'
      and tablename = 'events'
      and indexname = 'events_message_search_idx'
  ),
  'normalized message search has a partial GIN index'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'telemetry'
      and tablename = 'sessions'
      and indexname = 'sessions_unresolved_parent_native_idx'
      and indexdef like '%(workspace_id, collector_key, person_id, parent_native_session_id)%'
      and indexdef like '%WHERE ((parent_session_id IS NULL) AND (parent_native_session_id IS NOT NULL))%'
  ),
  'unresolved session parents have a narrow partial lookup index'
);
select ok(
  exists (
    select 1
    from pg_index i
    where i.indexrelid = 'telemetry.people_workspace_email_key'::regclass
      and i.indisunique
      and i.indisvalid
      and pg_get_indexdef(i.indexrelid) like '%(workspace_id, email)%'
      and pg_get_expr(i.indpred, i.indrelid) = '(email IS NOT NULL)'
  ),
  'nonnull person email is unique within a workspace'
);

select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_ingest'),
  'ingest role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_normalizer'),
  'normalizer role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_reader'),
  'reader role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_reducer'),
  'activity reducer role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_processor'),
  'queue processor role exists'
);
select ok(
  exists (select 1 from pg_roles where rolname = 'sherlock_frame_projector'),
  'frame projector role exists'
);
select ok(
  exists (
    select 1 from pg_roles
    where rolname = 'sherlock_worker_login' and rolcanlogin and not rolinherit
  ),
  'Railway uses a login that can only assume explicit worker roles'
);
select ok(
  pg_has_role('postgres', 'sherlock_ingest', 'member'),
  'Edge Function database login can assume the constrained ingest role'
);
select ok(
  pg_has_role('postgres', 'sherlock_normalizer', 'member'),
  'Edge Function database login can assume the constrained normalizer role'
);
select ok(
  pg_has_role('postgres', 'sherlock_reducer', 'member'),
  'internal command database login can assume the constrained reducer role'
);
select ok(
  pg_has_role('postgres', 'sherlock_processor', 'member'),
  'Railway database login can assume the constrained processor role'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_processor', 'member'),
  'Railway login can assume only queue operations when claiming work'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_normalizer', 'member'),
  'Railway login can assume the normalizer role for derived events'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_reducer', 'member'),
  'Railway login can assume the reducer role for activity revisions'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_frame_projector', 'member'),
  'Railway login can assume the frame projector role'
);
select ok(
  pg_has_role('sherlock_worker_login', 'sherlock_reader', 'member'),
  'Bonaparte backend can assume the read-only role for MCP evidence'
);

select ok(
  exists (
    select 1 from storage.buckets
    where id = 'telemetry-raw' and public = false
  ),
  'raw telemetry bucket is private'
);

select ok(not has_schema_privilege('anon', 'telemetry', 'usage'), 'anon cannot use telemetry');
select ok(not has_schema_privilege('anon', 'analytics', 'usage'), 'anon cannot use analytics');
select ok(
  not has_schema_privilege('authenticated', 'telemetry', 'usage'),
  'authenticated cannot use telemetry'
);
select ok(
  not has_schema_privilege('authenticated', 'analytics', 'usage'),
  'authenticated cannot use analytics'
);
select ok(
  not has_schema_privilege('anon', 'processing', 'usage'),
  'anon cannot use processing state'
);
select ok(
  not has_schema_privilege('authenticated', 'processing', 'usage'),
  'authenticated cannot use processing state'
);
select ok(
  not has_table_privilege('anon', 'telemetry.ingest_batches', 'select'),
  'anon cannot select source receipts'
);
select ok(
  not has_table_privilege('authenticated', 'telemetry.ingest_batches', 'select'),
  'authenticated cannot select source receipts'
);

select ok(
  has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'insert'),
  'ingest can insert batches'
);
select ok(
  has_table_privilege('sherlock_ingest', 'telemetry.native_records', 'insert'),
  'ingest can insert native records'
);
select ok(
  has_column_privilege('sherlock_ingest', 'telemetry.people', 'id', 'insert'),
  'ingest can create a server-resolved person'
);
select ok(
  has_column_privilege('sherlock_ingest', 'telemetry.people', 'github_id', 'update'),
  'ingest can refresh declared person metadata'
);
select ok(
  not has_column_privilege('sherlock_ingest', 'telemetry.people', 'identity_key', 'update'),
  'ingest cannot rewrite a person identity key'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.people', 'delete'),
  'ingest cannot delete people'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.events', 'insert'),
  'ingest cannot insert events'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'analytics.activity_spans', 'insert'),
  'ingest cannot insert spans'
);
select ok(
  has_table_privilege('sherlock_normalizer', 'telemetry.events', 'insert'),
  'normalizer can insert events'
);
select ok(
  has_table_privilege('sherlock_normalizer', 'telemetry.sessions', 'select'),
  'normalizer can resolve session parentage'
);
select ok(
  has_table_privilege('sherlock_normalizer', 'telemetry.sessions', 'update'),
  'normalizer can repair derived session parentage'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert'),
  'normalizer cannot insert spans'
);
select ok(
  has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'select'),
  'reducer can read session ownership'
);
select ok(
  has_table_privilege('sherlock_reducer', 'telemetry.events', 'select'),
  'reducer can read normalized events'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.ingest_batches', 'select'),
  'reducer cannot read raw receipt metadata'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.native_records', 'select'),
  'reducer cannot read native record locators'
);
select ok(
  has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'insert'),
  'reducer can append spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'update'),
  'reducer cannot update spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'delete'),
  'reducer cannot delete spans'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.events', 'insert'),
  'reducer cannot insert source events'
);
select ok(
  not has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'update'),
  'reducer cannot update session caches'
);
select ok(
  has_table_privilege('sherlock_frame_projector', 'telemetry.sessions', 'select') and
  has_table_privilege('sherlock_frame_projector', 'telemetry.events', 'select'),
  'frame projector can read normalized session evidence'
);
select ok(
  has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'workspace_id', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'batch_id', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'record_index', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'source_start_offset', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'source_end_offset', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'native_type', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'native_payload_type', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'collector_key', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'source_kind', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'source_stream_key', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'generation_key', 'select'
  ) and has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'generation_seq', 'select'
  ),
  'frame projector can read only canonical representation-pairing metadata'
);
select ok(
  not has_column_privilege(
    'sherlock_frame_projector', 'telemetry.native_records',
    'record_sha256', 'select'
  ) and not has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'source_sha256', 'select'
  ) and not has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'storage_path', 'select'
  ) and not has_table_privilege(
    'sherlock_frame_projector', 'telemetry.native_records', 'update'
  ) and not has_table_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches', 'update'
  ),
  'frame projector cannot read source fingerprints or object locations'
);
select ok(
  has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_projection_receipts', 'insert'
  ) and has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_evidence_revisions', 'insert'
  ),
  'frame projector can append receipts and evidence'
);
select ok(
  not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_projection_receipts', 'update'
  ) and not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_projection_receipts', 'delete'
  ) and not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_evidence_revisions', 'update'
  ) and not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_evidence_revisions', 'delete'
  ),
  'frame projection facts cannot be updated or deleted'
);
select ok(
  not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_projection_activations', 'insert'
  ) and not has_table_privilege(
    'sherlock_frame_projector',
    'analytics.frame_projection_activations', 'select'
  ),
  'worker cannot inspect or activate a projection version'
);
select ok(
  has_table_privilege(
    'sherlock_reader', 'analytics.frame_projection_receipts', 'select'
  ) and has_table_privilege(
    'sherlock_reader', 'analytics.frame_evidence_revisions', 'select'
  ) and has_table_privilege(
    'sherlock_reader', 'analytics.frame_projection_activations', 'select'
  ),
  'reader can inspect activated frame projections'
);
select ok(
  not has_table_privilege(
    'anon', 'analytics.frame_evidence_revisions', 'select'
  ) and not has_table_privilege(
    'authenticated', 'analytics.frame_evidence_revisions', 'select'
  ),
  'frame evidence remains outside the Data API'
);
select ok(
  not has_table_privilege('sherlock_reader', 'telemetry.events', 'insert'),
  'reader cannot insert events'
);
select ok(
  not has_table_privilege('sherlock_reader', 'telemetry.ingest_batches', 'insert'),
  'reader cannot insert batches'
);
select ok(
  has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'select'),
  'processor can inspect queue jobs'
);
select ok(
  has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'update'),
  'processor can transition queue leases'
);
select ok(
  has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'insert'),
  'processor can enqueue coalesced targeted reduction jobs'
);
select ok(
  not has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'delete'),
  'processor cannot delete queue history'
);
select ok(
  not has_table_privilege('sherlock_processor', 'telemetry.ingest_batches', 'select'),
  'queue role has no table-wide access to immutable raw facts'
);
select ok(
  has_schema_privilege('sherlock_processor', 'telemetry', 'usage'),
  'queue role can resolve the immutable batch identity relation'
);
select ok(
  has_column_privilege(
    'sherlock_processor', 'telemetry.ingest_batches', 'id', 'select'
  ) and has_column_privilege(
    'sherlock_processor', 'telemetry.ingest_batches', 'start_offset', 'select'
  ),
  'queue role can read only batch identity and ordering columns'
);
select ok(
  not has_column_privilege(
    'sherlock_processor', 'telemetry.ingest_batches', 'source_sha256', 'select'
  ),
  'queue role cannot read immutable source fingerprints'
);
select ok(
  not has_column_privilege(
    'sherlock_processor', 'telemetry.ingest_batches', 'storage_path', 'select'
  ),
  'queue role cannot read raw object locations'
);
select ok(
  not has_table_privilege('sherlock_processor', 'telemetry.ingest_batches', 'update'),
  'queue role cannot update immutable raw facts'
);
select ok(
  not has_table_privilege('sherlock_processor', 'telemetry.ingest_batches', 'delete'),
  'queue role cannot delete immutable raw facts'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'telemetry.ingest_batches'::regclass
      and tgname = 'ingest_batches_enqueue_processing'
      and not tgisinternal
  ),
  'every committed ingest batch atomically enqueues processing'
);
select ok(
  not exists (
    select 1 from cron.job
    where jobname = 'sherlock-activity-reducer-every-minute' and active
  ),
  'the superseded full-workspace Cron scan is disabled'
);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.oid = 'analytics.activity_spans_latest_version_idx'::regclass
      and not i.indisunique
      and pg_get_indexdef(i.indexrelid) like '%valid_from_event_id DESC, id DESC%'
  ),
  'same-cutoff activity corrections remain appendable and ordered by row id'
);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.oid = 'analytics.activity_spans_ended_window_idx'::regclass
      and i.indisvalid
      and pg_get_indexdef(i.indexrelid) like
        '%(workspace_id, activity_version, ended_at, started_at) INCLUDE (span_key)%'
      and pg_get_expr(i.indpred, i.indrelid) = '(NOT is_tombstone)'
  ),
  'rolling active-time reads can skip spans that ended before the window'
);
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.oid = 'telemetry.events_dashboard_timeline_idx'::regclass
      and i.indisvalid
      and pg_get_indexdef(i.indexrelid) like
        '%workspace_id, normalizer_version, COALESCE(%'
      and pg_get_indexdef(i.indexrelid) like
        '%INCLUDE (id, session_id, actor_role, event_kind, event_subtype,%'
      and pg_get_indexdef(i.indexrelid) like
        '%canonical_scope_key, logical_event_key, source_priority, occurred_at, observed_at, server_received_at, native_item_id)%'
      and pg_get_expr(i.indpred, i.indrelid) like '%(NOT is_replay)%'
  ),
  'dashboard timeline reads use the canonical timestamp window index'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'analytics'
      and indexname = 'frame_evidence_revisions_reader_idx'
      and indexdef like
        '%workspace_id, frame_version, person_id, observed_at, evidence_kind, source_event_id, id DESC%'
  ),
  'frame reads have an indexed person and time revision path'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'analytics'
      and indexname = 'frame_evidence_revisions_window_idx'
      and indexdef like
        '%workspace_id, frame_version, anchor_observed_at, evidence_kind, source_event_id, id DESC%'
      and indexdef like
        '%INCLUDE (receipt_id, person_id, session_id, observed_at, actor_role,%'
      and indexdef like '%prompt_identity, is_summary_candidate, is_tombstone)%'
  ),
  'workspace timelines have an indexed anchor-time revision window'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'analytics'
      and indexname = 'frame_evidence_revisions_diff_idx'
      and indexdef like
        '%workspace_id, session_id, frame_version, anchor_observed_at, evidence_kind, source_event_id, id DESC%'
      and indexdef like
        '%INCLUDE (receipt_id, person_id, observed_at, actor_role,%'
      and indexdef like '%prompt_identity, is_summary_candidate, is_tombstone)%'
  ),
  'projector diffs have an indexed session and rolling-window path'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'analytics'
      and indexname = 'frame_projection_receipts_latest_idx'
      and indexdef like
        '%workspace_id, session_id, frame_version, id DESC%'
  ),
  'latest session projection receipts are indexed'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'analytics.frame_evidence_revisions'::regclass
      and conname = 'frame_evidence_revisions_receipt_fkey' and contype = 'f'
  ),
  'evidence revisions cite an exact tenant-scoped receipt'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'analytics.frame_evidence_revisions'::regclass
      and conname = 'frame_evidence_revisions_source_event_fkey'
      and contype = 'f'
  ),
  'evidence revisions retain source-event provenance'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'analytics.frame_evidence_revisions'::regclass
      and conname = 'frame_evidence_revisions_prompt_identity_shape_check'
      and contype = 'c'
  ),
  'prompt identity exists only on prompt evidence'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'analytics.frame_evidence_revisions'::regclass
      and conname = 'frame_evidence_revisions_summary_candidate_check'
      and contype = 'c'
  ),
  'summary eligibility is explicit and structurally bounded'
);
select ok(
  pg_get_constraintdef(
    (
      select oid from pg_constraint
       where conrelid = 'telemetry.events'::regclass
         and conname = 'events_message_origin_check'
    )
  ) like '%runtime_context%',
  'runtime context is an explicit normalized message origin'
);
select ok(
  exists (
    select 1 from pg_indexes
     where schemaname = 'processing'
       and indexname = 'telemetry_jobs_batch_key'
       and indexdef like '%workspace_id, batch_id, normalizer_version%'
       and indexdef like '%WHERE (job_kind = ''normalize''::text)%'
  ),
  'normalization jobs retain an auditable versioned batch identity'
);

select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'update'),
  'ingest cannot update batches'
);
select ok(
  not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'delete'),
  'ingest cannot delete batches'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'update'),
  'normalizer cannot update events'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'delete'),
  'normalizer cannot delete events'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'update'),
  'normalizer cannot update spans'
);
select ok(
  not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'delete'),
  'normalizer cannot delete spans'
);
select ok(
  has_table_privilege(
    'sherlock_frame_projector', 'analytics.normalizer_cutovers', 'select'
  ) and
  not has_table_privilege(
    'sherlock_frame_projector', 'analytics.normalizer_cutovers', 'update'
  ) and
  not has_table_privilege(
    'sherlock_frame_projector', 'analytics.normalizer_cutovers', 'delete'
  ),
  'projector can read but cannot mutate cutover facts'
);
select ok(
  has_column_privilege(
    'sherlock_frame_projector', 'telemetry.ingest_batches',
    'source_provider', 'select'
  ),
  'projector can select the bounded provider identity used by cutovers'
);

insert into telemetry.workspaces (id, slug, name) values
  ('00000000-0000-0000-0000-000000000001', 'test-one', 'Test One'),
  ('00000000-0000-0000-0000-000000000002', 'test-two', 'Test Two');
select ok(
  (
    select count(*) = 2
      from analytics.normalizer_cutovers
     where workspace_id in (
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000002'
     )
       and source_provider = 'codex'
       and from_normalizer_version = 'sherlock.codex-rollout.v1'
       and to_normalizer_version = 'sherlock.codex-rollout.v2'
  ),
  'new workspaces record one Codex v2 session cutover'
);
insert into telemetry.people (id, workspace_id, identity_key) values
  (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000001',
    'test-person'
  ),
  (
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000001',
    'other-test-person'
  );

insert into telemetry.people (id, workspace_id, identity_key, email) values
  (
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000001',
    'shared-email-workspace-one',
    'shared@example.com'
  ),
  (
    '00000000-0000-0000-0000-000000000104',
    '00000000-0000-0000-0000-000000000002',
    'shared-email-workspace-two',
    'shared@example.com'
  );

select ok(
  (
    select count(*) = 2
    from telemetry.people
    where email = 'shared@example.com'
  ),
  'the same nonnull email remains valid in different workspaces'
);
select ok(
  (
    select count(*) = 2
    from telemetry.people
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and email is null
  ),
  'multiple null emails remain valid in one workspace'
);

insert into telemetry.sessions (
  id, workspace_id, person_id, collector_key, native_session_id,
  actor_role, role_version, started_at
) values
  (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-session', 'primary', 'test-role-v1',
    '2026-08-15T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-worker', 'worker', 'test-role-v1',
    '2026-08-15T00:00:01Z'
  ),
  (
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101',
    'test-collector', 'test-guardian', 'guardian', 'test-role-v1',
    '2026-08-15T00:00:02Z'
  );

update telemetry.sessions
set parent_session_id = '00000000-0000-0000-0000-000000000201',
    parent_native_session_id = 'test-session'
where id in (
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000203'
);

select ok(
  (
    select count(*) = 2
    from telemetry.sessions
    where parent_session_id = '00000000-0000-0000-0000-000000000201'
      and actor_role in ('worker', 'guardian')
  ),
  'synthetic worker and guardian sessions retain their parent and role'
);

insert into telemetry.ingest_batches (
  id, workspace_id, person_id, collector_key, source_kind, source_stream_key,
  generation_key, generation_seq, start_offset, end_offset,
  source_byte_count, source_sha256, storage_path, storage_encoding,
  stored_byte_count, stored_sha256, record_count, contract_version
) values (
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000101',
  'test-collector', 'rollout', 'test-stream', 'test-generation', 0, 0, 1, 1,
  repeat('a', 64), 'test-span-evidence', 'identity', 1, repeat('b', 64), 1,
  'test-v1'
);

insert into telemetry.native_records (
  workspace_id, batch_id, record_index, source_start_offset,
  source_end_offset, record_sha256, parse_status
) values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000301', 0, 0, 1, repeat('c', 64), 'ok'
);

insert into telemetry.events (
  workspace_id, session_id, source_record_id, normalizer_version,
  projection_index, source_priority, event_kind, actor_role,
  content_excerpt, server_received_at
) select
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000201', id, 'test-normalizer-v1',
  0, 100, 'message', 'primary', 'uniquesherlocksearchmarker',
  '2026-08-15T00:00:00Z'
from telemetry.native_records
where workspace_id = '00000000-0000-0000-0000-000000000001'
  and batch_id = '00000000-0000-0000-0000-000000000301';

select ok(
  exists (
    select 1 from telemetry.events
    where message_search @@ plainto_tsquery('simple', 'uniquesherlocksearchmarker')
  ),
  'generated PostgreSQL message search is populated automatically'
);

select ok(
  (select count(*) = 1 from processing.telemetry_jobs
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and batch_id = '00000000-0000-0000-0000-000000000301'
      and job_kind = 'normalize'
      and normalizer_version = 'sherlock.codex-rollout.v2'
      and workload_class = 'live' and status = 'queued'),
  'ingest trigger creates one live job without a session scan'
);

insert into telemetry.ingest_batches (
  id, workspace_id, person_id, collector_key, source_kind, source_stream_key,
  generation_key, generation_seq, start_offset, end_offset,
  source_byte_count, source_sha256, storage_path, storage_encoding,
  stored_byte_count, stored_sha256, record_count, contract_version,
  processing_class_hint
) values (
  '00000000-0000-0000-0000-000000000302',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000101',
  'test-collector', 'rollout', 'test-backfill-stream',
  'test-backfill-generation', 0, 0, 1, 1, repeat('d', 64),
  'test-backfill-evidence', 'identity', 1, repeat('e', 64), 1, 'test-v1',
  'backfill'
);

select ok(
  (select count(*) = 1 from processing.telemetry_jobs
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and batch_id = '00000000-0000-0000-0000-000000000302'
      and job_kind = 'normalize'
      and normalizer_version = 'sherlock.codex-rollout.v2'
      and workload_class = 'backfill'),
  'explicit backfill transport fact isolates recent and timestampless history'
);

insert into telemetry.ingest_batches (
  id, workspace_id, person_id, collector_key, source_provider, source_kind,
  source_stream_key, generation_key, generation_seq, start_offset, end_offset,
  source_byte_count, source_sha256, storage_path, storage_encoding,
  stored_byte_count, stored_sha256, record_count, contract_version
) values (
  '00000000-0000-0000-0000-000000000303',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000101',
  'test-collector', 'claude_code', 'transcript', 'test-claude-stream',
  'test-claude-generation', 0, 0, 1, 1, repeat('f', 64),
  'test-claude-evidence', 'identity', 1, repeat('0', 64), 1, 'test-v1'
);

select ok(
  (select count(*) = 1 from processing.telemetry_jobs
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and batch_id = '00000000-0000-0000-0000-000000000303'
      and job_kind = 'normalize'
      and normalizer_version = 'sherlock.claude-code-transcript.v1'),
  'provider-specific live jobs keep Claude on its compatible normalizer'
);

insert into telemetry.sessions (
  id, workspace_id, person_id, collector_key, native_session_id,
  actor_role, role_version, started_at
)
select '00000000-0000-0000-0000-000000000204'::uuid, workspace_id,
       '00000000-0000-0000-0000-000000000101'::uuid, 'test-cutover-collector',
       'pre-cutover-session', 'primary', 'test-role-v1',
       cutover_at - interval '1 second'
  from analytics.normalizer_cutovers
 where workspace_id = '00000000-0000-0000-0000-000000000001'
   and source_provider = 'codex'
union all
select '00000000-0000-0000-0000-000000000205'::uuid, workspace_id,
       '00000000-0000-0000-0000-000000000101'::uuid, 'test-cutover-collector',
       'post-cutover-session', 'primary', 'test-role-v1',
       cutover_at + interval '1 second'
  from analytics.normalizer_cutovers
 where workspace_id = '00000000-0000-0000-0000-000000000001'
   and source_provider = 'codex';

insert into telemetry.ingest_batches (
  id, workspace_id, person_id, collector_key, observed_native_session_id,
  source_kind, source_stream_key, generation_key, generation_seq,
  start_offset, end_offset, source_byte_count, source_sha256, storage_path,
  storage_encoding, stored_byte_count, stored_sha256, record_count,
  first_occurred_at, last_occurred_at, contract_version
) values
  (
    '00000000-0000-0000-0000-000000000304',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101', 'test-cutover-collector',
    'pre-cutover-session', 'rollout', 'pre-cutover-stream',
    'pre-cutover-generation', 0, 0, 1, 1, repeat('1', 64),
    'test-pre-cutover', 'identity', 1, repeat('2', 64), 1,
    now(), now(), 'test-v1'
  ),
  (
    '00000000-0000-0000-0000-000000000305',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000101', 'test-cutover-collector',
    'post-cutover-session', 'rollout', 'post-cutover-stream',
    'post-cutover-generation', 0, 0, 1, 1, repeat('3', 64),
    'test-post-cutover', 'identity', 1, repeat('4', 64), 1,
    now(), now(), 'test-v1'
  );

select ok(
  exists (
    select 1 from processing.telemetry_jobs
     where batch_id = '00000000-0000-0000-0000-000000000304'
       and normalizer_version = 'sherlock.codex-rollout.v1'
  ) and exists (
    select 1 from processing.telemetry_jobs
     where batch_id = '00000000-0000-0000-0000-000000000305'
       and normalizer_version = 'sherlock.codex-rollout.v2'
  ),
  'new batches keep pre-cutover sessions on v1 and post-cutover sessions on v2'
);

create temporary table constraint_results (
  test_name text primary key,
  passed boolean not null
);

do $$
begin
  begin
    insert into telemetry.people (workspace_id, identity_key, email) values (
      '00000000-0000-0000-0000-000000000001',
      'duplicate-shared-email', 'shared@example.com'
    );
    insert into constraint_results values ('duplicate email', false);
  exception when unique_violation then
    insert into constraint_results values ('duplicate email', true);
  end;

  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 0, 1, 1,
      repeat('a', 64), 'tenant-mismatch', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('tenant mismatch', false);
  exception when foreign_key_violation then
    insert into constraint_results values ('tenant mismatch', true);
  end;

  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 4, 4, 0,
      repeat('a', 64), 'invalid-range', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('invalid range', false);
  exception when check_violation then
    insert into constraint_results values ('invalid range', true);
  end;

  begin
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset,
      source_byte_count, source_sha256, storage_path, storage_encoding,
      stored_byte_count, stored_sha256, record_count, contract_version
    ) values (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000101',
      'collector', 'rollout', 'stream', 'generation', 0, 0, 1, 1,
      'not-a-hash', 'invalid-hash', 'identity', 1, repeat('b', 64), 1, 'v1'
    );
    insert into constraint_results values ('invalid hash', false);
  exception when check_violation then
    insert into constraint_results values ('invalid hash', true);
  end;

  begin
    insert into analytics.activity_spans (
      workspace_id, session_id, person_id, span_key, activity_version,
      valid_from_event_id, started_at, ended_at, span_state, activity_kind,
      timing_basis, confidence, estimated_start, estimated_end, actor_role,
      start_event_id
    ) select
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000102',
      'wrong-person', 'test-activity-v1', id,
      '2026-08-15T00:00:00Z', '2026-08-15T00:00:01Z',
      'active', 'point', 'point', 'inferred', false, true, 'primary', id
    from telemetry.events
    where workspace_id = '00000000-0000-0000-0000-000000000001'
      and session_id = '00000000-0000-0000-0000-000000000201';
    insert into constraint_results values ('span ownership mismatch', false);
  exception when foreign_key_violation then
    insert into constraint_results values ('span ownership mismatch', true);
  end;
end
$$;

select ok(passed, 'a duplicate nonnull email in one workspace is rejected')
from constraint_results where test_name = 'duplicate email';
select ok(passed, 'cross-workspace person attribution is rejected')
from constraint_results where test_name = 'tenant mismatch';
select ok(passed, 'invalid byte ranges are rejected')
from constraint_results where test_name = 'invalid range';
select ok(passed, 'invalid hashes are rejected')
from constraint_results where test_name = 'invalid hash';
select ok(passed, 'spans cannot attribute a session to another workspace person')
from constraint_results where test_name = 'span ownership mismatch';

select * from finish();

do $$
begin
  if not (
    to_regnamespace('telemetry') is not null and
    to_regnamespace('analytics') is not null and
    to_regnamespace('processing') is not null and
    to_regnamespace('github') is not null and
    to_regclass('telemetry.workspaces') is not null and
    to_regclass('telemetry.people') is not null and
    to_regclass('telemetry.sessions') is not null and
    to_regclass('telemetry.ingest_batches') is not null and
    to_regclass('telemetry.native_records') is not null and
    to_regclass('telemetry.events') is not null and
    to_regclass('telemetry.session_scm') is not null and
    to_regclass('github.commit_pr_lookups') is not null and
    exists (select 1 from pg_attribute
      where attrelid = 'processing.telemetry_jobs'::regclass
        and attname = 'scm_backfill_version' and not attnotnull) and
    (select attnotnull from pg_attribute
      where attrelid = 'telemetry.session_scm'::regclass
        and attname = 'server_received_at') and
    exists (
      select 1 from pg_constraint
      where conrelid = 'telemetry.session_scm'::regclass and contype = 'p'
        and pg_get_constraintdef(oid) =
          'PRIMARY KEY (source_record_id, source_version)'
    ) and
    pg_get_indexdef('telemetry.session_scm_recent_idx'::regclass) like
      '%(created_at DESC, workspace_id, repository_full_name, commit_sha)%' and
    exists (
      select 1 from pg_index i
      where i.indexrelid =
          to_regclass('telemetry.events_server_received_brin_idx')
        and i.indisvalid
        and pg_get_indexdef(i.indexrelid) like
          '%USING brin (server_received_at)%'
    ) and
    exists (
      select 1 from pg_index i
      where i.indexrelid =
          to_regclass('telemetry.events_recent_sessions_idx')
        and i.indisvalid and i.indisready
        and pg_get_indexdef(i.indexrelid) like
          '%(workspace_id, server_received_at DESC) INCLUDE (session_id)%'
        and pg_get_expr(i.indpred, i.indrelid) =
          '((session_id IS NOT NULL) AND (NOT is_replay))'
    ) and
    exists (
      select 1
      from pg_index i
      where i.indexrelid = 'telemetry.people_workspace_email_key'::regclass
        and i.indisunique and i.indisvalid
        and pg_get_expr(i.indpred, i.indrelid) = '(email IS NOT NULL)'
    ) and
    to_regclass('analytics.activity_spans') is not null and
    to_regclass('processing.telemetry_jobs') is not null and
    (select count(*) = 5 from pg_roles where rolname in (
      'sherlock_ingest', 'sherlock_normalizer', 'sherlock_reducer',
      'sherlock_reader', 'sherlock_processor'
    )) and
    pg_has_role('postgres', 'sherlock_ingest', 'member') and
    pg_has_role('postgres', 'sherlock_normalizer', 'member') and
    pg_has_role('postgres', 'sherlock_reducer', 'member') and
    pg_has_role('postgres', 'sherlock_processor', 'member') and
    exists (
      select 1 from storage.buckets
      where id = 'telemetry-raw' and public = false
    ) and
    not has_schema_privilege('anon', 'telemetry', 'usage') and
    not has_schema_privilege('anon', 'analytics', 'usage') and
    not has_schema_privilege('authenticated', 'telemetry', 'usage') and
    not has_schema_privilege('authenticated', 'analytics', 'usage') and
    not has_schema_privilege('anon', 'github', 'usage') and
    not has_schema_privilege('authenticated', 'github', 'usage') and
    not has_schema_privilege('anon', 'processing', 'usage') and
    not has_schema_privilege('authenticated', 'processing', 'usage') and
    not has_table_privilege('anon', 'telemetry.ingest_batches', 'select') and
    not has_table_privilege('authenticated', 'telemetry.ingest_batches', 'select') and
    has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'insert') and
    has_table_privilege('sherlock_ingest', 'telemetry.native_records', 'insert') and
    has_column_privilege('sherlock_ingest', 'telemetry.people', 'id', 'insert') and
    has_column_privilege('sherlock_ingest', 'telemetry.people', 'github_id', 'update') and
    not has_column_privilege('sherlock_ingest', 'telemetry.people', 'identity_key', 'update') and
    not has_table_privilege('sherlock_ingest', 'telemetry.people', 'delete') and
    not has_table_privilege('sherlock_ingest', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_ingest', 'analytics.activity_spans', 'insert') and
    has_table_privilege('sherlock_normalizer', 'telemetry.events', 'insert') and
    has_table_privilege('sherlock_normalizer', 'telemetry.sessions', 'select') and
    has_table_privilege('sherlock_normalizer', 'telemetry.sessions', 'update') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'insert') and
    has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'select') and
    has_table_privilege('sherlock_reducer', 'telemetry.events', 'select') and
    not has_table_privilege('sherlock_reducer', 'telemetry.ingest_batches', 'select') and
    not has_table_privilege('sherlock_reducer', 'telemetry.native_records', 'select') and
    has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'insert') and
    not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'update') and
    not has_table_privilege('sherlock_reducer', 'analytics.activity_spans', 'delete') and
    not has_table_privilege('sherlock_reducer', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_reducer', 'telemetry.sessions', 'update') and
    not has_table_privilege('sherlock_reader', 'telemetry.events', 'insert') and
    not has_table_privilege('sherlock_reader', 'telemetry.ingest_batches', 'insert') and
    not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'update') and
    not has_table_privilege('sherlock_ingest', 'telemetry.ingest_batches', 'delete') and
    not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'update') and
    not has_table_privilege('sherlock_normalizer', 'telemetry.events', 'delete') and
    has_table_privilege('sherlock_normalizer', 'telemetry.session_scm', 'insert') and
    not has_table_privilege('sherlock_normalizer', 'telemetry.session_scm', 'update') and
    has_table_privilege('sherlock_processor', 'telemetry.session_scm', 'select') and
    has_table_privilege('sherlock_processor', 'github.commit_pr_lookups', 'insert') and
    not has_table_privilege('sherlock_processor', 'github.commit_pr_lookups', 'update') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'update') and
    not has_table_privilege('sherlock_normalizer', 'analytics.activity_spans', 'delete') and
    has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'select') and
    has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'update') and
    has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'insert') and
    not has_table_privilege('sherlock_processor', 'processing.telemetry_jobs', 'delete') and
    not has_table_privilege('sherlock_processor', 'telemetry.ingest_batches', 'select') and
    has_schema_privilege('sherlock_processor', 'telemetry', 'usage') and
    has_column_privilege(
      'sherlock_processor', 'telemetry.ingest_batches', 'id', 'select'
    ) and
    has_column_privilege(
      'sherlock_processor', 'telemetry.ingest_batches', 'start_offset', 'select'
    ) and
    not has_column_privilege(
      'sherlock_processor', 'telemetry.ingest_batches', 'source_sha256', 'select'
    ) and
    not has_column_privilege(
      'sherlock_processor', 'telemetry.ingest_batches', 'storage_path', 'select'
    ) and
    not exists (
      select 1 from cron.job
      where jobname = 'sherlock-activity-reducer-every-minute' and active
    ) and
    (select bool_and(passed) from constraint_results)
  ) then
    raise exception 'Sherlock schema verification failed';
  end if;
end
$$;

select jsonb_build_object(
  'all_passed', true,
  'assertion_count', 145,
  'tables', 14,
  'private_bucket', 'telemetry-raw'
) as verification;

rollback;
