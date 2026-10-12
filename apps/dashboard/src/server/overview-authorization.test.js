import { describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { DirectFlameSource, encodeProjectionSnapshotToken, FRAME_VERSION } from './flame-source.js';
import { authorizedFlameRepresentation, flamePayloadRepresentation } from './flame-cache.js';
import { buildFrameOverview } from '../shared/frame-overview.js';

const PERSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = '11111111-1111-4111-8111-111111111111';
const START = Date.parse('2026-10-11T00:00:00Z');
function payload(recovery = false) {
  const counts = Array.from({ length: 144 }, (_, i) => [i === 0 ? 1 : 0, 0, 0, 0]);
  const overview = buildFrameOverview({ personId: PERSON, counts, recoveryHashes: recovery ? ['a'.repeat(64)] : [],
    rows: counts.map((_, i) => ({ person_id: PERSON, bucket_start: new Date(START + i * 600000).toISOString(), work_rows: i ? [] : recovery ? [{ id: `recovery:${SESSION}:agent`, sessionId: SESSION, role: 'agent',
      firstAt: new Date(START + 1).toISOString(), lastAt: new Date(START + 9).toISOString(), eventCount: null, summary: 'Recovered cloud turn activity', evidenceSource: 'completed_turn_interval' }] : [{
      session_id: SESSION, semantic_role: 'agent', first_at: new Date(START + 1).toISOString(), last_at: new Date(START + 9).toISOString(), event_count: 3, is_automated_run: false,
    }] })), summaries: [{ session_id: SESSION, semantic_role: 'agent', summary_event_id: '42', summary: 'Private preview sentinel' }] });
  expect(overview).not.toBeNull();
  return { snapshot: encodeProjectionSnapshotToken({ snapshot: '730:741:733,739', read: new Date(START + 86400000), frameVersion: FRAME_VERSION }),
    people: [{ id: PERSON, buckets: counts, overview }] };
}
function source(grants = []) {
  const source = Object.create(DirectFlameSource.prototype);
  source.workspaceId = PERSON;
  source.expectedEmailDomain = 'e3group.ai';
  source.sql = { wrongPool: true };
  source.overviewSql = { dedicated: true };
  source.transaction = vi.fn(async (callback, options) => {
    expect(options.pool).toBe(source.overviewSql);
    expect(options.statementTimeoutMs).toBe(1000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return callback({ unsafe: vi.fn().mockResolvedValue(grants), array: x => x });
  });
  return source;
}
const grants = [{ kind: 'person', id: PERSON }, { kind: 'session', id: SESSION, person_id: PERSON }, { kind: 'summary', id: '42' }];
describe('fresh cached overview authorization', () => {
  it('rechecks every response and keeps cached bytes only for exact ownership grants', async () => {
    const p = payload(), s = source(grants), result = flamePayloadRepresentation(p);
    expect(await authorizedFlameRepresentation(s, result)).toBe(result);
    expect(await authorizedFlameRepresentation(s, result)).toBe(result);
    expect(s.transaction).toHaveBeenCalledTimes(2);
  });
  it.each(['person', 'session', 'summary'])('revoked %s never reaches either cached encoding', async kind => {
    const p = payload(), result = flamePayloadRepresentation(p);
    const gated = await authorizedFlameRepresentation(source(grants.filter(g => g.kind !== kind)), result);
    expect(gated.identity).not.toBe(result.identity);
    expect(gated.identity.toString()).not.toContain('Private preview sentinel');
    expect(gunzipSync(gated.gzip).toString()).not.toContain('Private preview sentinel');
    expect(gated.payload.people[0].buckets).toEqual(p.people[0].buckets);
    expect(p.people[0].overview).toBeDefined();
  });
  it('authorizes the exact recovery manifest and withholds a revoked manifest', async () => {
    const p = payload(true), recoveryGrant = { kind: 'recovery', id: 'a'.repeat(64), person_id: PERSON };
    expect(await source([...grants, recoveryGrant]).authorizeFrameOverviews(p)).toBe(p);
    const gated = await source(grants).authorizeFrameOverviews(p);
    expect(gated.people[0].overview).toBeUndefined();
    expect(gated.people[0].buckets).toEqual(p.people[0].buckets);
  });
  it('rejects cloned metadata and a visible session owned by someone else', async () => {
    const p = payload(), s = source(grants);
    expect((await s.authorizeFrameOverviews(JSON.parse(JSON.stringify(p)))).people[0].overview).toBeUndefined();
    expect(s.transaction).not.toHaveBeenCalled();
    const moved = source(grants.map(g => g.kind === 'session' ? { ...g, person_id: SESSION } : g));
    expect((await moved.authorizeFrameOverviews(p)).people[0].overview).toBeUndefined();
  });
  it.each(['overviewAuthorizationRequests', 'overviewTransactions'])('fails closed immediately at %s capacity without queuing on the refresh pool', async counter => {
    const s = source(grants); s[counter] = 8;
    expect((await s.authorizeFrameOverviews(payload())).people[0].overview).toBeUndefined();
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it('internal authorization failure preserves counts and releases its concurrency slot', async () => {
    const s = source(grants), p = payload();
    s.transaction.mockRejectedValue(new Error('timeout'));
    expect((await s.authorizeFrameOverviews(p)).people[0]).toEqual({ id: PERSON, buckets: p.people[0].buckets });
    expect(s.overviewAuthorizationRequests).toBe(0);
  });
});

const describeDatabase = process.env.SHERLOCK_TEST_DATABASE_URL ? describe : describe.skip;
describeDatabase('authorization pool saturation', () => {
  it('bounds response latency and retains queued transaction accounting until rollback', async () => {
    const s = new DirectFlameSource({ databaseUrl: process.env.SHERLOCK_TEST_DATABASE_URL, workspaceId: PERSON, expectedEmailDomain: 'e3group.ai' });
    try {
      let occupied = 0;
      let ready;
      const bothOccupied = new Promise(resolve => { ready = resolve; });
      const blockers = [0, 1].map(() => s.transaction(async tx => {
        occupied++; if (occupied === 2) ready();
        await tx.unsafe('select pg_sleep(2)');
      }, { pool: s.overviewSql }));
      await bothOccupied;
      const t = performance.now(), p = payload();
      const gated = await s.authorizeFrameOverviews(p);
      expect(performance.now() - t).toBeLessThan(1900);
      expect(gated.people[0].overview).toBeUndefined();
      expect(s.overviewTransactions).toBeGreaterThanOrEqual(3);
      await Promise.all(blockers);
      // A probe queues behind the aborted authorization's rollback.
      await s.transaction(tx => tx.unsafe('select 1'), { pool: s.overviewSql });
      expect(s.overviewTransactions).toBe(0);
    } finally { await s.close(); }
  });
});
