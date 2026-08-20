alter table telemetry.ingest_batches
  add column source_provider text not null default 'codex',
  add column source_version text,
  add column observed_parent_native_session_id text;

update telemetry.ingest_batches
set source_version = codex_version
where source_provider = 'codex' and source_version is null;

alter table telemetry.ingest_batches
  drop constraint ingest_batches_source_kind_check,
  add constraint ingest_batches_source_kind_check check (
    source_kind in ('rollout', 'transcript', 'hook', 'collector')
  ),
  add constraint ingest_batches_source_provider_check check (
    source_provider in ('codex', 'claude_code')
  ),
  add constraint ingest_batches_provider_kind_check check (
    (source_provider = 'codex' and source_kind = 'rollout') or
    (source_provider = 'claude_code' and source_kind = 'transcript') or
    source_kind in ('hook', 'collector')
  ),
  add constraint ingest_batches_source_hints_nonempty check (
    (source_version is null or btrim(source_version) <> '') and
    (
      observed_parent_native_session_id is null or
      btrim(observed_parent_native_session_id) <> ''
    )
  );

comment on column telemetry.ingest_batches.source_provider is
  'Immutable source-system identity. Product-specific normalizers dispatch on this field.';
comment on column telemetry.ingest_batches.source_version is
  'Optional native source client version; codex_version remains for backward compatibility.';
comment on column telemetry.ingest_batches.observed_parent_native_session_id is
  'Hook-supplied parent identity hint, used for provider-native child transcripts.';
