alter table github.commit_pr_lookups
  add column error_code text;

alter table github.commit_pr_lookups
  add constraint commit_pr_lookups_error_code_check check (
    error_code is null or (
      outcome = 'failed' and
      char_length(error_code) <= 128 and
      error_code ~ '^[a-z0-9_]+$'
    )
  );

comment on column github.commit_pr_lookups.error_code is
  'Normalized internal failure classification; never raw provider response text.';
