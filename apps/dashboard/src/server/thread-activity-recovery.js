import { BUCKET_MS, BUCKET_COUNT, FlameSourceError } from "./flame-source.js";

export const RECOVERY_SQL = `
select b.id::text, b.person_id::text, b.manifest_text, b.manifest_sha256,
       coalesce((select array_agg(s.native_session_id) from telemetry.sessions s
         where s.workspace_id = b.workspace_id
           and pg_visible_in_snapshot(s.xmin::text::xid8, $3::pg_snapshot)
           and s.native_session_id in (select item->>'threadId' from jsonb_array_elements(b.manifest_text::jsonb->'sessions') item)), '{}') native_ids
from telemetry.thread_activity_recovery_batches b
join telemetry.people pe on pe.id=b.person_id and pe.workspace_id=b.workspace_id
where b.workspace_id=$1 and b.imported_at <= $2::timestamptz
  and pg_visible_in_snapshot(b.xmin::text::xid8, $3::pg_snapshot)
  and pe.github_id is distinct from 'sherlock-smoke'
  and split_part(pe.email,'@',2)=$4 and split_part(pe.email,'@',3)=''
order by b.imported_at desc, b.id desc limit 101`;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function recoveredIntervals(rows, { readAt = Infinity } = {}) {
  if (rows.length > 100) throw new FlameSourceError("flame_database_result_incomplete");
  const intervals = [];
  for (const row of rows) {
    const manifest = JSON.parse(row.manifest_text);
    if (manifest.schemaVersion !== "thread-api-timing-manifest-v1" || !Array.isArray(manifest.sessions)) {
      throw new FlameSourceError("flame_database_result_invalid");
    }
    if (!UUID.test(manifest.rootThreadId) || manifest.sessions.length > 200) throw new FlameSourceError("flame_database_result_invalid");
    const native = new Set(row.native_ids ?? []);
    const started = new Set(manifest.startedWorkerThreadIds ?? []);
    for (const session of manifest.sessions) {
      const role = session.threadId === manifest.rootThreadId ? "agent"
        : started.has(session.threadId) ? "subagent" : null;
      if (!role || native.has(session.threadId)) continue;
      if (!UUID.test(session.threadId)) throw new FlameSourceError("flame_database_result_invalid");
      for (const turn of session.turns ?? []) {
        if (!UUID.test(turn.id)) throw new FlameSourceError("flame_database_result_invalid");
        const ongoing = turn.status === "inProgress" && turn.completedAt == null;
        const endAt = ongoing ? turn.observedAt : turn.completedAt;
        if ((!ongoing && !["completed", "interrupted", "failed"].includes(turn.status)) ||
            !Number.isSafeInteger(turn.startedAt) || !Number.isSafeInteger(endAt) ||
            turn.startedAt <= 0 || endAt <= turn.startedAt ||
            endAt*1000 > Math.min(8.64e15, readAt)) continue;
        if (ongoing && !(manifest.sourcePages ?? []).some(page =>
          page.sha256 === turn.sourcePageSha256 && page.observedAt === endAt)) continue;
        intervals.push({personId:row.person_id, threadId:session.threadId, turnId:turn.id,
          role, startMs:turn.startedAt*1000, endMs:endAt*1000, ongoing, observedAt:turn.observedAt ?? 0, sourceHash:row.manifest_sha256});
      }
    }
  }
  const seen = new Set();
  return intervals.sort((a,b)=>Number(a.ongoing)-Number(b.ongoing) || b.observedAt-a.observedAt || b.endMs-a.endMs).filter(interval=>{
    const key = `${interval.personId}:${interval.threadId}:${interval.turnId}`;
    if (seen.has(key)) return false;
    seen.add(key);return true;
  });
}
export async function readRecovery(tx, { workspaceId, read, snapshot, expectedEmailDomain }) {
  return recoveredIntervals(await tx.unsafe(RECOVERY_SQL, [workspaceId, new Date(read).toISOString(), snapshot, expectedEmailDomain]), { readAt:new Date(read).getTime() });
}
export function mergeRecoveredTimeline(payload, intervals) {
  const start = Date.parse(payload.start), end = start + BUCKET_COUNT * BUCKET_MS;
  const relevant = intervals.filter(i=>i.startMs < end && i.endMs > start);
  if (!relevant.length) return payload;
  const people = payload.people.map(person=> {
    const owned = relevant.filter(i=>i.personId===person.id);
    if (!owned.length) return person;
    const distinct = roles=>new Set(owned.filter(i=>roles.includes(i.role)).map(i=>i.threadId)).size;
    const buckets = person.buckets.map((bucket,index)=> {
      const lo=start+index*BUCKET_MS, hi=lo+BUCKET_MS;
      const count=role=>new Set(owned.filter(i=>i.role===role && i.startMs<hi && i.endMs>lo).map(i=>i.threadId)).size;
      return [bucket[0]+count("agent"),bucket[1]+count("subagent"),bucket[2],bucket[3]];
    });
    const recoveredLatest = Math.max(...owned.map(i=>i.endMs));
    const nativeLatest = person.lastActivity == null ? null : Date.parse(person.lastActivity);
    const lastActivity = new Date(Math.max(nativeLatest ?? recoveredLatest, recoveredLatest)).toISOString();
    return {...person, lastActivity, buckets, total:[person.total[0]+distinct(["agent"]),person.total[1]+distinct(["subagent"]),person.total[2]],
      activeSeconds:buckets.filter(b=>b.slice(0,3).some(n=>n>0)).length*BUCKET_MS/1000};
  });
  const ongoing = relevant.some(i=>i.ongoing), completed = relevant.filter(i=>!i.ongoing);
  return {...payload,people,coverage:{...payload.coverage,evidence:"observed_events_and_recovered_turn_intervals"},recovery:{
    basis:ongoing ? "recovered_observed_turn_intervals" : "recovered_completed_turn_intervals",
    sourceHashes:[...new Set(relevant.map(i=>i.sourceHash))],
    ...(completed.length ? {latestCompletedAt:new Date(Math.max(...completed.map(i=>i.endMs))).toISOString()} : {}),
    ...(ongoing ? {latestObservedAt:new Date(Math.max(...relevant.filter(i=>i.ongoing).map(i=>i.endMs))).toISOString()} : {})}};
}
export function recoveredIntervalWork(intervals, personId, startMs) {
  const endMs=startMs+BUCKET_MS, threads=new Map();
  for(const interval of intervals) {
    if(interval.personId!==personId || interval.startMs>=endMs || interval.endMs<=startMs) continue;
    const key=interval.threadId, previous=threads.get(key);
    const firstAt=Math.max(startMs,interval.startMs), lastAt=Math.min(endMs-1,interval.endMs-1);
    threads.set(key,{id:`recovery:${key}:${interval.role}`,sessionId:key,role:interval.role,
      firstAt:new Date(Math.min(previous ? Date.parse(previous.firstAt) : firstAt, firstAt)).toISOString(),
      lastAt:new Date(Math.max(previous ? Date.parse(previous.lastAt) : lastAt, lastAt)).toISOString(),
      eventCount:null,summary:"Recovered cloud turn activity", evidenceSource:interval.ongoing || previous?.evidenceSource === "observed_ongoing_turn_interval" ? "observed_ongoing_turn_interval" : "completed_turn_interval"});
  }
  return [...threads.values()];
}
