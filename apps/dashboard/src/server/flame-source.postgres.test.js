import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BUCKET_MS,
  CLAUDE_NORMALIZER_VERSION,
  decodeSnapshotToken,
  DirectFlameSource,
  FRAME_VERSION,
  INTERVAL_PULL_REQUESTS_SQL,
  NORMALIZER_VERSION,
  PROJECTION_INTERVAL_WORK_SQL,
} from "./flame-source.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const FIXED_NOW = new Date("2026-08-18T12:10:00.000Z");
const describePostgres = DATABASE_URL ? describe : describe.skip;

function nativeItemId(at) {
  const milliseconds = BigInt(at.getTime()).toString(16).padStart(12, "0");
  return `item_${milliseconds.slice(0, 8)}-${milliseconds.slice(8)}-7000-8000-000000000000`;
}

function bucketIndex(at) {
  const end = Math.floor(FIXED_NOW.getTime() / BUCKET_MS) * BUCKET_MS;
  const start = end - 24 * 60 * 60 * 1000;
  return Math.floor((at.getTime() - start) / BUCKET_MS);
}

function collectPlanRelations(value, relations = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanRelations(item, relations);
  } else if (value && typeof value === "object") {
    if (typeof value["Relation Name"] === "string") {
      relations.add(value["Relation Name"]);
    }
    for (const child of Object.values(value)) collectPlanRelations(child, relations);
  }
  return relations;
}

function collectPlanIndexes(value, indexes = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanIndexes(item, indexes);
  } else if (value && typeof value === "object") {
    if (typeof value["Index Name"] === "string") {
      indexes.add(value["Index Name"]);
    }
    for (const child of Object.values(value)) collectPlanIndexes(child, indexes);
  }
  return indexes;
}

async function cleanup(sql, workspaceId) {
  await sql.unsafe("delete from github.commit_pr_lookups where workspace_id = $1", [workspaceId]);
  await sql.unsafe("delete from telemetry.session_scm where workspace_id = $1", [workspaceId]);
  await sql.unsafe(
    "delete from processing.telemetry_jobs where workspace_id = $1",
    [workspaceId],
  );
  await sql.unsafe("delete from telemetry.events where workspace_id = $1", [
    workspaceId,
  ]);
  await sql.unsafe(
    "delete from telemetry.native_records where workspace_id = $1",
    [workspaceId],
  );
  await sql.unsafe(
    "delete from telemetry.ingest_batches where workspace_id = $1",
    [workspaceId],
  );
  await sql.unsafe("delete from telemetry.sessions where workspace_id = $1", [
    workspaceId,
  ]);
  await sql.unsafe("delete from telemetry.people where workspace_id = $1", [
    workspaceId,
  ]);
  await sql.unsafe("delete from telemetry.workspaces where id = $1", [workspaceId]);
}

describePostgres("Sherlock Flame PostgreSQL integration", () => {
  beforeAll(async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql.unsafe("grant sherlock_reader to postgres");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("lets the shared backend login assume the MCP read-only role", async () => {
    const source = new DirectFlameSource({
      databaseUrl: DATABASE_URL,
      workspaceId: crypto.randomUUID(),
      expectedEmailDomain: "e3group.ai",
    });
    try {
      await expect(source.readiness()).resolves.toEqual({
        status: "ok",
        mode: "sherlock_backend_aggregate",
      });
      await expect(source.fetchDay({ now: FIXED_NOW })).resolves.toMatchObject({
        latest: null,
        people: [],
      });
    } finally {
      await source.close();
    }
  }, 30_000);

  it("shows only the dashboard's expected email domain", async () => {
    const workspaceId = crypto.randomUUID();
    const coreEdgeId = crypto.randomUUID();
    const e3Id = crypto.randomUUID();
    const unmatchedId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let source;

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, $3)`,
        [workspaceId, `roster-${workspaceId}`, "Roster preference fixture"],
      );
      await sql.unsafe(
        `insert into telemetry.people (
           id, workspace_id, identity_key, display_name, email, github_id
         ) values
           ($1, $4, $5, 'Silin', 'silin@coreedgesolution.com', 'silin144'),
           ($2, $4, $6, 'Silin', 'silin@e3group.ai', 'silin144'),
           ($3, $4, $7, 'Unmatched', 'unmatched@coreedgesolution.com', 'unmatched')`,
        [
          coreEdgeId,
          e3Id,
          unmatchedId,
          workspaceId,
          `email:silin-core-${workspaceId}`,
          `email:silin-e3-${workspaceId}`,
          `email:unmatched-${workspaceId}`,
        ],
      );

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const payload = await source.fetchDay({ now: FIXED_NOW });

      expect(payload.people.map(({ id }) => id)).toEqual([e3Id]);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("activates a snapshot-stable projection with parity and blocks direct smoke detail", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const guardianSessionId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    let source;
    const bucketStart = new Date(
      Math.floor(FIXED_NOW.getTime() / BUCKET_MS) * BUCKET_MS - BUCKET_MS,
    );
    const observedAt = new Date(bucketStart.getTime() + 1_000);
    const scmReceivedAt = new Date(observedAt.getTime() + 2_000);
    const promptSourceAt = new Date(bucketStart.getTime() - 10_000);
    const promptNativeItemId = nativeItemId(observedAt);
    const partialRead = new Date(FIXED_NOW.getTime() + 2_000);
    const partialActivityAt = new Date(FIXED_NOW.getTime() + 1_000);
    const newestGuardianAt = new Date(partialActivityAt.getTime() + 500);
    const commitSha = "1".repeat(40);
    const secondCommitSha = "2".repeat(40);
    const linksAt = (receipt) => sql.unsafe(INTERVAL_PULL_REQUESTS_SQL, [
      workspaceId, receipt.snapshot, partialRead.toISOString(), [sessionId],
    ]);
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Frame projection fixture')`,
        [workspaceId, `projection-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (
           id, workspace_id, identity_key, display_name, email
         ) values ($1, $2, $3, 'Projected User', 'projected@e3group.ai')`,
        [personId, workspaceId, `projection-person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values
           ($1, $2, $3, 'projection-collector', 'projection-session',
            'primary', 'projection-role.v1', $6),
           ($4, $2, $3, 'projection-collector', 'projection-guardian',
            'guardian', 'projection-role.v1', $6),
           ($5, $2, $3, 'projection-collector', 'projection-worker',
            'worker', 'projection-role.v1', $6)`,
        [
          sessionId,
          workspaceId,
          personId,
          guardianSessionId,
          workerSessionId,
          bucketStart.toISOString(),
        ],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_provider,
           source_kind, source_stream_key, generation_key, generation_seq,
           start_offset, end_offset, source_byte_count, source_sha256,
           storage_path, storage_encoding, stored_byte_count, stored_sha256,
           record_count, contract_version, first_occurred_at, last_occurred_at,
           committed_at
         ) values (
           $1, $2, $3, 'projection-collector', 'codex', 'rollout',
           'projection-stream', 'projection-generation', 0, 0, 3, 3, $4,
           $5, 'gzip', 1, $6, 3, 'sherlock.rollout-batch.v1', $7, $7, $8
         )`,
        [
          batchId,
          workspaceId,
          personId,
          "a".repeat(64),
          `projection-tests/${batchId}.jsonl.gz`,
          "b".repeat(64),
          observedAt.toISOString(),
          scmReceivedAt.toISOString(),
        ],
      );
      const nativeRows = await sql.unsafe(
        `insert into telemetry.native_records (
           workspace_id, batch_id, record_index, source_start_offset,
           source_end_offset, record_sha256, native_type,
           native_payload_type, occurred_at, parse_status
         ) values
           ($1, $2, 0, 0, 1, $3, 'event_msg', 'user_message', $4, 'ok'),
           ($1, $2, 1, 1, 2, $5, 'session_meta', 'session_meta', $4, 'ok'),
           ($1, $2, 2, 2, 3, $6, 'session_meta', 'session_meta', $4, 'ok')
         returning id::text id, record_index`,
        [
          workspaceId,
          batchId,
          "c".repeat(64),
          observedAt.toISOString(),
          "1".repeat(64),
          "2".repeat(64),
        ],
      );
      const sourceRecordId = (recordIndex) =>
        nativeRows.find((row) => row.record_index === recordIndex).id;
      await sql.unsafe(
        `insert into telemetry.session_scm (
           workspace_id, source_record_id, session_id, source_version,
           repository_full_name, commit_sha, observed_at, server_received_at
         ) values
           ($1, $2, $4, 'sherlock.github-scm.v1',
            'e3-solutions/sherlock', $5, $6, $7),
           ($1, $3, $4, 'sherlock.github-scm.v1',
            'e3-solutions/sherlock', $8, $6, $7)`,
        [
          workspaceId,
          sourceRecordId(1),
          sourceRecordId(2),
          sessionId,
          commitSha,
          observedAt.toISOString(),
          scmReceivedAt.toISOString(),
          secondCommitSha,
        ],
      );
      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, pull_request_terminal_at, created_at
         ) values
           ($1, 'sherlock.github-associated-pulls.v1',
            'e3-solutions/sherlock', $2, 'matched', 54,
            $4::timestamptz - interval '1 second',
            $5::timestamptz - interval '1 minute'),
           ($1, 'sherlock.github-associated-pulls.v1',
            'e3-solutions/sherlock', $3, 'matched', 54, null,
            $5::timestamptz - interval '1 minute')`,
        [
          workspaceId,
          commitSha,
          secondCommitSha,
          observedAt.toISOString(),
          partialRead.toISOString(),
        ],
      );
      const [terminalReceipt] = await sql.unsafe(
        "select pg_current_snapshot()::text snapshot, now() read",
      );
      await expect(linksAt(terminalReceipt)).resolves.toEqual([]);
      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, pull_request_terminal_at, created_at
         ) values ($1, 'sherlock.github-associated-pulls.v1',
                   'e3-solutions/sherlock', $2, 'matched', 54,
                   $3::timestamptz + interval '1 second',
                   $4::timestamptz - interval '1 minute')`,
        [workspaceId, commitSha, observedAt.toISOString(), partialRead.toISOString()],
      );
      const [lateReceipt] = await sql.unsafe(
        "select pg_current_snapshot()::text snapshot, now() read",
      );
      await expect(linksAt(lateReceipt)).resolves.toEqual([]);
      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, pull_request_terminal_at, created_at
         ) values ($1, 'sherlock.github-associated-pulls.v1',
                   'e3-solutions/sherlock', $2, 'matched', 54,
                   $3::timestamptz + interval '3 seconds',
                   $4::timestamptz - interval '6 hours 16 minutes')`,
        [workspaceId, commitSha, observedAt.toISOString(), partialRead.toISOString()],
      );
      const [staleTerminalReceipt] = await sql.unsafe(
        "select pg_current_snapshot()::text snapshot, now() read",
      );
      await expect(linksAt(staleTerminalReceipt)).resolves.toEqual([]);
      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, created_at
         ) values ($1, 'sherlock.github-associated-pulls.v1',
                   'e3-solutions/sherlock', $2, 'matched', 54, $3)`,
        [workspaceId, commitSha, partialRead.toISOString()],
      );
      const eventRows = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at,
           native_item_id, message_role, message_origin, content_sha256,
           content_byte_size, content_excerpt
         ) values (
           $1, $2, $3, $4, 0, 100, 'message', 'user_message', 'primary',
           $5, $5, $5, $6, 'user', 'human', $7, 16, 'Projected prompt'
         ) returning id::text id`,
        [
          workspaceId,
          sessionId,
          sourceRecordId(0),
          NORMALIZER_VERSION,
          promptSourceAt.toISOString(),
          promptNativeItemId,
          "d".repeat(64),
        ],
      );
      const eventId = eventRows[0].id;
      const partialEventRows = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) values ($1, $2, $3, $4, 1, 100, 'reasoning', 'reasoning',
                   'primary', $5, $5, $5)
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          sourceRecordId(0),
          NORMALIZER_VERSION,
          partialActivityAt.toISOString(),
        ],
      );
      const partialEventId = partialEventRows[0].id;
      const roleEventRows = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, canonical_scope_key, logical_event_key,
           source_priority, event_kind, event_subtype, actor_role, occurred_at,
           observed_at, server_received_at
         ) values
           ($1, $2, $4, $5, 2, 'projection-guardian', 'same-activity', 100,
            'reasoning', 'reasoning', 'guardian', $6, $6, $6),
           ($1, $2, $4, $5, 3, 'projection-guardian', 'same-activity', 10,
            'reasoning', 'reasoning', 'worker', $7, $7, $7),
           ($1, $3, $4, $5, 4, null, null, 100,
            'reasoning', 'reasoning', 'worker', $8, $8, $8),
           ($1, $2, $4, $5, 5, null, null, 100,
            'reasoning', 'reasoning', 'guardian', $9, $9, $9)
         returning id::text id`,
        [
          workspaceId,
          guardianSessionId,
          workerSessionId,
          sourceRecordId(0),
          NORMALIZER_VERSION,
          new Date(bucketStart.getTime() + 2_000).toISOString(),
          new Date(bucketStart.getTime() + 2_500).toISOString(),
          new Date(bucketStart.getTime() + 3_000).toISOString(),
          newestGuardianAt.toISOString(),
        ],
      );
      const [
        guardianEvent,
        guardianLoserEvent,
        workerEvent,
        newestGuardianEvent,
      ] = roleEventRows;
      const receiptRows = await sql.unsafe(
         `insert into analytics.frame_projection_receipts (
           workspace_id, session_id, person_id, frame_version,
           covered_from, covered_through, through_event_id,
           source_event_count, source_state_sha256, request_generation,
           session_updated_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 2, $8, 1,
           (select updated_at from telemetry.sessions
             where workspace_id = $1 and id = $2)
         )
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          personId,
          FRAME_VERSION,
          bucketStart.toISOString(),
          partialRead.toISOString(),
          partialEventId,
          "e".repeat(64),
        ],
      );
      const guardianReceiptRows = await sql.unsafe(
        `insert into analytics.frame_projection_receipts (
           workspace_id, session_id, person_id, frame_version,
           covered_from, covered_through, through_event_id,
           source_event_count, source_state_sha256, request_generation,
           session_updated_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 3, $8, 1,
           (select updated_at from telemetry.sessions
             where workspace_id = $1 and id = $2)
         ) returning id::text id`,
        [
          workspaceId,
          guardianSessionId,
          personId,
          FRAME_VERSION,
          bucketStart.toISOString(),
          partialRead.toISOString(),
          newestGuardianEvent.id,
          "1".repeat(64),
        ],
      );
      const workerReceiptRows = await sql.unsafe(
        `insert into analytics.frame_projection_receipts (
           workspace_id, session_id, person_id, frame_version,
           covered_from, covered_through, through_event_id,
           source_event_count, source_state_sha256, request_generation,
           session_updated_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 1, $8, 1,
           (select updated_at from telemetry.sessions
             where workspace_id = $1 and id = $2)
         ) returning id::text id`,
        [
          workspaceId,
          workerSessionId,
          personId,
          FRAME_VERSION,
          bucketStart.toISOString(),
          partialRead.toISOString(),
          workerEvent.id,
          "2".repeat(64),
        ],
      );
      await sql.unsafe(
        `insert into analytics.frame_evidence_revisions (
           receipt_id, workspace_id, session_id, person_id, frame_version,
           evidence_kind, source_event_id, anchor_observed_at, observed_at,
           actor_role, event_kind, event_subtype, message_role, message_origin,
           prompt_identity, is_summary_candidate, is_tombstone
         ) values
           ($1, $2, $3, $4, $5, 'activity', $6, $7, $7, 'primary',
            'message', 'user_message', 'user', 'human', null, true, false),
           ($1, $2, $3, $4, $5, 'prompt', $6, $11, $7, 'primary',
            'message', 'user_message', 'user', 'human', $8, false, false),
           ($1, $2, $3, $4, $5, 'activity', $9, $10, $10, 'primary',
            'reasoning', 'reasoning', null, null, null, false, false)`,
        [
          receiptRows[0].id,
          workspaceId,
          sessionId,
          personId,
          FRAME_VERSION,
          eventId,
          observedAt.toISOString(),
          `native:${promptNativeItemId}`,
          partialEventId,
          partialActivityAt.toISOString(),
          promptSourceAt.toISOString(),
        ],
      );
      await sql.unsafe(
        `insert into analytics.frame_evidence_revisions (
           receipt_id, workspace_id, session_id, person_id, frame_version,
           evidence_kind, source_event_id, anchor_observed_at, observed_at,
           actor_role, event_kind, event_subtype, message_role, message_origin,
           prompt_identity, is_summary_candidate, is_tombstone
         ) values
           ($1, $2, $3, $4, $5, 'activity', $6, $9, $9, 'worker',
            'reasoning', 'reasoning', null, null, null, false, false),
           ($1, $2, $3, $4, $5, 'activity', $6, $9, $9, 'guardian',
            'reasoning', 'reasoning', null, null, null, false, false),
           ($1, $2, $3, $4, $5, 'activity', $7, $10, $10, 'worker',
            'reasoning', 'reasoning', null, null, null, false, true),
           ($13, $2, $8, $4, $5, 'activity', $11, $12, $12, 'worker',
            'reasoning', 'reasoning', null, null, null, false, false),
           ($1, $2, $3, $4, $5, 'activity', $14, $15, $15, 'guardian',
            'reasoning', 'reasoning', null, null, null, false, false)`,
        [
          guardianReceiptRows[0].id,
          workspaceId,
          guardianSessionId,
          personId,
          FRAME_VERSION,
          guardianEvent.id,
          guardianLoserEvent.id,
          workerSessionId,
          new Date(bucketStart.getTime() + 2_000).toISOString(),
          new Date(bucketStart.getTime() + 2_500).toISOString(),
          workerEvent.id,
          new Date(bucketStart.getTime() + 3_000).toISOString(),
          workerReceiptRows[0].id,
          newestGuardianEvent.id,
          newestGuardianAt.toISOString(),
        ],
      );

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const legacyDay = await source.fetchDay({ now: partialRead });
      const legacyInterval = await source.fetchInterval({
        personId,
        start: bucketStart.toISOString(),
        snapshot: legacyDay.snapshot,
        now: partialRead,
      });
      expect(legacyDay.snapshot).toMatch(/^v1\./);
      expect(legacyDay.latest).toBe(partialActivityAt.toISOString());
      expect(legacyDay.people[0].lastActivity).toBe(
        partialActivityAt.toISOString(),
      );

      await sql.unsafe(
        `insert into analytics.frame_projection_activations (
           workspace_id, frame_version
         ) values ($1, $2)`,
        [workspaceId, FRAME_VERSION],
      );
      const projectedDay = await source.fetchDay({ now: partialRead });
      const projectedInterval = await source.fetchInterval({
        personId,
        start: bucketStart.toISOString(),
        snapshot: projectedDay.snapshot,
        now: partialRead,
      });

      expect(projectedDay.snapshot).toMatch(/^v2\./);
      expect(projectedDay.people).toEqual(legacyDay.people);
      expect(projectedDay.latest).toBe(partialActivityAt.toISOString());
      expect(projectedDay.people[0].lastActivity).toBe(
        partialActivityAt.toISOString(),
      );
      expect(projectedDay.people[0].total).toEqual([1, 1, 0]);
      expect(projectedInterval.work).toEqual(legacyInterval.work);
      expect(projectedInterval.prompts).toEqual(legacyInterval.prompts);
      expect(projectedInterval.work[0].pullRequest).toEqual({
        number: 54,
        url: "https://github.com/e3-solutions/sherlock/pull/54",
      });
      expect(Object.fromEntries(projectedInterval.work.map(({ sessionId, role }) =>
        [sessionId, role]
      ))).toEqual({
        [sessionId]: "agent",
        [workerSessionId]: "subagent",
      });
      await expect(source.fetchWork({
        personId,
        start: bucketStart.toISOString(),
        sessionId: guardianSessionId,
        role: "subagent",
        snapshot: projectedDay.snapshot,
        limit: "10",
        now: partialRead,
      })).rejects.toMatchObject({ code: "flame_work_request_not_found" });
      const legacyWorker = await source.fetchWork({
        personId,
        start: bucketStart.toISOString(),
        sessionId: workerSessionId,
        role: "subagent",
        snapshot: legacyDay.snapshot,
        limit: "10",
        now: partialRead,
      });
      const projectedWorker = await source.fetchWork({
        personId,
        start: bucketStart.toISOString(),
        sessionId: workerSessionId,
        role: "subagent",
        snapshot: projectedDay.snapshot,
        limit: "10",
        now: partialRead,
      });
      expect(projectedWorker).toEqual({
        ...legacyWorker,
        snapshot: projectedDay.snapshot,
      });

      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, created_at
         ) values ($1, 'sherlock.github-associated-pulls.v1',
                   'e3-solutions/sherlock', $2, 'matched', 55, $3)`,
        [workspaceId, secondCommitSha, partialRead.toISOString()],
      );
      const [conflictingReceipt] = await sql.unsafe(
        "select pg_current_snapshot()::text snapshot, now() read",
      );
      await expect(linksAt(conflictingReceipt)).resolves.toEqual([]);
      await sql.unsafe(
        `insert into github.commit_pr_lookups (
           workspace_id, source_version, repository_full_name, commit_sha,
           outcome, pull_request_number, created_at
         ) values
           ($1, 'sherlock.github-associated-pulls.v1', 'e3-solutions/sherlock',
            $2, 'matched', 54, $3),
           ($1, 'sherlock.github-associated-pulls.v1', 'e3-solutions/sherlock',
            $2, 'ambiguous', null, $3)`,
        [workspaceId, commitSha, partialRead.toISOString()],
      );
      const [ambiguousReceipt] = await sql.unsafe(
        "select pg_current_snapshot()::text snapshot, now() read",
      );
      await expect(linksAt(ambiguousReceipt)).resolves.toEqual([]);

      await sql.unsafe(
        "update telemetry.people set github_id = 'sherlock-smoke' where workspace_id = $1 and id = $2",
        [workspaceId, personId],
      );
      for (const snapshot of [legacyDay.snapshot, projectedDay.snapshot]) {
        await expect(source.fetchWork({
          personId,
          start: bucketStart.toISOString(),
          sessionId,
          role: "agent",
          snapshot,
          now: partialRead,
        })).rejects.toMatchObject({ code: "flame_work_request_not_found" });
      }
      await sql.unsafe(
        "update telemetry.people set github_id = null where workspace_id = $1 and id = $2",
        [workspaceId, personId],
      );
      const projectedSnapshot = decodeSnapshotToken(projectedDay.snapshot);
      const planRows = await sql.begin(async (tx) => {
        await tx.unsafe("set local role sherlock_reader");
        await tx.unsafe("set local enable_seqscan = off");
        return await tx.unsafe(
          `explain (format json, costs off) ${PROJECTION_INTERVAL_WORK_SQL}`,
          [
            workspaceId,
            FRAME_VERSION,
            projectedSnapshot.snapshot,
            personId,
            bucketStart.toISOString(),
            new Date(bucketStart.getTime() + BUCKET_MS).toISOString(),
            "e3group.ai",
            201,
          ],
        );
      });
      const rawPlan = Object.values(planRows[0])[0];
      const plan = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
      const relations = collectPlanRelations(plan);
      const indexes = collectPlanIndexes(plan);
      expect(relations.has("frame_evidence_revisions")).toBe(true);
      expect(relations.has("frame_projection_receipts")).toBe(false);
      expect(relations.has("events")).toBe(true);
      expect(relations.has("sessions")).toBe(false);
      expect(relations.has("native_records")).toBe(false);
      expect(relations.has("ingest_batches")).toBe(false);
      expect([...indexes].some((name) =>
        name.startsWith("frame_evidence_revisions_")
      )).toBe(true);
      expect([...indexes].some((name) => name.startsWith("events_"))).toBe(true);

      const secondEventRows = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) values ($1, $2, $3, $4, 6, 100, 'reasoning', 'reasoning',
                   'primary', $5, $5, $5)
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          sourceRecordId(0),
          NORMALIZER_VERSION,
          new Date(observedAt.getTime() + 500).toISOString(),
        ],
      );
      const secondReceiptRows = await sql.unsafe(
         `insert into analytics.frame_projection_receipts (
           workspace_id, session_id, person_id, frame_version,
           covered_from, covered_through, through_event_id,
           source_event_count, source_state_sha256, request_generation,
           session_updated_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, 3, $8, 2,
           (select updated_at from telemetry.sessions
             where workspace_id = $1 and id = $2)
         )
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          personId,
          FRAME_VERSION,
          bucketStart.toISOString(),
          partialRead.toISOString(),
          secondEventRows[0].id,
          "f".repeat(64),
        ],
      );
      await sql.unsafe(
        `insert into analytics.frame_evidence_revisions (
           receipt_id, workspace_id, session_id, person_id, frame_version,
           evidence_kind, source_event_id, anchor_observed_at, observed_at,
           actor_role, event_kind, event_subtype, message_role, message_origin,
           prompt_identity, is_summary_candidate, is_tombstone
         ) values ($1, $2, $3, $4, $5, 'prompt', $6, $7, $9, 'primary',
                   'message', 'user_message', 'user', 'human', $8, false, true)`,
        [
          secondReceiptRows[0].id,
          workspaceId,
          sessionId,
          personId,
          FRAME_VERSION,
          eventId,
          promptSourceAt.toISOString(),
          `native:${promptNativeItemId}`,
          observedAt.toISOString(),
        ],
      );

      const oldSnapshotInterval = await source.fetchInterval({
        personId,
        start: bucketStart.toISOString(),
        snapshot: projectedDay.snapshot,
        now: partialRead,
      });
      const newDay = await source.fetchDay({ now: partialRead });
      const newInterval = await source.fetchInterval({
        personId,
        start: bucketStart.toISOString(),
        snapshot: newDay.snapshot,
        now: partialRead,
      });
      expect(oldSnapshotInterval.prompts).toHaveLength(1);
      expect(newInterval.prompts).toEqual([]);
      expect(oldSnapshotInterval.work[0].pullRequest?.number).toBe(54);
      expect(newInterval.work[0]).not.toHaveProperty("pullRequest");
    } finally {
      if (source) await source.close();
      await sql.unsafe(
        "delete from analytics.frame_projection_activations where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from analytics.frame_evidence_revisions where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      await sql.unsafe(
        "delete from analytics.frame_projection_receipts where workspace_id = $1",
        [workspaceId],
      ).catch(() => undefined);
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("shows Claude primary and subagent transcript evidence throughout the Flame API", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const primarySessionId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const primaryBatchId = crypto.randomUUID();
    const workerBatchId = crypto.randomUUID();
    const collectorKey = `claude-${workspaceId}`;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let source;
    const now = new Date();
    const bucketStartDate = new Date(
      Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS - BUCKET_MS,
    );
    const at = (milliseconds) =>
      new Date(bucketStartDate.getTime() + milliseconds).toISOString();

    const eventFixtures = [{
      batchId: primaryBatchId,
      sessionId: primarySessionId,
      recordIndex: 0,
      at: at(500),
      nativeType: "user",
      subtype: "user_message",
      actorRole: "primary",
      messageRole: "user",
      messageOrigin: "system",
      excerpt: "Injected system context",
    }, {
      batchId: primaryBatchId,
      sessionId: primarySessionId,
      recordIndex: 1,
      at: at(1_000),
      nativeType: "user",
      subtype: "user_message",
      actorRole: "primary",
      messageRole: "user",
      messageOrigin: "human",
      excerpt: "Review the ingestion path",
    }, {
      batchId: primaryBatchId,
      sessionId: primarySessionId,
      recordIndex: 2,
      at: at(2_000),
      nativeType: "assistant",
      subtype: "message",
      actorRole: "primary",
      messageRole: "assistant",
      messageOrigin: "worker",
      excerpt: "I will inspect it.",
    }, {
      batchId: primaryBatchId,
      sessionId: primarySessionId,
      recordIndex: 3,
      at: at(3_000),
      nativeType: "assistant",
      subtype: "tool_use",
      actorRole: "primary",
      eventKind: "tool_call",
      toolCallId: "claude-tool-1",
    }, {
      batchId: workerBatchId,
      sessionId: workerSessionId,
      recordIndex: 0,
      at: at(4_000),
      nativeType: "user",
      subtype: "user_message",
      actorRole: "worker",
      messageRole: "user",
      messageOrigin: "parent_agent",
      excerpt: "Check the dashboard query",
    }, {
      batchId: workerBatchId,
      sessionId: workerSessionId,
      recordIndex: 1,
      at: at(5_000),
      nativeType: "assistant",
      subtype: "message",
      actorRole: "worker",
      messageRole: "assistant",
      messageOrigin: "worker",
      excerpt: "The query needs both providers.",
    }];

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Claude dashboard fixture')`,
        [workspaceId, `claude-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (
           id, workspace_id, identity_key, display_name, email
         ) values ($1, $2, $3, 'Claude User', 'claude@e3group.ai')`,
        [personId, workspaceId, `claude-person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           parent_session_id, parent_native_session_id, actor_role,
           role_version, started_at
         ) values
           ($1, $3, $4, $5, 'claude-primary', null, null, 'primary',
            'sherlock.claude-code-role.v1', $6),
           ($2, $3, $4, $5, 'claude-worker', $1, 'claude-primary', 'worker',
            'sherlock.claude-code-role.v1', $6)`,
        [
          primarySessionId,
          workerSessionId,
          workspaceId,
          personId,
          collectorKey,
          bucketStartDate.toISOString(),
        ],
      );
      for (const [batchId, stream, nativeSessionId, parentId, recordCount] of [[
        primaryBatchId,
        "primary-stream",
        "claude-primary",
        null,
        4,
      ], [
        workerBatchId,
        "worker-stream",
        "claude-worker",
        "claude-primary",
        2,
      ]]) {
        await sql.unsafe(
          `insert into telemetry.ingest_batches (
             id, workspace_id, person_id, collector_key,
             observed_native_session_id, observed_parent_native_session_id,
             source_provider, source_kind, source_stream_key, generation_key,
             generation_seq, start_offset, end_offset, source_byte_count,
             source_sha256, storage_path, storage_encoding, stored_byte_count,
             stored_sha256, record_count, contract_version
           ) values (
             $1, $2, $3, $4, $5, $6, 'claude_code', 'transcript', $7,
             'fixture-generation', 0, 0, $8, $8, repeat('a', 64), $9,
             'identity', $8, repeat('b', 64), $10, 'sherlock.rollout-batch.v1'
           )`,
          [
            batchId,
            workspaceId,
            personId,
            collectorKey,
            nativeSessionId,
            parentId,
            stream,
            recordCount * 100,
            `fixture/${batchId}`,
            recordCount,
          ],
        );
      }
      for (const fixture of eventFixtures) {
        const [record] = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, native_type, parse_status
           ) values (
             $1, $2, $3, $4, $5, repeat('c', 64),
             $6,
             'ok'
           ) returning id`,
          [
            workspaceId,
            fixture.batchId,
            fixture.recordIndex,
            fixture.recordIndex * 100,
            fixture.recordIndex * 100 + 100,
            fixture.nativeType,
          ],
        );
        const content = fixture.excerpt ?? null;
        await sql.unsafe(
          `insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, canonical_scope_key, logical_event_key,
             source_priority, event_kind, event_subtype, actor_role,
             occurred_at, observed_at, server_received_at, native_item_id,
             tool_call_id, message_role, message_origin, content_sha256,
             content_byte_size, content_excerpt
           ) values (
             $1, $2, $3, $4, 0, $5, $6, 100, $7, $8, $9,
             $10, $10, $10, $11, $12, $13, $14,
             case when $15::text is null then null else repeat('d', 64) end,
             case when $15::text is null then null else octet_length($15::text) end,
             $15
           )`,
          [
            workspaceId,
            fixture.sessionId,
            record.id,
            CLAUDE_NORMALIZER_VERSION,
            `session:${fixture.sessionId}`,
            `claude:${fixture.subtype}:${fixture.sessionId}:${fixture.recordIndex}`,
            fixture.eventKind ?? "message",
            fixture.subtype,
            fixture.actorRole,
            fixture.at,
            crypto.randomUUID(),
            fixture.toolCallId ?? null,
            fixture.messageRole ?? null,
            fixture.messageOrigin ?? null,
            content,
          ],
        );
      }

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const payload = await source.fetchDay({ now });
      const person = payload.people[0];
      const bucketStart = bucketStartDate.toISOString();
      const payloadStart = new Date(payload.start).getTime();
      const bucket = person.buckets[
        Math.floor((bucketStartDate.getTime() - payloadStart) / BUCKET_MS)
      ];

      expect(person.total).toEqual([1, 1, 0]);
      expect(bucket).toEqual([1, 1, 0, 1]);

      const interval = await source.fetchInterval({
        personId,
        start: bucketStart,
        snapshot: payload.snapshot,
      });
      expect(interval.work).toEqual([
        expect.objectContaining({
          sessionId: primarySessionId,
          role: "agent",
          eventCount: 4,
          summary: "Review the ingestion path",
        }),
        expect.objectContaining({
          sessionId: workerSessionId,
          role: "subagent",
          eventCount: 2,
          summary: "Check the dashboard query",
        }),
      ]);

      const detail = await source.fetchWork({
        personId,
        start: bucketStart,
        sessionId: primarySessionId,
        role: "agent",
        snapshot: payload.snapshot,
        limit: "10",
      });
      expect(detail.eventCount).toBe(4);
      expect(detail.items.map(({ role, content }) => [role, content])).toEqual([
        ["user", "Review the ingestion path"],
        ["assistant", "I will inspect it."],
      ]);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("excludes copied pre-start history and guardian winners after canonical selection", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const primarySessionId = crypto.randomUUID();
    const copiedOnlySessionId = crypto.randomUUID();
    const recentCopiedSessionId = crypto.randomUUID();
    const mixedChildSessionId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const boundarySessionId = crypto.randomUUID();
    const canonicalSessionId = crypto.randomUUID();
    const unknownRootSessionId = crypto.randomUUID();
    const automationSessionId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let source;

    const events = [
      {
        sessionId: primarySessionId,
        actorRole: "primary",
        envelopeAt: "2026-08-18T10:10:00.000Z",
        nativeAt: "2026-08-18T10:10:00.000Z",
      },
      {
        sessionId: copiedOnlySessionId,
        actorRole: "worker",
        envelopeAt: "2026-08-18T11:01:00.000Z",
        nativeAt: "2026-08-18T10:20:00.000Z",
      },
      {
        sessionId: recentCopiedSessionId,
        actorRole: "worker",
        envelopeAt: "2026-08-18T12:02:00.000Z",
        nativeAt: "2026-08-18T12:00:00.000Z",
      },
      {
        sessionId: mixedChildSessionId,
        actorRole: "unknown",
        envelopeAt: "2026-08-18T11:02:00.000Z",
        nativeAt: "2026-08-18T10:30:00.000Z",
      },
      {
        sessionId: mixedChildSessionId,
        actorRole: "unknown",
        envelopeAt: "2026-08-18T11:10:00.000Z",
      },
      {
        sessionId: workerSessionId,
        actorRole: "worker",
        envelopeAt: "2026-08-18T11:05:00.000Z",
      },
      {
        sessionId: boundarySessionId,
        actorRole: "guardian",
        envelopeAt: "2026-08-18T10:40:00.001Z",
        nativeAt: "2026-08-18T10:40:00.000Z",
        canonicalScopeKey: "guardian-session",
        logicalEventKey: "guardian-wins",
        sourcePriority: 100,
      },
      {
        sessionId: boundarySessionId,
        actorRole: "worker",
        envelopeAt: "2026-08-18T10:40:01.000Z",
        canonicalScopeKey: "guardian-session",
        logicalEventKey: "guardian-wins",
        sourcePriority: 10,
      },
      {
        sessionId: canonicalSessionId,
        actorRole: "primary",
        envelopeAt: "2026-08-18T11:03:00.000Z",
        nativeAt: "2026-08-18T10:50:00.000Z",
        canonicalScopeKey: "canonical-session",
        logicalEventKey: "same-semantic-event",
        sourcePriority: 100,
      },
      {
        sessionId: canonicalSessionId,
        actorRole: "primary",
        envelopeAt: "2026-08-18T11:20:00.000Z",
        canonicalScopeKey: "canonical-session",
        logicalEventKey: "same-semantic-event",
        sourcePriority: 10,
      },
      {
        sessionId: unknownRootSessionId,
        actorRole: "unknown",
        envelopeAt: "2026-08-18T11:30:00.000Z",
      },
      {
        sessionId: automationSessionId,
        actorRole: "automation",
        envelopeAt: "2026-08-18T11:40:00.000Z",
      },
    ];

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, $3)`,
        [workspaceId, `flame-${workspaceId}`, "Flame boundary fixture"],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key, display_name, email)
         values ($1, $2, $3, $4, 'boundary@e3group.ai')`,
        [personId, workspaceId, `person-${personId}`, "Boundary Person"],
      );

      const sessions = [
        [primarySessionId, "primary", "2026-08-18T10:00:00.000Z", null],
        [copiedOnlySessionId, "worker", "2026-08-18T11:00:00.000Z", primarySessionId],
        [recentCopiedSessionId, "worker", "2026-08-18T12:01:00.000Z", primarySessionId],
        [mixedChildSessionId, "unknown", "2026-08-18T11:00:00.000Z", primarySessionId],
        [workerSessionId, "worker", "2026-08-18T11:00:00.000Z", primarySessionId],
        [boundarySessionId, "guardian", "2026-08-18T10:40:00.000500Z", primarySessionId],
        [canonicalSessionId, "primary", "2026-08-18T11:00:00.000Z", null],
        [unknownRootSessionId, "unknown", "2026-08-18T11:00:00.000Z", null],
        [automationSessionId, "automation", "2026-08-18T11:00:00.000Z", null],
      ];
      for (const [sessionId, actorRole, startedAt, parentSessionId] of sessions) {
        await sql.unsafe(
          `insert into telemetry.sessions (
             id, workspace_id, person_id, collector_key, native_session_id,
             parent_session_id, actor_role, role_version, started_at
           ) values ($1, $2, $3, 'fixture', $4, $5, $6, 'fixture.v1', $7)`,
          [sessionId, workspaceId, personId, sessionId, parentSessionId, actorRole, startedAt],
        );
      }

      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values (
           $1, $2, $3, 'fixture', 'rollout', $4, 'fixture-generation', 0, 0,
           900, 900, repeat('a', 64), $5, 'identity', 900, repeat('b', 64), $6,
           'fixture.v1'
         )`,
        [
          batchId,
          workspaceId,
          personId,
          `stream-${batchId}`,
          `fixture/${batchId}`,
          events.length,
        ],
      );

      for (const [index, event] of events.entries()) {
        const [record] = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, parse_status
           ) values ($1, $2, $3, $4, $5, repeat('c', 64), 'ok')
           returning id`,
          [workspaceId, batchId, index, index * 10, index * 10 + 10],
        );
        await sql.unsafe(
          `insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, canonical_scope_key, logical_event_key,
             source_priority, event_kind, actor_role, occurred_at, observed_at,
             server_received_at, native_item_id
           ) values (
             $1, $2, $3, $4, 0, $5, $6, $7, 'tool_call', $8, $9, $9, $9, $10
           )`,
          [
            workspaceId,
            event.sessionId,
            record.id,
            NORMALIZER_VERSION,
            event.canonicalScopeKey ?? null,
            event.logicalEventKey ?? null,
            event.sourcePriority ?? 50,
            event.actorRole,
            event.envelopeAt,
            event.nativeAt ? nativeItemId(new Date(event.nativeAt)) : null,
          ],
        );
      }

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const payload = await source.fetchDay({ now: FIXED_NOW });
      const person = payload.people[0];

      expect(payload.people).toHaveLength(1);
      expect(payload.latest).toBe("2026-08-18T11:30:00.000Z");
      expect(person.total).toEqual([1, 2, 1]);
      expect(person.lastActivity).toBe("2026-08-18T11:30:00.000Z");
      expect(person.activeSeconds).toBe(2_400);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:10:00.000Z"))])
        .toEqual([1, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:20:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:30:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:40:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:50:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T11:00:00.000Z"))])
        .toEqual([0, 1, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T11:10:00.000Z"))])
        .toEqual([0, 1, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T11:20:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T11:30:00.000Z"))])
        .toEqual([0, 0, 1, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T11:40:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T12:00:00.000Z"))])
        .toEqual([0, 0, 0, 0]);

      const guardianInterval = await source.fetchInterval({
        personId,
        start: "2026-08-18T10:40:00.000Z",
        snapshot: payload.snapshot,
        now: FIXED_NOW,
      });
      expect(guardianInterval.work).toEqual([]);
      await expect(source.fetchWork({
        personId,
        start: "2026-08-18T10:40:00.000Z",
        sessionId: boundarySessionId,
        role: "subagent",
        snapshot: payload.snapshot,
        limit: "10",
        now: FIXED_NOW,
      })).rejects.toMatchObject({ code: "flame_work_request_not_found" });

      const canonicalLoserInterval = await source.fetchInterval({
        personId,
        start: "2026-08-18T11:20:00.000Z",
        snapshot: payload.snapshot,
        now: FIXED_NOW,
      });
      expect(canonicalLoserInterval.work).toEqual([]);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("preserves ambiguous representation partners across a frame boundary", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const frameStart = new Date("2026-08-18T11:20:00.000Z");
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const content = "Boundary assistant response";
    const contentHash = "d".repeat(64);
    const representations = [{
      kind: "agent_message",
      subtype: "agent_message",
      nativeType: "event_msg",
      payloadType: "agent_message",
      at: new Date(frameStart.getTime() + 50),
      nativeItemId: null,
    }, {
      kind: "message",
      subtype: "message",
      nativeType: "response_item",
      payloadType: "message",
      at: new Date(frameStart.getTime() - 2_900),
      nativeItemId: nativeItemId(new Date(frameStart.getTime() - 2_900)),
    }, {
      kind: "agent_message",
      subtype: "agent_message",
      nativeType: "event_msg",
      payloadType: "agent_message",
      at: new Date(frameStart.getTime() - 5_850),
      nativeItemId: null,
    }];
    let source;

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)`,
        [workspaceId, `boundary-${workspaceId}`, "Representation boundary fixture"],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key, display_name, email)
         values ($1, $2, $3, 'Boundary Person', 'boundary@e3group.ai')`,
        [personId, workspaceId, `person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $4, 'primary', 'fixture.v1', $5)`,
        [
          sessionId, workspaceId, personId, sessionId,
          new Date(frameStart.getTime() - 10_000).toISOString(),
        ],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values (
           $1, $2, $3, 'fixture', 'rollout', $4, 'fixture-generation', 0, 0,
           300, 300, repeat('a', 64), $5, 'identity', 300, repeat('b', 64), 3,
           'fixture.v1'
         )`,
        [batchId, workspaceId, personId, `stream-${batchId}`, `fixture/${batchId}`],
      );

      for (const [index, representation] of representations.entries()) {
        const [record] = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, parse_status,
             native_type, native_payload_type
           ) values ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)
           returning id`,
          [
            workspaceId, batchId, index, index * 100, index * 100 + 100,
            String(index + 5).repeat(64), representation.nativeType,
            representation.payloadType,
          ],
        );
        await sql.unsafe(
          `insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, source_priority, event_kind, event_subtype,
             actor_role, occurred_at, observed_at, server_received_at,
             native_item_id, message_role, content_sha256, content_byte_size,
             content_excerpt
           ) values (
             $1, $2, $3, $4, 0, 100, $5, $6, 'primary', $7, $7, $7,
             $8, 'assistant', $9, $10, $11
           )`,
          [
            workspaceId, sessionId, record.id, NORMALIZER_VERSION,
            representation.kind, representation.subtype, representation.at.toISOString(),
            representation.nativeItemId, contentHash,
            Buffer.byteLength(content, "utf8"), content,
          ],
        );
      }

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const day = await source.fetchDay({ now: FIXED_NOW });
      expect(day.people[0].buckets[bucketIndex(frameStart)].slice(0, 3)).toEqual([1, 0, 0]);

      const interval = await source.fetchInterval({
        personId,
        start: frameStart.toISOString(),
        snapshot: day.snapshot,
        now: FIXED_NOW,
      });
      expect(interval.work).toEqual([expect.objectContaining({
        id: `${sessionId}:agent`,
        sessionId,
        role: "agent",
        eventCount: 1,
      })]);

      const detail = await source.fetchWork({
        personId,
        start: frameStart.toISOString(),
        sessionId,
        role: "agent",
        snapshot: day.snapshot,
        now: FIXED_NOW,
      });
      expect(detail.items).toEqual([expect.objectContaining({
        role: "assistant",
        content,
      })]);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("returns exactly three canonical human prompts without copied worker context", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const primarySessionId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const frameStart = new Date("2026-08-18T11:20:00.000Z");
    const promptContents = [
      "Trace the interval timeout",
      "Keep the prompt identities source-backed",
      "Show exactly three human prompts",
    ];
    let source;

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)`,
        [workspaceId, `prompt-${workspaceId}`, "Prompt identity fixture"],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key, display_name, email)
         values ($1, $2, $3, 'Prompt Person', 'prompt@e3group.ai')`,
        [personId, workspaceId, `person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $4, 'primary', 'fixture.v1', $5)`,
        [
          primarySessionId, workspaceId, personId, primarySessionId,
          frameStart.toISOString(),
        ],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           parent_session_id, actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $4, $5, 'worker', 'fixture.v1', $6)`,
        [
          workerSessionId, workspaceId, personId, workerSessionId,
          primarySessionId, frameStart.toISOString(),
        ],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values (
           $1, $2, $3, 'fixture', 'rollout', $4, 'fixture-generation', 0, 0,
           400, 400, repeat('a', 64), $5, 'identity', 400, repeat('b', 64), 4,
           'fixture.v1'
         )`,
        [batchId, workspaceId, personId, `stream-${batchId}`, `fixture/${batchId}`],
      );

      const promptEvents = [
        ...promptContents.map((content, index) => ({
          sessionId: primarySessionId,
          actorRole: "primary",
          origin: "human",
          content,
          hash: String(index + 1).repeat(64),
          at: new Date(frameStart.getTime() + (index + 1) * 1000),
        })),
        {
          sessionId: workerSessionId,
          actorRole: "worker",
          origin: "parent_agent",
          content: promptContents[0],
          hash: "1".repeat(64),
          at: new Date(frameStart.getTime() + 4500),
        },
      ];
      for (const [index, event] of promptEvents.entries()) {
        const [record] = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, parse_status,
             native_type, native_payload_type
           ) values ($1, $2, $3, $4, $5, $6, 'ok', 'event_msg', 'user_message')
           returning id`,
          [
            workspaceId, batchId, index, index * 100, index * 100 + 100,
            String(index + 5).repeat(64),
          ],
        );
        await sql.unsafe(
          `insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, source_priority, event_kind, event_subtype,
             actor_role, occurred_at, observed_at, server_received_at,
             message_role, message_origin, content_sha256, content_byte_size,
             content_excerpt
           ) values (
             $1, $2, $3, $4, 0, 100, 'message', 'user_message', $5,
             $6, $6, $6, 'user', $7, $8, $9, $10
           )`,
          [
            workspaceId, event.sessionId, record.id, NORMALIZER_VERSION,
            event.actorRole, event.at.toISOString(), event.origin, event.hash,
            Buffer.byteLength(event.content, "utf8"), event.content,
          ],
        );
      }

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const day = await source.fetchDay({ now: FIXED_NOW });
      const person = day.people[0];
      expect(person.buckets[bucketIndex(frameStart)][3]).toBe(3);

      const interval = await source.fetchInterval({
        personId,
        start: frameStart.toISOString(),
        snapshot: day.snapshot,
        now: FIXED_NOW,
      });
      expect(interval.prompts).toHaveLength(3);
      expect(interval.prompts.map(({ content }) => content)).toEqual(promptContents);
      expect(new Set(interval.prompts.map(({ id }) => id))).toHaveProperty("size", 3);
      expect(interval.prompts.every(({ sessionId }) => sessionId === primarySessionId)).toBe(true);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

  it("returns the same canonical primary-human prompts counted by the aggregate", async () => {
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let source;
    const bucketStart = "2026-08-18T11:00:00.000Z";
    const messages = [
      {
        at: "2026-08-18T11:01:00.000Z",
        kind: "agent_message",
        subtype: "agent_message",
        role: "assistant",
        origin: "system",
        nativePayloadType: "agent_message",
        excerpt: "I will inspect the cache implementation.",
        hash: "d".repeat(64),
      },
      {
        at: "2026-08-18T11:02:00.000Z",
        kind: "message",
        subtype: "user_message",
        role: "user",
        origin: "human",
        nativePayloadType: "user_message",
        excerpt: "Fix the cache race and add a regression test.",
        hash: "e".repeat(64),
      },
      {
        at: "2026-08-18T11:03:00.000Z",
        kind: "message",
        subtype: "user_message",
        role: "user",
        origin: "human",
        nativePayloadType: "user_message",
        excerpt: "Also cover cancellation.",
        hash: "f".repeat(64),
      },
    ];

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'MCP prompt fixture')`,
        [workspaceId, `mcp-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key, display_name, email)
         values ($1, $2, $3, 'Prompt Person', 'prompt@e3group.ai')`,
        [personId, workspaceId, `person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $5, 'primary', 'fixture.v1', $4)`,
        [sessionId, workspaceId, personId, bucketStart, sessionId],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values (
           $1, $2, $3, 'fixture', 'rollout', $4, 'fixture-generation', 0, 0,
           300, 300, repeat('a', 64), $5, 'identity', 300, repeat('b', 64), 3,
           'fixture.v1'
         )`,
        [batchId, workspaceId, personId, `stream-${batchId}`, `fixture/${batchId}`],
      );

      for (const [index, message] of messages.entries()) {
        const [record] = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, native_type,
             native_payload_type, occurred_at, parse_status
           ) values ($1, $2, $3, $4, $5, repeat('c', 64), 'event_msg', $6, $7, 'ok')
           returning id`,
          [
            workspaceId,
            batchId,
            index,
            index * 100,
            index * 100 + 100,
            message.nativePayloadType,
            message.at,
          ],
        );
        await sql.unsafe(
          `insert into telemetry.events (
             workspace_id, session_id, source_record_id, normalizer_version,
             projection_index, source_priority, event_kind, event_subtype,
             actor_role, occurred_at, observed_at, server_received_at,
             message_role, message_origin, content_sha256, content_byte_size,
             content_excerpt
           ) values (
             $1, $2, $3, $4, 0, 50, $5, $6, 'primary', $7, $7, $7,
             $8, $9, $10, $11, $12
           )`,
          [
            workspaceId,
            sessionId,
            record.id,
            NORMALIZER_VERSION,
            message.kind,
            message.subtype,
            message.at,
            message.role,
            message.origin,
            message.hash,
            Buffer.byteLength(message.excerpt, "utf8"),
            message.excerpt,
          ],
        );
      }

      source = new DirectFlameSource({
        databaseUrl: DATABASE_URL,
        workspaceId,
        expectedEmailDomain: "e3group.ai",
      });
      const aggregate = await source.fetchDay({ now: FIXED_NOW });
      const bucket = aggregate.people[0].buckets[bucketIndex(new Date(bucketStart))];
      const evidence = await source.fetchPromptEvidence({
        personId,
        start: bucketStart,
        snapshot: aggregate.snapshot,
        now: FIXED_NOW,
      });

      expect(bucket[3]).toBe(2);
      expect(evidence.prompts.map(({ excerpt }) => excerpt)).toEqual([
        "Fix the cache race and add a regression test.",
        "Also cover cancellation.",
      ]);
      expect(evidence.eligiblePromptCount).toBe(2);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);
});
