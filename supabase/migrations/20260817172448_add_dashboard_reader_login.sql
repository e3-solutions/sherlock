do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'sherlock_dashboard_login'
  ) then
    create role sherlock_dashboard_login login noinherit;
  else
    alter role sherlock_dashboard_login login noinherit;
  end if;
end
$$;

revoke all on schema telemetry, analytics from sherlock_dashboard_login;
revoke all on all tables in schema telemetry from sherlock_dashboard_login;
revoke all on all tables in schema analytics from sherlock_dashboard_login;
revoke all on all sequences in schema telemetry from sherlock_dashboard_login;
revoke all on all sequences in schema analytics from sherlock_dashboard_login;

grant sherlock_reader to sherlock_dashboard_login;

comment on role sherlock_dashboard_login is
  'Railway dashboard login: NOINHERIT and may assume only the read-only Sherlock reader role.';
