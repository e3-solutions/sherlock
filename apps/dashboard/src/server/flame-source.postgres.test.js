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
  it("shows the E3 identity instead of a matching Core Edge identity", async () => {
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

      source = new DirectFlameSource({ databaseUrl: DATABASE_URL, workspaceId });
      const payload = await source.fetchDay({ now: FIXED_NOW });

      expect(payload.people.map(({ id }) => id)).toEqual([e3Id, unmatchedId]);
    } finally {
      if (source) await source.close();
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);

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
});
