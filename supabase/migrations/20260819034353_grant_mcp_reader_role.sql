-- The shared server login has NOINHERIT, so MCP transactions must opt into the
-- existing read-only product role explicitly. This adds no table privileges.
grant sherlock_reader to sherlock_worker_login;
