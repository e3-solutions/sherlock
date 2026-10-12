import { describe, expect, it } from 'vitest';
import { buildFrameOverview, decodeFrameOverview, filterAuthorizedOverview, getOverviewAuthorization, overviewMatchesEvidence, previewSummary, limitFrameOverviewPayload } from '../shared/frame-overview.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PERSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'a'.repeat(64);
const START = Date.parse('2026-10-12T00:00:00.000Z');
function fixture() {
  return {
    personId: PERSON,
    rows: Array.from({ length: 144 }, (_, i) => ({ person_id: PERSON, bucket_start: new Date(START + i * 600000).toISOString(), work_rows: [] })),
    summaries: [{ session_id: SESSION, semantic_role: 'agent', summary_event_id: '42', summary: 'Experiment with OCR' }],
    counts: Array.from({ length: 144 }, () => [0, 0, 0, 0]),
  };
}
function native(i = 0, extra = {}) {
  return { session_id: SESSION, semantic_role: 'agent', first_at: new Date(START + i * 600000 + 1).toISOString(),
    last_at: new Date(START + i * 600000 + 9).toISOString(), event_count: 3, is_automated_run: false, ...extra };
}
function populated() {
  const input = fixture();
  for (const i of [0, 1]) { input.rows[i].work_rows = [native(i)]; input.counts[i] = [1, 0, 0, 0]; }
  return input;
}
function decode(value, input = populated()) {
  return decodeFrameOverview(value, { startMs: START, counts: input.counts });
}

describe('snapshot frame overview', () => {
  it('rejects mismatched owners and requires current recovery manifest grants', () => {
    const wrong = populated(); wrong.rows[1].person_id = SESSION;
    expect(buildFrameOverview(wrong)).toBeNull();
    const view = buildFrameOverview(populated());
    expect(filterAuthorizedOverview(view, { personId: SESSION, recoveryHashes: [], sessionIds: [SESSION], summaryEventIds: ['42'] })).toBeNull();
    const recovered = fixture(); recovered.recoveryHashes = [HASH]; recovered.counts[0][0] = 1;
    recovered.rows[0].work_rows = [{ id: `recovery:${SESSION}:agent`, sessionId: SESSION, role: 'agent',
      firstAt: new Date(START).toISOString(), lastAt: new Date(START + 10).toISOString(),
      eventCount: null, summary: 'Recovered cloud turn activity', evidenceSource: 'completed_turn_interval' }];
    const packed = buildFrameOverview(recovered);
    expect(packed).not.toBeNull();
    const grant = { personId: PERSON, recoveryHashes: [HASH], sessionIds: [], summaryEventIds: [] };
    expect(filterAuthorizedOverview(packed, grant)).toBe(packed);
    expect(filterAuthorizedOverview(packed, { ...grant, recoveryHashes: [] })).toBeNull();
  });
  it('omits only the bucket whose automation tally disagrees', () => {
    const input = populated(); input.automatedRuns = [1, 0];
    const packed = buildFrameOverview(input);
    expect(packed.omitted).toEqual([0]);
    expect(decode(packed, input)[1]).toHaveLength(1);
  });

  it('caps workspace preview bytes without mutating the cached payload', () => {
    const overview = buildFrameOverview(populated());
    const payload = { people: [{ id: 'one', overview }, { id: 'two', overview }] };
    const limited = limitFrameOverviewPayload(payload, new TextEncoder().encode(JSON.stringify(overview)).length);
    expect(limited.people[0].overview).toBe(overview);
    expect(limited.people[1].overview).toBeUndefined();
    expect(payload.people[1].overview).toBe(overview);
  });
  it('counts automated sessions once when one session has two semantic roles', () => {
    const input = fixture();
    input.rows[0].work_rows = [native(0, { is_automated_run: true }), native(0, { semantic_role: 'subagent', is_automated_run: true })];
    input.counts[0] = [1, 1, 0, 0]; input.automatedRuns = [1];
    const packed = buildFrameOverview(input);
    const decoded = decodeFrameOverview(packed, { startMs: START, counts: input.counts, automatedRuns: [1] });
    expect(decoded[0]).toHaveLength(2);
    expect(decoded[0].every(row => row.automatedRun)).toBe(true);
  });

  it('deduplicates session summaries and round-trips exact bucket facts', () => {
    const input = populated(), view = buildFrameOverview(input);
    expect(view.sessions).toHaveLength(1); expect(view.summaries).toEqual(['Experiment with OCR']);
    const rows = decode(view);
    expect(rows[0][0]).toMatchObject({ id: `${SESSION}:agent`, firstAtMs: START + 1, lastAtMs: START + 9, eventCount: 3 });
    expect(rows[1][0].firstAtMs).toBe(START + 600001);
    expect(rows[2]).toEqual([]);
    expect(Object.isFrozen(view.buckets[0][0])).toBe(true);
  });
  it('requires fresh session and source-event authorization and does not serialize its references', () => {
    const view = buildFrameOverview(populated());
    expect(getOverviewAuthorization(view)).toEqual({ personId: PERSON, recoveryHashes: [], sessionIds: [SESSION], summaryEventIds: ['42'] });
    expect(JSON.stringify(view)).not.toContain('summaryEventIds');
    expect(getOverviewAuthorization(JSON.parse(JSON.stringify(view)))).toBeNull();
    expect(filterAuthorizedOverview(view, { personId: PERSON, recoveryHashes: [], sessionIds: [SESSION], summaryEventIds: ['42'] })).toBe(view);
    expect(filterAuthorizedOverview(view, { personId: PERSON, recoveryHashes: [], sessionIds: [], summaryEventIds: ['42'] })).toBeNull();
    expect(filterAuthorizedOverview(view, { personId: PERSON, recoveryHashes: [], sessionIds: [SESSION], summaryEventIds: [] })).toBeNull();
  });
  it('marks overflow and mismatched counts unavailable instead of presenting truncated or empty work', () => {
    const input = populated(); input.counts[0] = [2, 0, 0, 0];
    const view = buildFrameOverview(input);
    expect(view.omitted).toEqual([0]); expect(decode(view, input)[0]).toBeNull();
    expect(buildFrameOverview({ ...populated(), workLimit: 0 })).toBeNull();
    const over = populated(); over.rows[0].work_rows.push(native(0, { session_id: '22222222-2222-4222-8222-222222222222' })); over.counts[0][0] = 2;
    expect(buildFrameOverview({ ...over, workLimit: 1 }).omitted).toEqual([0]);
  });
  it('preserves changing automation and recovered provenance per bucket', () => {
    const input = fixture(); input.recoveryHashes = [HASH];
    for (const [i, evidenceSource] of ['completed_turn_interval', 'observed_ongoing_turn_interval'].entries()) {
      input.rows[i].work_rows = [{ id: `recovery:${SESSION}:agent`, sessionId: SESSION, role: 'agent',
        firstAt: new Date(START + i * 600000).toISOString(), lastAt: new Date(START + i * 600000 + 10).toISOString(),
        eventCount: null, summary: 'Recovered cloud turn activity', evidenceSource }];
      input.counts[i][0] = 1;
    }
    const view = buildFrameOverview(input), rows = decode(view, input);
    expect(rows[0][0].evidenceSource).toBe('completed_turn_interval');
    expect(rows[1][0].evidenceSource).toBe('observed_ongoing_turn_interval');
    expect(getOverviewAuthorization(view).sessionIds).toEqual([]);
    const automated = populated(); automated.rows[1].work_rows[0].is_automated_run = true;
    automated.automatedRuns = [0, 1];
    const packed = buildFrameOverview(automated);
    expect(decodeFrameOverview(packed, { startMs: START, counts: automated.counts, automatedRuns: [0, 1] })[1][0].automatedRun).toBe(true);
  });
  it('clips code points safely and checks enrichment facts before using them', () => {
    const text = ' 🧪 '.repeat(300), preview = previewSummary(text);
    expect([...preview]).toHaveLength(160); expect(preview.endsWith('…')).toBe(true);
    const view = buildFrameOverview(populated()), row = decode(view)[0][0];
    expect(overviewMatchesEvidence([row], [{ ...row, summary: 'Experiment with OCR' }])).toBe(true);
    expect(overviewMatchesEvidence([row], [{ ...row, eventCount: 4 }])).toBe(false);
    expect(overviewMatchesEvidence([row], [])).toBe(false);
  });
  it.each([
    value => { value.buckets[0][0][1] = START - 1; },
    value => { value.buckets[0][0][0] = 99; },
    value => { value.sessions[0][2] = 99; },
    value => { value.buckets[0].push([...value.buckets[0][0]]); },
    value => { value.omitted = [144]; },
    value => { value.buckets.bad = []; },
  ])('drops malformed optional wire data without manufacturing empty evidence', mutate => {
    const view = JSON.parse(JSON.stringify(buildFrameOverview(populated()))); mutate(view);
    expect(decode(view)).toBeNull();
  });
});
