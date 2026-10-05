import { it, expect } from "vitest";
import { recoveredIntervals, mergeRecoveredTimeline, recoveredIntervalWork, RECOVERY_SQL } from "./thread-activity-recovery.js";
const start=Date.parse('2026-10-05T04:00:00Z')/1000;
const ids={root:'00000000-0000-7000-8000-000000000001',worker:'00000000-0000-7000-8000-000000000002',unrelated:'00000000-0000-7000-8000-000000000003'};
function row(sessions, native_ids=[]) {return {person_id:'owner',manifest_sha256:'hash',native_ids:native_ids.map(id=>ids[id]),manifest_text:JSON.stringify({schemaVersion:'thread-api-timing-manifest-v1',rootThreadId:ids.root,startedWorkerThreadIds:[ids.worker],sessions:sessions.map(s=>({...s,threadId:ids[s.threadId]}))})};}
const turn=(id,a,b,status='completed')=>({id:'00000000-0000-7000-8000-'+id.charCodeAt(0).toString(16).padStart(12,'0'),startedAt:start+a,completedAt:b===null?null:start+b,status});
function base() {return {start:new Date(start*1000).toISOString(),people:[{id:'owner',name:'Person',total:[0,0,0],activeSeconds:0,buckets:Array.from({length:144},()=>[0,0,0,0])},{id:'other',total:[0,0,0],activeSeconds:0,buckets:Array.from({length:144},()=>[0,0,0,0])}]};}
it('deduplicates turns/pages and threads, preserves pauses and half-open boundaries',()=>{
 const input=row([{threadId:'root',turns:[turn('a',0,600),turn('b',1200,1300)]},{threadId:'worker',turns:[turn('x',0,300),turn('y',400,500),turn('z',1300,1400)]}]);
 const intervals=recoveredIntervals([input,input]);expect(intervals).toHaveLength(5);
 const payload=mergeRecoveredTimeline(base(),intervals);
 expect(payload.people[0].buckets.slice(0,4)).toEqual([[1,1,0,0],[0,0,0,0],[1,1,0,0],[0,0,0,0]]);
 expect(payload.people[0].total).toEqual([1,1,0]);expect(payload.people[0].activeSeconds).toBe(1200);expect(payload.people[1]).toEqual(base().people[1]);
 expect(recoveredIntervalWork(intervals,'owner',(start+600)*1000)).toEqual([]);
 expect(recoveredIntervalWork(intervals,'owner',start*1000)).toHaveLength(2);
 expect(recoveredIntervalWork(intervals,'owner',start*1000)[0].eventCount).toBeNull();
});
it('excludes missing/reversed/live lifecycle, unknown workers, and already-native threads',()=>{
 const intervals=recoveredIntervals([row([{threadId:'root',turns:[turn('a',0,null,'inProgress'),turn('b',20,10)]},{threadId:'worker',turns:[turn('c',0,600)]},{threadId:'unrelated',turns:[turn('d',0,600)]}],['worker'])]);expect(intervals).toEqual([]);
 expect(mergeRecoveredTimeline(base(),[])).toEqual(base());
});
it('combines native bucket counts without inventing prompts or token facts',()=>{
 const payload=base();payload.people[0].buckets[0]=[2,3,0,4];payload.people[0].total=[2,3,0];
 const output=mergeRecoveredTimeline(payload,recoveredIntervals([row([{threadId:'worker',turns:[turn('a',0,600)]}])]));
 expect(output.people[0].buckets[0]).toEqual([2,4,0,4]);expect(output.people[0].total).toEqual([2,4,0]);expect(output.recovery.basis).toBe('recovered_completed_turn_intervals');
});
it('uses the latest native or recovered activity for recency without changing other people',()=>{
 const payload=base();payload.people[0].lastActivity=new Date((start+100)*1000).toISOString();
 const intervals=recoveredIntervals([row([{threadId:'root',turns:[turn('a',0,600)]}])]);
 const output=mergeRecoveredTimeline(payload,intervals);
 expect(output.people[0].lastActivity).toBe(new Date((start+600)*1000).toISOString());
 expect(output.people[1]).toEqual(payload.people[1]);
 payload.people[0].lastActivity=new Date((start+900)*1000).toISOString();
 expect(mergeRecoveredTimeline(payload,intervals).people[0].lastActivity).toBe(payload.people[0].lastActivity);
 payload.people[0].lastActivity=null;
 expect(mergeRecoveredTimeline(payload,intervals).people[0].lastActivity).toBe(new Date((start+600)*1000).toISOString());
});
it('pins manifest visibility to source snapshot/read and configured roster',()=>{
 expect(RECOVERY_SQL).toContain('pg_visible_in_snapshot(s.xmin::text::xid8, $3::pg_snapshot)');expect(RECOVERY_SQL).toContain('b.imported_at <= $2');expect(RECOVERY_SQL).toContain('b.workspace_id=$1');expect(RECOVERY_SQL).toContain('sherlock-smoke');expect(RECOVERY_SQL).toContain("split_part(pe.email,'@',2)=$4");
});
it('bounds an ongoing turn to its retained page observation and snapshot read',()=>{
 const input=row([{threadId:'root',turns:[{...turn('a',0,null,'inProgress'),observedAt:start+1200,sourcePageSha256:'page'}]}]);
 const manifest=JSON.parse(input.manifest_text);manifest.sourcePages=[{sha256:'page',observedAt:start+1200}];input.manifest_text=JSON.stringify(manifest);
 expect(recoveredIntervals([input],{readAt:(start+1199)*1000})).toEqual([]);
 const intervals=recoveredIntervals([input],{readAt:(start+1200)*1000});
 expect(intervals).toHaveLength(1);
 const payload=mergeRecoveredTimeline(base(),intervals);
 expect(payload.people[0].buckets.slice(0,3)).toEqual([[1,0,0,0],[1,0,0,0],[0,0,0,0]]);
 expect(payload.recovery.basis).toBe('recovered_observed_turn_intervals');
 expect(payload.recovery.latestCompletedAt).toBeUndefined();
 expect(payload.recovery.latestObservedAt).toBe(new Date((start+1200)*1000).toISOString());
 expect(recoveredIntervalWork(intervals,'owner',start*1000)[0].evidenceSource).toBe('observed_ongoing_turn_interval');
 manifest.sourcePages=[];input.manifest_text=JSON.stringify(manifest);expect(recoveredIntervals([input])).toEqual([]);
});
it('uses the refreshed completed turn instead of its older ongoing observation',()=>{
 const ongoing=row([{threadId:'root',turns:[{...turn('a',0,null,'inProgress'),observedAt:start+600,sourcePageSha256:'page'}]}]);
 const manifest=JSON.parse(ongoing.manifest_text);manifest.sourcePages=[{sha256:'page',observedAt:start+600}];ongoing.manifest_text=JSON.stringify(manifest);
 const completed=row([{threadId:'root',turns:[turn('a',0,900)]}]);
 expect(recoveredIntervals([completed,ongoing])).toHaveLength(1);
 expect(recoveredIntervals([ongoing,completed])[0]).toMatchObject({endMs:(start+900)*1000,ongoing:false});
 expect(recoveredIntervals([completed,ongoing])[0]).toMatchObject({endMs:(start+900)*1000,ongoing:false});
});
