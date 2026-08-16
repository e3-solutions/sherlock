do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sherlock_reducer') then
    create role sherlock_reducer nologin;
  end if;
end
$$;

alter table telemetry.sessions
  add constraint sessions_workspace_id_id_person_id_key
  unique (workspace_id, id, person_id);

alter table analytics.activity_spans
  drop constraint activity_spans_session_fkey,
  add constraint activity_spans_session_person_fkey foreign key (
    workspace_id, session_id, person_id
  ) references telemetry.sessions (workspace_id, id, person_id);

revoke insert on analytics.activity_spans from sherlock_normalizer;
revoke usage, select on sequence analytics.activity_spans_id_seq
  from sherlock_normalizer;

revoke all on schema telemetry from sherlock_reducer;
revoke all on schema analytics from sherlock_reducer;
revoke all on all tables in schema telemetry from sherlock_reducer;
revoke all on all tables in schema analytics from sherlock_reducer;
revoke all on all sequences in schema telemetry from sherlock_reducer;
revoke all on all sequences in schema analytics from sherlock_reducer;

grant usage on schema telemetry, analytics to sherlock_reducer;
grant select on telemetry.sessions, telemetry.events to sherlock_reducer;
grant select, insert on analytics.activity_spans to sherlock_reducer;
grant usage, select on sequence analytics.activity_spans_id_seq
  to sherlock_reducer;

grant sherlock_reducer to postgres;

comment on role sherlock_reducer is
  'Internal append-only reducer: reads normalized session events and writes activity spans.';
comment on constraint activity_spans_session_person_fkey
  on analytics.activity_spans is
  'Keeps copied person attribution identical to the owning session within a workspace.';
