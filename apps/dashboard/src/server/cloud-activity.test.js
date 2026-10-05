import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilities, collectCloudActivity, createRecoverySink, projectThreadPage, validateScope, sha256 } from "./cloud-activity.js";
import { FileCheckpointStore } from "./cloud-activity-store.js";
import { recoveredIntervals, mergeRecoveredTimeline, recoveredIntervalWork } from "./thread-activity-recovery.js";
import { createMcpHttpRoute } from "./mcp-http.js";

export const id = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const start = 1791172800;
export const scope = { workspaceId: id(1), personId: id(2), sourceIdentity: "synthetic-account:test",
  rootThreadId: id(3), sessions: [{ threadId: id(3), role: "agent", projectCwd: "/synthetic/project" }] };
const turn = (n, extra = {}) => ({ id: id(n), startedAt: start, completedAt: start + 300,
  status: "completed", items: [{ text: "PRIVATE_SENTINEL", command: "secret", output: "secret" }], ...extra });
export const page = (turns, cursor = null) => ({ schemaVersion: 1,
  thread: { id: id(3), kind: "codex", cwd: "/synthetic/project", title: "PRIVATE_SENTINEL" },
  turns, page: { order: "newest_first", hasMore: cursor != null, nextCursor: cursor } });
function memory() {
  let state;
  return { runExclusive: (fn) => fn(), load: async () => structuredClone(state),
    save: async (value) => { state = structuredClone(value); } };
}
function database() {
  const rows = new Map();
  return { rows, commit: async ({ scope, manifestText, manifestSha256 }) => {
    rows.set(`${scope.workspaceId}:${scope.personId}:${manifestSha256}`, { person_id: scope.personId,
      manifest_text: manifestText, manifest_sha256: manifestSha256, native_ids: [] });
  } };
}
const collect = (options) => collectCloudActivity({ scope, now: () => start + 1000, ...options });

describe("scoped hosted activity producer", () => {
  it("pages only selected sessions, drops all text, hashes provenance and queries recovered activity", async () => {
    const store = memory(), sink = database(), requests = [];
    const readThread = async (request) => {
      requests.push(request);
      return { content: [{ type: "text", text: JSON.stringify(page(request.cursor ? [turn(5)] : [turn(4)], request.cursor ? null : "opaque")) }] };
    };
    const receipt = await collect({ store, sink, readThread });
    expect(requests.map((r) => r.cursor)).toEqual([undefined, "opaque"]);
    expect(requests.every((r) => r.threadId === id(3) && r.includeOutputs === false)).toBe(true);
    expect(JSON.stringify(await store.load())).not.toContain("PRIVATE_SENTINEL");
    const [row] = [...sink.rows.values()];
    expect(row.manifest_text).not.toContain("PRIVATE_SENTINEL");
    expect(row.manifest_text).not.toContain("opaque");
    expect(row.manifest_sha256).toBe(sha256(row.manifest_text));
    const manifest = JSON.parse(row.manifest_text);
    expect(manifest.provenance).toMatchObject({ nativeTranscript: false, originalResponseRetained: false, sourceIdentity: scope.sourceIdentity });
    expect(manifest.sourcePages[0].hashBasis).toBe("redacted_timing_projection_v1");
    const intervals = recoveredIntervals([row]);
    expect(intervals).toHaveLength(2);
    const output = mergeRecoveredTimeline({ start: new Date(start * 1000).toISOString(), coverage: {},
      people: [{ id: id(2), total: [0, 0, 0], buckets: Array.from({ length: 144 }, () => [0, 0, 0, 0]) }] }, intervals);
    expect(output.people[0].buckets[0]).toEqual([1, 0, 0, 0]);
    expect(output.people[0].total).toEqual([1, 0, 0]);
    expect(recoveredIntervalWork(intervals, id(2), start * 1000)[0].eventCount).toBeNull();
    expect(receipt.transcriptImported).toBe(false);
    // Repeating a completed run does not call the source or write again.
    expect(await collect({ store, sink, readThread: async () => { throw new Error(); } })).toEqual(receipt);
    expect(sink.rows.size).toBe(1);
  });

  it("deduplicates reordered pages and refreshes partial ongoing observations", async () => {
    const sink = database();
    await collect({ store: memory(), sink, readThread: async () => page([turn(5), turn(4), turn(4)]) });
    await collect({ store: memory(), sink, readThread: async () => page([turn(4), turn(5)]) });
    expect(sink.rows.size).toBe(1);
    await collect({ store: memory(), sink, readThread: async () => page([turn(4, { completedAt: null, status: "inProgress" }),
      turn(6, { startedAt: null, durationMs: 300 })]) });
    const intervals = recoveredIntervals([...sink.rows.values()]);
    expect(intervals).toHaveLength(2);
    expect(intervals.find((i) => i.turnId === id(4)).ongoing).toBe(false);
    expect([...sink.rows.values()].some((r) => r.manifest_text.includes("missing_or_invalid_turn_timing"))).toBe(true);
  });

  it("fails closed for unavailable, denied, wrong project and unsupported sources", async () => {
    expect(capabilities(undefined).activity).toBe("unavailable");
    expect(capabilities(() => {}).seshTranscript).toBe(false);
    const sink = database(), store = memory();
    await expect(collect({ store, sink })).rejects.toMatchObject({ code: "source_unavailable" });
    await expect(collect({ store, sink, readThread: async () => ({ isError: true, content: [{ text: "PRIVATE_SENTINEL" }] }) })).rejects.toMatchObject({ code: "source_denied_or_unavailable" });
    await expect(collect({ store, sink, readThread: async () => ({ ...page([]), thread: { ...page([]).thread, cwd: "/other" } }) })).rejects.toMatchObject({ code: "source_project_mismatch" });
    await expect(collect({ store, sink, readThread: async () => ({ ...page([]), schemaVersion: 2 }) })).rejects.toMatchObject({ code: "source_schema_unsupported" });
    expect(sink.rows.size).toBe(0);
    expect(await store.load()).toBeUndefined();
  });

  it("resumes persisted pagination and retries an ambiguous database commit exactly", async () => {
    const store = memory(), sink = database(), calls = [];
    await expect(collect({ store, sink, readThread: async (r) => {
      calls.push(r.cursor);
      if (r.cursor) throw new Error("PRIVATE_SENTINEL");
      return page([turn(4)], "next");
    } })).rejects.toMatchObject({ code: "source_denied_or_unavailable" });
    expect(sink.rows.size).toBe(0);
    const failAfterCommit = { commit: async (batch) => { await sink.commit(batch); throw new Error("lost acknowledgement"); } };
    await expect(collect({ store, sink: failAfterCommit, readThread: async (r) => {
      calls.push(r.cursor); return page([turn(5)]);
    } })).rejects.toThrow("lost acknowledgement");
    expect(calls).toEqual([undefined, "next", "next"]);
    const receipt = await collect({ store, sink, readThread: async () => { throw new Error("must not reread"); } });
    expect(sink.rows.size).toBe(1);
    expect(receipt.pageCount).toBe(2);
    await expect(collect({ store, sink, scope: { ...scope, sourceIdentity: "different-account" }, readThread: () => {} })).rejects.toMatchObject({ code: "checkpoint_scope_mismatch" });
  });

  it("bounds pagination and rejects cycles without skipping a page", async () => {
    const store = memory(), sink = database();
    await expect(collect({ store, sink, maxPages: 1, readThread: async () => page([turn(4)], "next") })).rejects.toMatchObject({ code: "page_limit_reached" });
    await expect(collect({ store, sink, readThread: async () => page([turn(5)], "next") })).rejects.toMatchObject({ code: "source_cursor_cycle" });
    expect((await store.load()).cursor).toBe("next");
    expect(sink.rows.size).toBe(0);
  });

  it("keeps selected-turn coverage explicit without inferring missing timestamps", async () => {
    const sink = database();
    const selectedScope = { ...scope, sessions: [{ ...scope.sessions[0], turnIds: [id(4), id(8)] }] };
    const receipt = await collect({ scope: selectedScope, sink, store: memory(), readThread: async () => page([turn(4), turn(5)]) });
    expect(receipt.coverage[0]).toMatchObject({ activity: "partial", content: "unavailable", missing: ["selected_turn_not_observed"] });
    expect(recoveredIntervals([...sink.rows.values()])).toHaveLength(1);
    expect(() => validateScope({ ...scope, sessions: [] })).toThrow("scope_invalid");
    expect(() => projectThreadPage(page([turn(4, { completedAt: start + 2000 })]), scope.sessions[0], start + 1000)).not.toThrow();
    expect(projectThreadPage(page([turn(4, { completedAt: start + 2000 })]), scope.sessions[0], start + 1000).turns).toEqual([]);
  });

  it("reads explicitly approved children only and refuses conflicting timing attribution", async () => {
    const sink = database(), requests = [];
    const childScope = { ...scope, sessions: [...scope.sessions, { threadId: id(7), role: "subagent" }] };
    const receipt = await collect({ scope: childScope, store: memory(), sink, readThread: async (request) => {
      requests.push(request.threadId);
      if (request.threadId === id(7)) return { ...page([turn(8)]), thread: { id: id(7), kind: "codex" } };
      return page([turn(4), turn(4, { completedAt: start + 600 })]);
    } });
    expect(requests).toEqual([id(3), id(7)]);
    expect(receipt.coverage[0].missing).toEqual(["conflicting_turn_versions"]);
    const intervals = recoveredIntervals([...sink.rows.values()]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ threadId: id(7), role: "subagent" });
    const denied = database();
    await expect(collect({ scope: childScope, store: memory(), sink: denied, readThread: async (request) => {
      if (request.threadId === id(7)) return { isError: true };
      return page([turn(4)]);
    } })).rejects.toMatchObject({ code: "source_denied_or_unavailable" });
    expect(denied.rows.size).toBe(0);
  });

  it("queries imported timing through the existing bearer boundary and denies anonymous reads", async () => {
    const sink = database();
    await collect({ store: memory(), sink, readThread: async () => page([turn(4)]) });
    let delivered;
    const route = createMcpHttpRoute({ token: "a".repeat(32), protocolHandler: async () => { delivered = recoveredIntervals([...sink.rows.values()]); } });
    const response = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    await route({ headers: {} }, response);
    expect(response.status).toBe(401); expect(delivered).toBeUndefined();
    await route({ headers: { authorization: `Bearer ${"a".repeat(32)}` } }, response);
    expect(delivered).toHaveLength(1);
  });

  it("writes private, checksummed restart state atomically and rejects concurrent writers/corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sherlock-cloud-test-"));
    try {
      const path = join(directory, "checkpoint.json"), store = new FileCheckpointStore(path);
      const sink = database();
      await collect({ store, sink, readThread: async () => page([turn(4)]) });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toContain("PRIVATE_SENTINEL");
      await store.runExclusive(async () => {
        await expect(store.runExclusive(async () => {})).rejects.toMatchObject({ code: "checkpoint_locked_or_unwritable" });
      });
      await writeFile(path, '{"state":{},"sha256":"bad"}');
      await expect(store.load()).rejects.toMatchObject({ code: "checkpoint_invalid" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("pins the private sink to its reviewed destination and selected source identity", async () => {
    let connected = false;
    const sql = { begin: async () => { connected = true; } }, sink = createRecoverySink(sql, scope);
    const captured = database();
    await collect({ store: memory(), sink: captured, readThread: async () => page([turn(4)]) });
    const row = [...captured.rows.values()][0], selected = validateScope(scope);
    await expect(sink.commit({ scope: { ...selected, personId: id(9) }, manifestText: row.manifest_text,
      manifestSha256: row.manifest_sha256 })).rejects.toMatchObject({ code: "sink_scope_or_hash_mismatch" });
    const invalid = JSON.parse(row.manifest_text); invalid.sessions[0].threadId = id(9);
    const manifestText = JSON.stringify(invalid);
    await expect(sink.commit({ scope: selected, manifestText, manifestSha256: sha256(manifestText) })).rejects.toMatchObject({ code: "sink_manifest_invalid" });
    expect(connected).toBe(false);
  });
});
