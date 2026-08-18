import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  BUCKET_MS,
  DirectFlameSource,
  NORMALIZER_VERSION,
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

async function cleanup(sql, workspaceId) {
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
  it("excludes copied pre-start history after canonical selection", async () => {
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
        `insert into telemetry.people (id, workspace_id, identity_key, display_name)
         values ($1, $2, $3, $4)`,
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

      source = new DirectFlameSource({ databaseUrl: DATABASE_URL, workspaceId });
      const payload = await source.fetchDay({ now: FIXED_NOW });
      const person = payload.people[0];

      expect(payload.people).toHaveLength(1);
      expect(payload.latest).toBe("2026-08-18T11:30:00.000Z");
      expect(person.total).toEqual([1, 3, 1]);
      expect(person.lastActivity).toBe("2026-08-18T11:30:00.000Z");
      expect(person.activeSeconds).toBe(3_000);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:10:00.000Z"))])
        .toEqual([1, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:20:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:30:00.000Z"))])
        .toEqual([0, 0, 0, 0]);
      expect(person.buckets[bucketIndex(new Date("2026-08-18T10:40:00.000Z"))])
        .toEqual([0, 1, 0, 0]);
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
        `insert into telemetry.people (id, workspace_id, identity_key, display_name)
         values ($1, $2, $3, 'Prompt Person')`,
        [personId, workspaceId, `person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $1, 'primary', 'fixture.v1', $4)`,
        [primarySessionId, workspaceId, personId, frameStart.toISOString()],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           parent_session_id, actor_role, role_version, started_at
         ) values ($1, $2, $3, 'fixture', $1, $4, 'worker', 'fixture.v1', $5)`,
        [workerSessionId, workspaceId, personId, primarySessionId, frameStart.toISOString()],
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

      source = new DirectFlameSource({ databaseUrl: DATABASE_URL, workspaceId });
      const day = await source.fetchDay({ now: FIXED_NOW });
      const person = day.people[0];
      expect(person.buckets[bucketIndex(frameStart)][3]).toBe(3);

      const interval = await source.fetchInterval({
        personId,
        start: frameStart.toISOString(),
        snapshot: day.snapshot,
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
});
