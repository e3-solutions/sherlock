import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlameGraph from './FlameGraph.jsx';
import { adaptFlamePayload } from './flame-data.js';
import { buildFrameOverview } from '../../src/shared/frame-overview.js';

const START = Date.parse('2026-10-11T00:00:00.000Z');
const PERSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSIONS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const bounds = { left: 0, right: 1008, top: 0, bottom: 82, width: 1008, height: 82 };
function model({ snapshot = 'v6.one', prefix = '', omit = false } = {}) {
  const counts = Array.from({ length: 144 }, (_, i) => [i < 2 ? 1 : 0, 0, 0, 0]);
  const rows = counts.map((_, i) => ({ person_id: PERSON, bucket_start: new Date(START + i * 600000).toISOString(), work_rows: i < 2 ? [{
    session_id: SESSIONS[i], semantic_role: 'agent', first_at: new Date(START + i * 600000 + 1).toISOString(),
    last_at: new Date(START + i * 600000 + 9).toISOString(), event_count: 3, is_automated_run: false,
  }] : [] }));
  if (omit) rows[0].work_rows = [];
  const summaries = SESSIONS.map((session_id, i) => ({ session_id, semantic_role: 'agent', summary_event_id: String(i + 1),
    summary: `${prefix}${i === 0 ? 'First' : 'Second'} OCR experiment` }));
  const overview = buildFrameOverview({ personId: PERSON, rows, summaries, counts });
  return adaptFlamePayload({ start: new Date(START).toISOString(), read: new Date(START + 86400000).toISOString(), snapshot,
    latest: new Date(START + 600009).toISOString(), coverage: { evidence: 'observed_events', state: 'partial', reason: null },
    people: [{ id: PERSON, name: 'Ada', activeSeconds: 1200, lastActivity: new Date(START + 600009).toISOString(),
      total: [2, 0, 0], buckets: counts, overview }],
  });
}
function pendingFetch() {
  const pending = [];
  const fetch = vi.fn((url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })));
  vi.stubGlobal('fetch', fetch);
  return { pending, fetch };
}
function clickBucket(container, i) {
  const wrapper = container.querySelector('.flame-person .recharts-wrapper');
  if (!vi.isMockFunction(wrapper.getBoundingClientRect)) vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(bounds);
  fireEvent.click(wrapper, { clientX: i * 7 + 3, clientY: 34 });
}
function response(i = 0, { snapshot = 'v6.one', count = 3, summary = 'First OCR experiment' } = {}) {
  return { ok: true, json: async () => ({ personId: PERSON, start: new Date(START + i * 600000).toISOString(), snapshot,
    work: [{ id: `${SESSIONS[i]}:agent`, sessionId: SESSIONS[i], role: 'agent', firstAt: new Date(START + i * 600000 + 1).toISOString(),
      lastAt: new Date(START + i * 600000 + 9).toISOString(), eventCount: count, summary }], prompts: [] }) };
}
afterEach(() => vi.unstubAllGlobals());

describe('instant snapshot work with deferred enrichment', () => {
  it('renders actual rows on the click turn before any network response and permits opening a session', () => {
    const { pending, fetch } = pendingFetch();
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 0);
    const row = screen.getByRole('button', { name: /First OCR experiment/ });
    expect(row).toHaveTextContent('3 events');
    expect(screen.queryByText('Loading frame evidence…')).not.toBeInTheDocument();
    expect(screen.getByText('Loading prompt excerpts and PR links…')).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toHaveAttribute('aria-busy', 'false');
    expect(pending).toHaveLength(1);
    fireEvent.click(row);
    expect(fetch.mock.calls[1][0]).toContain('/api/flame/work?');
    expect(fetch.mock.calls[1][0]).toContain(`sessionId=${SESSIONS[0]}`);
  });
  it('renders a different and a repeated bar immediately without reusing the previous enrichment', async () => {
    const { pending } = pendingFetch();
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 0); clickBucket(container, 1);
    expect(screen.getByRole('button', { name: /Second OCR experiment/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /First OCR experiment/ })).not.toBeInTheDocument();
    expect(pending[0].options.signal.aborted).toBe(true);
    await act(async () => pending[0].resolve(response()));
    expect(screen.getByRole('button', { name: /Second OCR experiment/ })).toBeInTheDocument();
    clickBucket(container, 0);
    expect(screen.getByRole('button', { name: /First OCR experiment/ })).toBeInTheDocument();
  });
  it('retains rows and reports enrichment failure instead of resetting the whole drawer to loading', async () => {
    const { pending } = pendingFetch();
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 0);
    await act(async () => pending[0].reject(new Error('Unavailable')));
    expect(screen.getByRole('button', { name: /First OCR experiment/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry details' })).toBeInTheDocument();
  });
  it('uses matching enrichment and flags changed facts without silently replacing the snapshot rows', async () => {
    const { pending } = pendingFetch();
    const { container } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 0);
    await act(async () => pending[0].resolve(response()));
    expect(screen.queryByText('Loading prompt excerpts and PR links…')).not.toBeInTheDocument();
    clickBucket(container, 1);
    await act(async () => pending[1].resolve(response(1, { count: 4, summary: 'Second OCR experiment' })));
    expect(screen.queryByRole('button', { name: /Second OCR experiment/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Agent session/ })).toHaveTextContent('3 events');
    expect(screen.getByRole('button', { name: 'Refresh timeline' })).toBeInTheDocument();
  });
  it('switches previews atomically on refresh and ignores late old-snapshot responses', async () => {
    const { pending } = pendingFetch();
    const { container, rerender } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 0);
    rerender(<FlameGraph data={model({ snapshot: 'v6.two', prefix: 'Updated ' })} chartWidth={1008} />);
    expect(screen.getByRole('button', { name: /Updated First OCR experiment/ })).toBeInTheDocument();
    await act(async () => pending[0].resolve(response()));
    expect(screen.getByRole('button', { name: /Updated First OCR experiment/ })).toBeInTheDocument();
    expect(pending[1].url).toContain('snapshot=v6.two');
  });
  it('distinguishes a known empty bucket from omitted evidence that still needs the API', () => {
    pendingFetch();
    const { container, rerender } = render(<FlameGraph data={model()} chartWidth={1008} />);
    clickBucket(container, 2);
    expect(screen.getByText('No work-session evidence observed in this interval.')).toBeInTheDocument();
    rerender(<FlameGraph data={model({ omit: true })} chartWidth={1008} />);
    clickBucket(container, 0);
    expect(screen.getByText('Loading frame evidence…')).toBeInTheDocument();
    expect(screen.queryByText('No work-session evidence observed in this interval.')).not.toBeInTheDocument();
  });
});
