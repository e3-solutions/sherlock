create schema if not exists product;

-- product is a private direct-Postgres schema, not part of the Data API.
revoke all on schema product from public, anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'sherlock_bottleneck_writer'
  ) then
    create role sherlock_bottleneck_writer
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls connection limit 0;
  end if;
end
$$;

alter role sherlock_bottleneck_writer
  nologin noinherit nocreatedb nocreaterole connection limit 0;

do $$
begin
  if exists (
    select 1 from pg_roles
     where rolname = 'sherlock_bottleneck_writer'
       and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'sherlock_bottleneck_writer has unsafe protected attributes';
  end if;
end
$$;

create table product.bottleneck_submissions (
  workspace_id uuid not null,
  submission_id uuid not null,
  request_sha256 text not null
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  method jsonb not null
    check (jsonb_typeof(method) = 'object')
    check (octet_length(method::text) between 2 and 262144),
  candidates jsonb not null
    check (jsonb_typeof(candidates) = 'array')
    check (jsonb_array_length(candidates) between 0 and 50)
    -- jsonb::text adds separator whitespace after transport JSON is parsed.
    -- Keep that deterministic representation bounded to the 2 MiB transport
    -- ceiling plus 64 KiB of serialization overhead.
    check (octet_length(candidates::text) <= 2162688),
  attribution_mode text generated always as
    ('workspace_shared_bearer'::text) stored,
  trust text generated always as
    ('unverified_client_claim'::text) stored,
  client_claims_verified boolean generated always as (false) stored,
  created_at timestamptz not null default transaction_timestamp()
    check (isfinite(created_at)),
  primary key (workspace_id, submission_id)
);

comment on table product.bottleneck_submissions is
  'Unverified client claims; append-only only at the runtime writer privilege boundary.';

revoke all on all tables in schema product
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema product
  from public, anon, authenticated, service_role;
revoke all on all functions in schema product
  from public, anon, authenticated, service_role;

revoke all on schema product from sherlock_bottleneck_writer;
revoke all on all tables in schema product from sherlock_bottleneck_writer;
revoke all on all sequences in schema product from sherlock_bottleneck_writer;
revoke all on all functions in schema product from sherlock_bottleneck_writer;
revoke all on schema telemetry, analytics, processing from sherlock_bottleneck_writer;
revoke all on all tables in schema telemetry, analytics, processing
  from sherlock_bottleneck_writer;
revoke all on all sequences in schema telemetry, analytics, processing
  from sherlock_bottleneck_writer;
revoke all on all functions in schema telemetry, analytics, processing
  from sherlock_bottleneck_writer;

grant usage on schema product to sherlock_bottleneck_writer;
grant select on product.bottleneck_submissions to sherlock_bottleneck_writer;
grant insert (
  workspace_id, submission_id, request_sha256, method, candidates
) on product.bottleneck_submissions to sherlock_bottleneck_writer;
grant sherlock_bottleneck_writer to sherlock_worker_login
  with inherit false, set true;

alter default privileges in schema product revoke all on tables from public;
alter default privileges in schema product revoke all on sequences from public;
alter default privileges in schema product revoke execute on functions from public;
