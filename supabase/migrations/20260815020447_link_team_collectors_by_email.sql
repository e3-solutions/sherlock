alter table telemetry.people
  add column github_id text;

alter table telemetry.people
  add constraint people_github_id_normalized check (
    github_id is null or (
      github_id = lower(btrim(github_id)) and
      github_id ~ '^[a-z0-9][a-z0-9-]{0,38}$'
    )
  );

grant insert (
  id,
  workspace_id,
  identity_key,
  display_name,
  email,
  github_id
) on telemetry.people to sherlock_ingest;

grant update (
  display_name,
  email,
  github_id
) on telemetry.people to sherlock_ingest;
