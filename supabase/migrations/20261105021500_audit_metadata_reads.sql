-- COR-5165 (hunt item 8): the excerpt-read audit also records list_sessions
-- and get_session. They return metadata only, but they name whose sessions
-- exist; the Nov 1 crawl used list_sessions (70 calls) to enumerate the 3,042
-- sessions it then read. One row per session returned, ids only.

alter table sherlock_audit.excerpt_reads drop constraint if exists excerpt_reads_tool_check;
alter table sherlock_audit.excerpt_reads add constraint excerpt_reads_tool_check
  check (tool in (
    'search_sessions', 'get_session_evidence', 'list_prompt_evidence', 'list_sessions', 'get_session'
  ));
