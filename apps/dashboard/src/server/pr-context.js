// Product projection only: native transcripts, activity and audit facts are never
// edited here. Every fact that can affect a pinned answer uses MVCC visibility.
export const INTERVAL_LINKED_PRS_SQL = `
with p as materialized (
  select $1::uuid workspace_id, $2::pg_snapshot snapshot, $3::uuid[] session_ids
), visible as materialized (
  select f.* from telemetry.session_pr_context_events f cross join p
   where f.workspace_id = p.workspace_id
     and exists (
       select 1 from telemetry.sessions s where s.workspace_id = p.workspace_id
         and s.id = any(p.session_ids) and s.collector_key = f.collector_key
         and s.native_session_id = f.native_session_id
     )
     and pg_visible_in_snapshot(f.xmin::text::xid8, p.snapshot)
), accepted as materialized (
  select f.* from visible f where f.disposition = 'accepted'
    and not exists (
      select 1 from telemetry.session_pr_context_events conflict cross join p
       where conflict.workspace_id = p.workspace_id
         and conflict.collector_key = f.collector_key
         and conflict.event_id = f.event_id and conflict.disposition = 'conflict'
         and pg_visible_in_snapshot(conflict.xmin::text::xid8, p.snapshot)
    )
), links as (
  select s.id session_id, f.*
    from p join telemetry.sessions s on s.workspace_id = p.workspace_id
    join accepted f on f.collector_key = s.collector_key
      and f.native_session_id = s.native_session_id and f.person_id = s.person_id
      and s.role_version = case f.source_provider
        when 'codex' then 'sherlock.codex-role.v1'
        else 'sherlock.claude-code-role.v1' end
   where s.id = any(p.session_ids) and f.operation = 'link'
     and not exists (
       select 1 from telemetry.events e
        where e.workspace_id = s.workspace_id and e.session_id = s.id
          and pg_visible_in_snapshot(e.xmin::text::xid8, p.snapshot)
          and case f.source_provider when 'codex'
            then e.normalizer_version like 'sherlock.claude-code-%'
            else e.normalizer_version like 'sherlock.codex-%' end
     )
     and not exists (
       select 1 from visible r where r.operation = 'retract'
         and r.disposition in ('accepted', 'conflict')
         and r.collector_key = f.collector_key and r.person_id = f.person_id
         and r.source_provider = f.source_provider
         and r.native_session_id = f.native_session_id
         and r.link_event_id = f.event_id
     )
), checked as (
  select l.session_id, l.repository_full_name, l.pull_request_number,
         coalesce(v.outcome, 'pending') status, v.created_at checked_at,
         row_number() over (partition by l.session_id, l.repository_full_name,
           l.pull_request_number order by v.id desc nulls last,
           l.source_record_id desc) duplicate_rank
    from links l cross join p
    left join lateral (
      select v.id, v.outcome, v.created_at from github.pr_context_verifications v
       where v.workspace_id = p.workspace_id
         and v.link_source_record_id = l.source_record_id
         and pg_visible_in_snapshot(v.xmin::text::xid8, p.snapshot)
       order by v.id desc limit 1
    ) v on true
), bounded as (
  select *, row_number() over (partition by session_id
    order by repository_full_name, pull_request_number) session_rank
    from checked where duplicate_rank = 1
)
select session_id::text, repository_full_name, pull_request_number, status, checked_at
  from bounded where session_rank <= 51
 order by session_id, repository_full_name, pull_request_number
`;

export function linkedPrsBySession(rows, fromRow, invalid) {
  const bySession = new Map();
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const context = bySession.get(sessionId) ?? { links: [], truncated: false };
    if (context.links.length === 50) {
      context.truncated = true;
      continue;
    }
    if (![
      "pending", "checked", "inaccessible", "failed", "identity_mismatch", "out_of_scope",
    ].includes(row.status)) throw invalid();
    const pr = fromRow(row);
    context.links.push({
      number: pr.number, repository: String(row.repository_full_name),
      url: row.status === "checked" ? pr.url : null, status: row.status,
      checkedAt: row.checked_at === null ? null : new Date(row.checked_at).toISOString(),
    });
    bySession.set(sessionId, context);
  }
  return bySession;
}
