-- btree_gin lets one GIN index hold a scalar column next to a tsvector, so a
-- date-ranged excerpt search can match the window and the words in a single
-- index scan (COR-5172). Installed in the extensions schema like pg_net.
create extension if not exists btree_gin with schema extensions;
