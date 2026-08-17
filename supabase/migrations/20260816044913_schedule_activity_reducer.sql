-- A late-visible lower event ID can legitimately correct a span without
-- increasing the session's maximum visible event ID. Keep every correction
-- auditable and let the reducer's per-session lock make exact reruns no-ops.
drop index analytics.activity_spans_latest_version_idx;
create index activity_spans_latest_version_idx
  on analytics.activity_spans (
    workspace_id, activity_version, span_key, valid_from_event_id desc, id desc
  );

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Provision these named Vault values before rollout:
--   sherlock_project_url: https://<project-ref>.supabase.co
--   sherlock_activity_reducer_token: a dedicated random invocation token.
-- Configure only its SHA-256 digest as the Edge Function's
-- SHERLOCK_ACTIVITY_REDUCER_TOKEN_SHA256 secret, so the caller token remains
-- readable only to Vault.
-- Missing Vault values fail closed: net.http_post is strict and queues no
-- request when its URL or headers are null.
select cron.schedule(
  'sherlock-activity-reducer-every-minute',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'sherlock_project_url'
        order by created_at desc
        limit 1
      ) || '/functions/v1/sherlock-activity-reducer',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sherlock-job-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'sherlock_activity_reducer_token'
          order by created_at desc
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ) as request_id;
  $cron$
);
