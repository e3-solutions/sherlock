-- COR-3731: append-only indexed frame evidence projection.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_frame_projector') then
    create role sherlock_frame_projector nologin;
  end if;
end
$$;

create table analytics.frame_projection_receipts (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references telemetry.workspaces (id),
  session_id uuid not null,
  person_id uuid not null,
  frame_version text not null,
  covered_from timestamptz not null,
  covered_through timestamptz not null,
  through_event_id bigint,
  source_event_count bigint not null,
  source_state_sha256 text not null,
  request_generation bigint not null,
  session_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint frame_projection_receipts_scope_key unique (workspace_id, id, session_id, person_id, frame_version),
  constraint frame_projection_receipts_session_person_fkey foreign key (workspace_id, session_id, person_id)
    references telemetry.sessions (workspace_id, id, person_id),
  constraint frame_projection_receipts_through_event_fkey foreign key (workspace_id, session_id, through_event_id)
    references telemetry.events (workspace_id, session_id, id),
  constraint frame_projection_receipts_frame_version_nonempty check (btrim(frame_version) <> ''),
  constraint frame_projection_receipts_coverage_order_check check (covered_through > covered_from),
  constraint frame_projection_receipts_source_event_count_check check (source_event_count >= 0),
  constraint frame_projection_receipts_source_state_sha256_check check (source_state_sha256 ~ '^[0-9a-f]{64}$'),
  constraint frame_projection_receipts_request_generation_check check (request_generation > 0)
);

create table analytics.frame_evidence_revisions (
  id bigint generated always as identity primary key,
  receipt_id bigint not null,
  workspace_id uuid not null,
  session_id uuid not null,
  person_id uuid not null,
  frame_version text not null,
  evidence_kind text not null,
  source_event_id bigint not null,
  anchor_observed_at timestamptz not null,
  observed_at timestamptz not null,
  actor_role text not null,
  event_kind text not null,
  event_subtype text,
  message_role text,
  message_origin text,
  prompt_identity text,
  is_summary_candidate boolean not null,
  is_tombstone boolean not null default false,
  created_at timestamptz not null default now(),
  constraint frame_evidence_revisions_receipt_fkey foreign key (workspace_id, receipt_id, session_id, person_id, frame_version)
    references analytics.frame_projection_receipts (workspace_id, id, session_id, person_id, frame_version),
  constraint frame_evidence_revisions_source_event_fkey foreign key (workspace_id, session_id, source_event_id)
    references telemetry.events (workspace_id, session_id, id),
  constraint frame_evidence_revisions_frame_version_nonempty check (btrim(frame_version) <> ''),
  constraint frame_evidence_revisions_evidence_kind_check check (evidence_kind in ('activity', 'prompt')),
  constraint frame_evidence_revisions_actor_role_check check (actor_role in ('primary', 'worker', 'guardian', 'automation', 'unknown')),
  constraint frame_evidence_revisions_event_kind_nonempty check (btrim(event_kind) <> ''),
  constraint frame_evidence_revisions_optional_labels_nonempty check (
    (event_subtype is null or btrim(event_subtype) <> '') and
    (message_role is null or btrim(message_role) <> '') and
    (message_origin is null or btrim(message_origin) <> '')
  ),
  constraint frame_evidence_revisions_prompt_identity_shape_check check (
    (evidence_kind = 'prompt') = (prompt_identity is not null) and
    (prompt_identity is null or btrim(prompt_identity) <> '')
  ),
  constraint frame_evidence_revisions_summary_candidate_check check (
    not is_summary_candidate or (
      evidence_kind = 'activity' and event_subtype = 'user_message' and
      message_role = 'user' and message_origin in ('human', 'parent_agent')
    )
  )
);

create table analytics.frame_projection_activations (
  workspace_id uuid not null references telemetry.workspaces (id),
  frame_version text not null,
  activated_at timestamptz not null default now(),
  constraint frame_projection_activations_pkey primary key (workspace_id, frame_version),
  constraint frame_projection_activations_frame_version_nonempty check (btrim(frame_version) <> '')
);

create index frame_projection_receipts_latest_idx
  on analytics.frame_projection_receipts (workspace_id, session_id, frame_version, id desc)
  include (person_id, covered_from, covered_through, through_event_id, source_event_count, source_state_sha256, request_generation, session_updated_at);
create index frame_evidence_revisions_reader_idx
  on analytics.frame_evidence_revisions (workspace_id, frame_version, person_id, observed_at, evidence_kind, source_event_id, id desc)
  include (receipt_id, session_id, anchor_observed_at, actor_role, event_kind, event_subtype, message_role, message_origin, is_summary_candidate, is_tombstone);
create index frame_evidence_revisions_window_idx
  on analytics.frame_evidence_revisions (workspace_id, frame_version, anchor_observed_at, evidence_kind, source_event_id, id desc)
  include (receipt_id, person_id, session_id, observed_at, actor_role, event_kind, event_subtype, message_role, message_origin, prompt_identity, is_summary_candidate, is_tombstone);
create index frame_evidence_revisions_session_idx
  on analytics.frame_evidence_revisions (workspace_id, frame_version, person_id, session_id, observed_at, evidence_kind, source_event_id, id desc)
  include (receipt_id, anchor_observed_at, actor_role, event_kind, event_subtype, message_role, message_origin, is_summary_candidate, is_tombstone);
create index frame_evidence_revisions_diff_idx
  on analytics.frame_evidence_revisions (workspace_id, session_id, frame_version, anchor_observed_at, evidence_kind, source_event_id, id desc)
  include (receipt_id, person_id, observed_at, actor_role, event_kind, event_subtype, message_role, message_origin, prompt_identity, is_summary_candidate, is_tombstone);

revoke all on analytics.frame_projection_receipts, analytics.frame_evidence_revisions, analytics.frame_projection_activations
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer, sherlock_reducer, sherlock_processor, sherlock_reader, sherlock_frame_projector;
revoke all on sequence analytics.frame_projection_receipts_id_seq, analytics.frame_evidence_revisions_id_seq
  from public, anon, authenticated, sherlock_ingest, sherlock_normalizer, sherlock_reducer, sherlock_processor, sherlock_reader, sherlock_frame_projector;
revoke all on schema telemetry, analytics from sherlock_frame_projector;
revoke all on all tables in schema telemetry from sherlock_frame_projector;
revoke all on all tables in schema analytics from sherlock_frame_projector;
revoke all on all sequences in schema telemetry from sherlock_frame_projector;
revoke all on all sequences in schema analytics from sherlock_frame_projector;

grant usage on schema telemetry, analytics to sherlock_frame_projector;
grant select on telemetry.sessions, telemetry.events to sherlock_frame_projector;
grant select (
  workspace_id, id, batch_id, record_index, source_start_offset,
  source_end_offset, native_type, native_payload_type
) on telemetry.native_records to sherlock_frame_projector;
grant select (
  workspace_id, id, collector_key, source_kind, source_stream_key,
  generation_key, generation_seq
) on telemetry.ingest_batches to sherlock_frame_projector;
grant select, insert on analytics.frame_projection_receipts, analytics.frame_evidence_revisions to sherlock_frame_projector;
grant usage, select on sequence analytics.frame_projection_receipts_id_seq, analytics.frame_evidence_revisions_id_seq to sherlock_frame_projector;
grant select on analytics.frame_projection_receipts, analytics.frame_evidence_revisions, analytics.frame_projection_activations to sherlock_reader;
grant sherlock_frame_projector to postgres, sherlock_worker_login;

comment on role sherlock_frame_projector is 'Append-only frame projector: reads normalized events and bounded representation-pairing metadata, then writes versioned evidence receipts and revisions.';
comment on table analytics.frame_projection_receipts is 'Append-only proof of the exact bounded session state consumed by one frame projection run.';
comment on column analytics.frame_projection_receipts.source_state_sha256 is 'Deterministic fingerprint of bounded selected evidence and effective session state; completeness uses the separate event maximum and count.';
comment on column analytics.frame_projection_receipts.request_generation is 'Coalesced reduction request generation consumed by this projection run.';
comment on column analytics.frame_projection_receipts.session_updated_at is 'Session-cache revision observed by the projector; activation compares it with current parent and start state.';
comment on table analytics.frame_evidence_revisions is 'Append-only, payload-free frame evidence revisions; PostgreSQL snapshot visibility preserves published results.';
comment on column analytics.frame_evidence_revisions.actor_role is 'Effective projected role, including resolved child-session parentage; not a live join to the mutable session cache.';
comment on column analytics.frame_evidence_revisions.anchor_observed_at is 'Immutable source-event anchor used to constrain canonical representation matching.';
comment on column analytics.frame_evidence_revisions.observed_at is 'Effective display timestamp used for indexed frame selection.';
comment on table analytics.frame_projection_activations is 'Owner-controlled post-backfill fact enabling one immutable frame projection version for a workspace.';
