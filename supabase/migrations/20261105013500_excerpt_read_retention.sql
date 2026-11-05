-- COR-5165: keep the excerpt-read audit for one year (Vansh, Nov 5 2026:
-- "1 year fine"). A daily pg_cron job deletes rows read more than a year ago.
-- read_at is clamped to within an hour of recorded_at on insert, so it is a
-- reliable age.

create index if not exists excerpt_reads_read_at_idx
  on sherlock_audit.excerpt_reads (read_at);

create extension if not exists pg_cron;
select cron.schedule(
  'sherlock-excerpt-read-retention',
  '17 3 * * *',
  $cron$ delete from sherlock_audit.excerpt_reads where read_at < now() - interval '1 year'; $cron$
);
