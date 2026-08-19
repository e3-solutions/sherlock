-- The shared server login has NOINHERIT, so MCP transactions must opt into the
-- existing read-only product role explicitly. The local/CI postgres login also
-- needs membership to exercise the same role in integration tests. This adds
-- no table privileges to either login beyond the role's existing read grants.
grant sherlock_reader to postgres, sherlock_worker_login;
