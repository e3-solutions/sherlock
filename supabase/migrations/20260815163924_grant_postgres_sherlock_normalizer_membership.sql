-- SUPABASE_DB_URL authenticates deployed Edge Functions as the project postgres
-- login. Grant only the ability to assume the constrained normalization role.
grant sherlock_normalizer to postgres;
