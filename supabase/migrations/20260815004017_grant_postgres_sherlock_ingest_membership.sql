-- SUPABASE_DB_URL authenticates deployed Edge Functions as the project postgres
-- login. Membership permits the ingest function to drop into the deliberately
-- constrained no-login role before writing auditable source facts.
grant sherlock_ingest to postgres;
