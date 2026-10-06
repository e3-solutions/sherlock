-- Origin metadata must follow the session's read visibility, including any
-- environment-specific private-session policies. Never grant an origin lookup
-- broader access than its source session.
alter policy bonaparte_run_classification_read on analytics.bonaparte_run_classifications
  using (exists (
    select 1 from telemetry.sessions s
     where s.workspace_id = bonaparte_run_classifications.workspace_id
       and s.id = bonaparte_run_classifications.session_id
  ));
