import { createHash } from "node:crypto";

// This is a trusted operator adapter, never a browser/MCP ingestion endpoint.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_BYTES = 1048576;
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const encode = (value) => JSON.stringify(value);
const validTime = (value) => Number.isSafeInteger(value) && value > 0 && value < 8640000000000;

export class CloudActivityError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new CloudActivityError(code); };

export function validateScope(input) {
  if (!input || !UUID.test(input.workspaceId) || !UUID.test(input.personId) ||
      !UUID.test(input.rootThreadId) || typeof input.sourceIdentity !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.sourceIdentity) ||
      !Array.isArray(input.sessions) || !input.sessions.length || input.sessions.length > 200) fail("scope_invalid");
  const sessions = input.sessions.map((session) => {
    if (!UUID.test(session.threadId) || !["agent", "subagent"].includes(session.role) ||
        (session.role === "agent") !== (session.threadId === input.rootThreadId) ||
        (session.projectCwd != null && (typeof session.projectCwd !== "string" || !session.projectCwd.length)) ||
        (session.turnIds != null && (!Array.isArray(session.turnIds) || !session.turnIds.length ||
          session.turnIds.length > 2000 || session.turnIds.some((id) => !UUID.test(id))))) fail("scope_invalid");
    return { threadId: session.threadId, role: session.role,
      ...(session.projectCwd != null ? { projectCwd: session.projectCwd } : {}),
      ...(session.turnIds != null ? { turnIds: [...new Set(session.turnIds)].sort() } : {}) };
  }).sort((a, b) => a.threadId.localeCompare(b.threadId));
  if (!sessions.some((s) => s.threadId === input.rootThreadId) ||
      new Set(sessions.map((s) => s.threadId)).size !== sessions.length) fail("scope_invalid");
  // Ignore untrusted extra scope keys; the checkpoint binds all effective scope.
  return { workspaceId: input.workspaceId, personId: input.personId,
    sourceIdentity: input.sourceIdentity, rootThreadId: input.rootThreadId, sessions };
}

function unwrap(response) {
  if (response?.isError) fail("source_denied_or_unavailable");
  if (response?.content) {
    const blocks = response.content.filter((block) => block.type === "text");
    if (blocks.length !== 1 || typeof blocks[0].text !== "string") fail("source_schema_unsupported");
    try { return JSON.parse(blocks[0].text); } catch { fail("source_schema_unsupported"); }
  }
  return response;
}

// Only these fields cross the persistence boundary. No title, prompt, item,
// output, error message, duration inference or original response hash is kept.
export function projectThreadPage(response, selected, observedAt) {
  const page = unwrap(response);
  if (page?.schemaVersion !== 1 || page.thread?.id !== selected.threadId ||
      !["codex", "chatgpt"].includes(page.thread?.kind) ||
      !Array.isArray(page.turns) || page.turns.length > 100 ||
      page.page?.order !== "newest_first" || typeof page.page?.hasMore !== "boolean" ||
      (page.page.hasMore && (typeof page.page.nextCursor !== "string" ||
        !page.page.nextCursor.length || page.page.nextCursor.length > 16384)) ||
      (!page.page.hasMore && page.page.nextCursor != null)) fail("source_schema_unsupported");
  if (selected.projectCwd != null && selected.projectCwd !== page.thread.cwd) fail("source_project_mismatch");
  if (!validTime(observedAt)) fail("observation_invalid");
  const missing = new Set();
  const turns = [];
  for (const turn of page.turns) {
    if (!UUID.test(turn.id)) fail("source_schema_unsupported");
    if (selected.turnIds && !selected.turnIds.includes(turn.id)) continue;
    const ongoing = turn.status === "inProgress" && turn.completedAt == null;
    if (!validTime(turn.startedAt) || turn.startedAt > observedAt ||
        (!ongoing && (!["completed", "failed", "interrupted"].includes(turn.status) ||
          !validTime(turn.completedAt) || turn.completedAt <= turn.startedAt || turn.completedAt > observedAt))) {
      missing.add("missing_or_invalid_turn_timing"); continue;
    }
    if (ongoing && observedAt <= turn.startedAt) { missing.add("zero_length_observation"); continue; }
    turns.push({ id: turn.id, status: turn.status, startedAt: turn.startedAt,
      completedAt: ongoing ? null : turn.completedAt, ...(ongoing ? { observedAt } : {}) });
  }
  turns.sort((a, b) => a.id.localeCompare(b.id) || encode(a).localeCompare(encode(b)));
  return { threadId: selected.threadId, turns: [...new Map(turns.map((t) => [encode(t), t])).values()],
    hasMore: page.page.hasMore, nextCursor: page.page.nextCursor ?? null,
    missing: [...missing].sort() };
}

export function capabilities(readThread) {
  return { source: "codex-app.read_thread.v1", activity: typeof readThread === "function" ? "available" : "unavailable",
    accessVerified: false,
    content: "unsupported", nativeRollout: false, seshTranscript: false,
    reason: "read_thread exposes bounded summaries; hosted transcript export is not established" };
}

function makeManifest(scope, pages) {
  const sourcePages = pages.map(({ projection }) => {
    // Cursor is needed locally for restart, but need not reach the database.
    const { nextCursor: _cursor, ...metadata } = projection;
    const text = encode(metadata), observed = projection.turns.filter((t) => t.observedAt).map((t) => t.observedAt);
    return { sha256: sha256(text), hashBasis: "redacted_timing_projection_v1",
      ...(observed.length ? { observedAt: Math.max(...observed) } : {}) };
  });
  const sessions = scope.sessions.map((session) => {
    const versions = new Map(), conflicted = new Set();
    pages.forEach(({ projection }, index) => {
      if (projection.threadId !== session.threadId) return;
      projection.turns.forEach((turn) => {
        const candidate = { ...turn, ...(turn.observedAt ? { sourcePageSha256: sourcePages[index].sha256 } : {}) };
        const previous = versions.get(turn.id);
        if (previous && (previous.startedAt !== candidate.startedAt ||
          (previous.completedAt != null && candidate.completedAt != null && encode(previous) !== encode(candidate)))) conflicted.add(turn.id);
        // Completed evidence wins over ongoing. Otherwise latest bounded end
        // wins deterministically; equal-time conflicts are explicitly reported.
        const rank = (t) => [Number(t.completedAt != null), t.completedAt ?? t.observedAt, encode(t)];
        if (!previous || rank(candidate)[0] > rank(previous)[0] ||
            (rank(candidate)[0] === rank(previous)[0] && (rank(candidate)[1] > rank(previous)[1] ||
              (rank(candidate)[1] === rank(previous)[1] && rank(candidate)[2] > rank(previous)[2])))) versions.set(turn.id, candidate);
      });
    });
    const missing = [...new Set(pages.filter((p) => p.projection.threadId === session.threadId).flatMap((p) => p.projection.missing))];
    if (session.turnIds?.some((id) => !versions.has(id))) missing.push("selected_turn_not_observed");
    if (conflicted.size) missing.push("conflicting_turn_versions");
    for (const id of conflicted) versions.delete(id);
    return { threadId: session.threadId, turns: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
      coverage: { activity: missing.length ? "partial" : "selected_pages_observed", content: "unavailable", missing: [...new Set(missing)].sort() } };
  });
  const manifest = { schemaVersion: "thread-api-timing-manifest-v1", rootThreadId: scope.rootThreadId,
    startedWorkerThreadIds: scope.sessions.filter((s) => s.role === "subagent").map((s) => s.threadId),
    provenance: { source: "codex-app.read_thread.v1", sourceIdentity: scope.sourceIdentity,
      scopeSha256: sha256(encode(scope)), adapter: "sherlock.cloud-activity.v1", nativeTranscript: false,
      roleBasis: "operator_selected_topology", originalResponseRetained: false },
    sessions, sourcePages: [...new Map(sourcePages.map((p) => [encode(p), p])).values()].sort((a, b) => a.sha256.localeCompare(b.sha256)) };
  if (Buffer.byteLength(encode(manifest)) > MAX_BYTES) fail("manifest_too_large");
  return manifest;
}

// Source must be the host's already authenticated read_thread tool. There is no
// HTTP fallback, directory discovery, automatic auth or experimental API opt-in.
// Store is single-writer, durable and contains only projected timing + cursors.
export async function collectCloudActivity({ scope: input, readThread, store, sink,
  now = () => Math.floor(Date.now() / 1000), maxPages = 100 }) {
  if (typeof store?.runExclusive !== "function" || typeof sink?.commit !== "function") fail("adapter_not_configured");
  return store.runExclusive(() => collect({ scope: input, readThread, store, sink, now, maxPages }));
}

async function collect({ scope: input, readThread, store, sink, now, maxPages }) {
  const scope = validateScope(input), scopeHash = sha256(encode(scope));
  if (typeof readThread !== "function") fail("source_unavailable");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) fail("page_limit_invalid");
  let state = await store.load();
  if (state && (state.version !== 1 || state.scopeHash !== scopeHash)) fail("checkpoint_scope_mismatch");
  if (!state) state = { version: 1, scopeHash, sessionIndex: 0, cursor: null, pages: [], phase: "collecting" };
  if (state.phase === "committed") return state.receipt;
  let fetched = 0;
  while (state.sessionIndex < scope.sessions.length) {
    if (++fetched > maxPages || state.pages.length >= 1000) fail("page_limit_reached");
    const selected = scope.sessions[state.sessionIndex];
    let response;
    try { response = await readThread({ threadId: selected.threadId, ...(state.cursor ? { cursor: state.cursor } : {}),
      turnLimit: 100, includeOutputs: false, maxOutputCharsPerItem: 1 }); }
    catch { fail("source_denied_or_unavailable"); }
    const projection = projectThreadPage(response, selected, now());
    if (projection.hasMore && (projection.nextCursor === state.cursor || state.pages.some((p) =>
      p.projection.threadId === selected.threadId && p.requestCursor === projection.nextCursor))) fail("source_cursor_cycle");
    state.pages.push({ requestCursor: state.cursor, projection });
    state.cursor = projection.nextCursor;
    if (!projection.hasMore) { state.sessionIndex += 1; state.cursor = null; }
    await store.save(state); // Persist only after projection and validation.
  }
  const manifest = makeManifest(scope, state.pages), manifestText = encode(manifest);
  const receipt = { manifestSha256: sha256(manifestText), scopeSha256: scopeHash,
    coverage: manifest.sessions.map((s) => ({ threadId: s.threadId, ...s.coverage })),
    pageCount: state.pages.length, transcriptImported: false };
  // The sink returns only after COMMIT. A crash before save replays the exact
  // manifest; unique(workspace, person, hash) makes ambiguous commit safe.
  await sink.commit({ scope, manifestText, manifestSha256: receipt.manifestSha256 });
  state.phase = "committed"; state.receipt = receipt;
  await store.save(state);
  return receipt;
}

export function createRecoverySink(sql, authorizedScope) {
  const expected = validateScope(authorizedScope);
  return { async commit({ scope, manifestText, manifestSha256 }) {
    if (encode(scope) !== encode(expected) || sha256(manifestText) !== manifestSha256) fail("sink_scope_or_hash_mismatch");
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { fail("sink_manifest_invalid"); }
    if (Buffer.byteLength(manifestText) > MAX_BYTES || manifest.schemaVersion !== "thread-api-timing-manifest-v1" ||
        manifest.rootThreadId !== expected.rootThreadId || manifest.provenance?.scopeSha256 !== sha256(encode(expected)) ||
        manifest.provenance?.sourceIdentity !== expected.sourceIdentity || manifest.provenance?.nativeTranscript !== false ||
        !Array.isArray(manifest.sessions) || manifest.sessions.length !== expected.sessions.length ||
        encode(manifest.sessions.map((s) => s.threadId)) !== encode(expected.sessions.map((s) => s.threadId))) fail("sink_manifest_invalid");
    await sql.begin(async (tx) => {
      await tx.unsafe("set local role sherlock_ingest");
      await tx.unsafe("set local statement_timeout = '15s'");
      await tx.unsafe(`insert into telemetry.thread_activity_recovery_batches
        (workspace_id, person_id, manifest_text, manifest_sha256) values ($1, $2, $3, $4)
        on conflict do nothing`, [expected.workspaceId, expected.personId, manifestText, manifestSha256]);
    });
  } };
}
