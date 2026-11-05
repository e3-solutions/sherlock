-- Statistics for the new day expression (events_message_search_day_idx)
-- exist only after the table is analyzed; until then the planner guesses its
-- selectivity and may keep the text-only GIN. telemetry.events was last
-- auto-analyzed on Oct 30 with 3.1M rows changed since, so this also does the
-- refresh autovacuum is about to do.
set statement_timeout = 0;
analyze telemetry.events;
reset statement_timeout;
