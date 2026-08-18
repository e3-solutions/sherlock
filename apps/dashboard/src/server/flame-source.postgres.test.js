import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_VERSION,
  BUCKET_COUNT,
  BUCKET_MS,
  DirectFlameSource,
  FLAME_SQL,
  NORMALIZER_VERSION,
} from "./flame-source.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const START = "2026-08-17T12:00:00.000Z";
const END = "2026-08-18T12:00:00.000Z";
const READ = "2026-08-18T12:00:01.000Z";
const FIXED_NOW = new Date("2026-08-18T12:10:00.000Z");
const HASH = "a".repeat(64);
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

async function seedSource(sql, { workspaceId, personId, label }) {
  const batchId = crypto.randomUUID();
  await sql.unsafe(
    `insert into telemetry.ingest_batches (
       id, workspace_id, person_id, collector_key, source_kind,
       source_stream_key, generation_key, generation_seq, start_offset,
       end_offset, source_byte_count, source_sha256, storage_path,
       storage_encoding, stored_byte_count, stored_sha256, record_count,
       contract_version, committed_at
     ) values (
       $1, $2, $3, $4, 'rollout', $5, $6, 0, 0, 1, 1, $7, $8,
       'gzip', 1, $7, 1, 'integration-test', $9
     )`,
    [
      batchId,
      workspaceId,
      personId,
      `flame-${label}`,
      `stream-${batchId}`,
      `generation-${batchId}`,
      HASH,
      `flame-integration/${batchId}.jsonl.gz`,
      START,
    ],
  );
  const rows = await sql.unsafe(
    `insert into telemetry.native_records (
       workspace_id, batch_id, record_index, source_start_offset,
       source_end_offset, record_sha256, native_type, occurred_at, parse_status
     ) values ($1, $2, 0, 0, 1, $3, 'integration_test', $4, 'ok')
     returning id`,
    [workspaceId, batchId, HASH, START],
  );
  return rows[0].id;
}

async function seedEvent(sql, {
  workspaceId,
  sessionId,
  sourceRecordId,
  projectionIndex,
}) {
  const rows = await sql.unsafe(
    `insert into telemetry.events (
       workspace_id, session_id, source_record_id, normalizer_version,
       projection_index, source_priority, event_kind, actor_role,
       occurred_at, server_received_at
     ) values ($1, $2, $3, $4, $5, 1, 'ignored', 'primary', $6, $6)
     returning id`,
    [
      workspaceId,
      sessionId,
      sourceRecordId,
      NORMALIZER_VERSION,
      projectionIndex,
      START,
    ],
  );
  return rows[0].id;
}

async function seedSpan(sql, {
  workspaceId,
  sessionId,
  personId,
  spanKey,
  validFromEventId,
  startedAt = null,
  endedAt = null,
  spanState = "active",
  actorRole = "primary",
  isTombstone = false,
}) {
  await sql.unsafe(
    `insert into analytics.activity_spans (
       workspace_id, session_id, person_id, span_key, activity_version,
       valid_from_event_id, started_at, ended_at, span_state, activity_kind,
       timing_basis, confidence, estimated_start, estimated_end, actor_role,
       is_tombstone
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'turn', 'lifecycle',
       'exact', false, false, $10, $11
     )`,
    [
      workspaceId,
      sessionId,
      personId,
      spanKey,
      ACTIVITY_VERSION,
      validFromEventId,
      startedAt,
      endedAt,
      spanState,
      actorRole,
      isTombstone,
    ],
  );
}

async function cleanup(sql, workspaceId) {
  await sql.unsafe(
    "delete from processing.telemetry_jobs where workspace_id = $1",
    [workspaceId],
  );
  await sql.unsafe(
    "delete from analytics.activity_spans where workspace_id = $1",
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
  it("executes the production query with unioned and latest-revision active time", async () => {
    const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
    const workspaceId = crypto.randomUUID();
    const activePersonId = crypto.randomUUID();
    const boundaryPersonId = crypto.randomUUID();
    const zeroPersonId = crypto.randomUUID();
    const primarySessionId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const boundarySessionId = crypto.randomUUID();

    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Flame integration test')`,
        [workspaceId, `flame-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key, display_name)
         values ($1, $4, 'active', 'Active'),
                ($2, $4, 'boundary', 'Boundary'),
                ($3, $4, 'zero', 'Zero')`,
        [activePersonId, boundaryPersonId, zeroPersonId, workspaceId],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values
           ($1, $4, $5, 'flame-active', 'primary', 'primary', 'test', $7),
           ($2, $4, $5, 'flame-active', 'worker', 'worker', 'test', $7),
           ($3, $4, $6, 'flame-boundary', 'boundary', 'primary', 'test', $7)`,
        [
          primarySessionId,
          workerSessionId,
          boundarySessionId,
          workspaceId,
          activePersonId,
          boundaryPersonId,
          "2026-08-17T10:00:00.000Z",
        ],
      );

      const activeSourceRecordId = await seedSource(sql, {
        workspaceId,
        personId: activePersonId,
        label: "active",
      });
      const boundarySourceRecordId = await seedSource(sql, {
        workspaceId,
        personId: boundaryPersonId,
        label: "boundary",
      });
      const primaryEarlierEventId = await seedEvent(sql, {
        workspaceId,
        sessionId: primarySessionId,
        sourceRecordId: activeSourceRecordId,
        projectionIndex: 0,
      });
      const primaryLaterEventId = await seedEvent(sql, {
        workspaceId,
        sessionId: primarySessionId,
        sourceRecordId: activeSourceRecordId,
        projectionIndex: 1,
      });
      const workerEventId = await seedEvent(sql, {
        workspaceId,
        sessionId: workerSessionId,
        sourceRecordId: activeSourceRecordId,
        projectionIndex: 2,
      });
      const boundaryEventId = await seedEvent(sql, {
        workspaceId,
        sessionId: boundarySessionId,
        sourceRecordId: boundarySourceRecordId,
        projectionIndex: 0,
      });

      // These overlap across sessions and clip to one unioned [12:00, 14:00) range.
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "overlap-primary",
        validFromEventId: primaryEarlierEventId,
        startedAt: "2026-08-17T11:30:00.000Z",
        endedAt: "2026-08-17T13:00:00.000Z",
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: workerSessionId,
        personId: activePersonId,
        spanKey: "overlap-worker",
        validFromEventId: workerEventId,
        startedAt: "2026-08-17T12:30:00.000Z",
        endedAt: "2026-08-17T14:00:00.000Z",
        actorRole: "worker",
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "clips-at-end",
        validFromEventId: primaryLaterEventId,
        startedAt: "2026-08-18T11:00:00.000Z",
        endedAt: "2026-08-18T13:00:00.000Z",
      });

      // A same-cutoff correction wins by id and tombstones the earlier interval.
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "same-cutoff-tombstone",
        validFromEventId: primaryLaterEventId,
        startedAt: "2026-08-17T15:00:00.000Z",
        endedAt: "2026-08-17T16:00:00.000Z",
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "same-cutoff-tombstone",
        validFromEventId: primaryLaterEventId,
        isTombstone: true,
      });

      // The latest revision moved outside the window, so the older interval is stale.
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "moved-outside",
        validFromEventId: primaryEarlierEventId,
        startedAt: "2026-08-17T16:00:00.000Z",
        endedAt: "2026-08-17T17:00:00.000Z",
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "moved-outside",
        validFromEventId: primaryLaterEventId,
        startedAt: "2026-08-18T13:00:00.000Z",
        endedAt: "2026-08-18T14:00:00.000Z",
      });

      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "automation",
        validFromEventId: primaryLaterEventId,
        startedAt: "2026-08-17T18:00:00.000Z",
        endedAt: "2026-08-17T19:00:00.000Z",
        actorRole: "automation",
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: primarySessionId,
        personId: activePersonId,
        spanKey: "detected-open",
        validFromEventId: primaryLaterEventId,
        startedAt: "2026-08-17T19:00:00.000Z",
        endedAt: "2026-08-17T20:00:00.000Z",
        spanState: "detected_open",
      });

      // Half-open boundaries exclude spans ending at start or starting at end.
      await seedSpan(sql, {
        workspaceId,
        sessionId: boundarySessionId,
        personId: boundaryPersonId,
        spanKey: "ends-at-start",
        validFromEventId: boundaryEventId,
        startedAt: "2026-08-17T11:00:00.000Z",
        endedAt: START,
      });
      await seedSpan(sql, {
        workspaceId,
        sessionId: boundarySessionId,
        personId: boundaryPersonId,
        spanKey: "starts-at-end",
        validFromEventId: boundaryEventId,
        startedAt: END,
        endedAt: "2026-08-18T13:00:00.000Z",
      });

      const rows = await sql.unsafe(FLAME_SQL, [
        workspaceId,
        START,
        END,
        NORMALIZER_VERSION,
        READ,
        ACTIVITY_VERSION,
      ]);
      expect(rows).toHaveLength(3 * BUCKET_COUNT);

      const secondsByPerson = new Map();
      for (const row of rows) {
        const seconds = Number(row.active_seconds);
        const personId = String(row.person_id);
        if (!secondsByPerson.has(personId)) secondsByPerson.set(personId, new Set());
        secondsByPerson.get(personId).add(seconds);
      }
      expect([...secondsByPerson.get(activePersonId)]).toEqual([10_800]);
      expect([...secondsByPerson.get(boundaryPersonId)]).toEqual([0]);
      expect([...secondsByPerson.get(zeroPersonId)]).toEqual([0]);
    } finally {
      try {
        await cleanup(sql, workspaceId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 20_000);

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
