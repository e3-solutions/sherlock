-- COR-5178: the excerpt-read audit also records the new Sherlock presence
-- tool (who is active, and one person's last activity). It returns names and
-- times only; one row per person returned, ids only, like list_sessions.

set lock_timeout = '1s';

alter table sherlock_audit.excerpt_reads drop constraint if exists excerpt_reads_tool_check;
alter table sherlock_audit.excerpt_reads add constraint excerpt_reads_tool_check
  check (tool in (
    'search_sessions', 'get_session_evidence', 'list_prompt_evidence', 'list_sessions', 'get_session',
    'presence'
  ));
