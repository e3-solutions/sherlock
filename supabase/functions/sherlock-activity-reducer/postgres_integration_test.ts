import postgres from "npm:postgres@3.4.7";
import { PostgresActivityReducer } from "./postgres.ts";

const envPermission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = envPermission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : null;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test({
  name:
    "activity reducer is deterministic, versioned, isolated, and recoverable",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const fixture = await seed(sql);
    const reducer = PostgresActivityReducer.connect(databaseUrl!);
    try {
      const immutableBefore = await immutableCounts(sql, fixture.workspaceId);
      await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.v1",
        throughEventId: fixture.replacedWinnerCutoff,
      });
      const open = await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.v1",
        throughEventId: fixture.openCutoff,
        eventPageSize: 2,
      });
      assert(open.candidate_count === 2, "open turn and tool point expected");
      assert(
        open.tombstone_count === 1,
        "canonical replacement must tombstone the old turn key",
      );
      const openRows = await spans(
        sql,
        fixture.workspaceId,
        "test.activity.v1",
        fixture.primarySessionId,
      );
      const openTurn = openRows.find((row) =>
        row.activity_kind === "turn" && !row.is_tombstone &&
        String(row.span_key).includes("turn-1")
      );
      assert(openTurn?.span_state === "detected_open");
      assert(
        String(openTurn.start_event_id) ===
          fixture.canonicalMessageId.toString(),
      );
      assert(
        openRows.some((row) =>
          row.is_tombstone && String(row.span_key).includes("replaced-turn")
        ),
        "superseded canonical span must retain a tombstone revision",
      );

      const beforeRerun = openRows.length;
      await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.v1",
        throughEventId: fixture.openCutoff,
      });
      assert(
        (await spans(
          sql,
          fixture.workspaceId,
          "test.activity.v1",
          fixture.primarySessionId,
        ))
          .length === beforeRerun,
        "same cutoff must be idempotent",
      );

      await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.v1",
        throughEventId: fixture.finalCutoff,
      });
      const closedRows = await spans(
        sql,
        fixture.workspaceId,
        "test.activity.v1",
        fixture.primarySessionId,
      );
      const turnRevisions = closedRows.filter((row) =>
        String(row.span_key).includes("turn-1")
      );
      assert(
        turnRevisions.length === 2,
        "open turn must append a closed revision",
      );
      assert(turnRevisions.some((row) => row.span_state === "active"));

      for (
        const sessionId of [
          fixture.workerSessionId,
          fixture.guardianSessionId,
          fixture.automationSessionId,
        ]
      ) {
        await reducer.reduceSession({
          workspaceId: fixture.workspaceId,
          sessionId,
          normalizerVersion: fixture.normalizerVersion,
          activityVersion: "test.activity.v1",
          throughEventId: fixture.finalCutoff,
        });
      }
      const roleRows = await sql.unsafe(
        `select distinct actor_role from analytics.activity_spans
          where workspace_id = $1 and activity_version = 'test.activity.v1'
          order by actor_role`,
        [fixture.workspaceId],
      );
      const roles = roleRows.map((row) => String(row.actor_role));
      for (const role of ["automation", "guardian", "primary", "worker"]) {
        assert(roles.includes(role), `missing ${role} role`);
      }

      await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.v2",
        throughEventId: fixture.finalCutoff,
      });
      assert(
        Number(
          (await sql.unsafe(
            `select count(*) as count from analytics.activity_spans
            where workspace_id = $1 and activity_version = 'test.activity.v2'`,
            [fixture.workspaceId],
          ))[0].count,
        ) > 0,
        "new activity version must rebuild independently",
      );

      const failing = PostgresActivityReducer.connect(databaseUrl!, {
        beforeWriteCommit: () => {
          throw new Error("synthetic reducer failure");
        },
      });
      try {
        let failed = false;
        try {
          await failing.reduceSession({
            workspaceId: fixture.workspaceId,
            sessionId: fixture.primarySessionId,
            normalizerVersion: fixture.normalizerVersion,
            activityVersion: "test.activity.failure",
            throughEventId: fixture.finalCutoff,
          });
        } catch (error) {
          failed = String(error).includes("synthetic reducer failure");
        }
        assert(failed, "injected failure must escape the reducer transaction");
      } finally {
        await failing.close();
      }
      assert(
        Number(
          (await sql.unsafe(
            `select count(*) as count from analytics.activity_spans
            where workspace_id = $1 and activity_version = 'test.activity.failure'`,
            [fixture.workspaceId],
          ))[0].count,
        ) === 0,
        "failed session transaction must leave no partial spans",
      );
      await reducer.reduceSession({
        workspaceId: fixture.workspaceId,
        sessionId: fixture.primarySessionId,
        normalizerVersion: fixture.normalizerVersion,
        activityVersion: "test.activity.failure",
        throughEventId: fixture.finalCutoff,
      });

      const concurrentA = PostgresActivityReducer.connect(databaseUrl!);
      const concurrentB = PostgresActivityReducer.connect(databaseUrl!);
      try {
        await Promise.all(
          [concurrentA, concurrentB].map((candidate) =>
            candidate.reduceSession({
              workspaceId: fixture.workspaceId,
              sessionId: fixture.guardianSessionId,
              normalizerVersion: fixture.normalizerVersion,
              activityVersion: "test.activity.concurrent",
              throughEventId: fixture.finalCutoff,
            })
          ),
        );
      } finally {
        await Promise.all([concurrentA.close(), concurrentB.close()]);
      }
      const duplicates = await sql.unsafe(
        `select span_key, valid_from_event_id, count(*) as count
           from analytics.activity_spans
          where workspace_id = $1 and activity_version = 'test.activity.concurrent'
          group by span_key, valid_from_event_id having count(*) > 1`,
        [fixture.workspaceId],
      );
      assert(duplicates.length === 0, "concurrent attempts must converge");
      const immutableAfter = await immutableCounts(sql, fixture.workspaceId);
      assert(
        JSON.stringify(immutableAfter) === JSON.stringify(immutableBefore),
        "reduction must not mutate raw, native, or event facts",
      );
    } finally {
      await reducer.close();
      await cleanup(sql, fixture.workspaceId);
      await sql.end();
    }
  },
});

async function seed(sql: ReturnType<typeof postgres>): Promise<{
  workspaceId: string;
  primarySessionId: string;
  workerSessionId: string;
  guardianSessionId: string;
  automationSessionId: string;
  normalizerVersion: string;
  replacedWinnerCutoff: bigint;
  canonicalMessageId: bigint;
  openCutoff: bigint;
  finalCutoff: bigint;
}> {
  const workspaceId = crypto.randomUUID();
  const personId = crypto.randomUUID();
  const primarySessionId = crypto.randomUUID();
  const workerSessionId = crypto.randomUUID();
  const guardianSessionId = crypto.randomUUID();
  const automationSessionId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const normalizerVersion = "test.codex-rollout.v1";
  return await sql.begin(async (tx) => {
    await tx.unsafe(
      `insert into telemetry.workspaces (id, slug, name) values ($1, $2, 'Reducer test')`,
      [workspaceId, `reducer-test-${workspaceId}`],
    );
    await tx.unsafe(
      `insert into telemetry.people (id, workspace_id, identity_key)
       values ($1, $2, 'synthetic-person')`,
      [personId, workspaceId],
    );
    for (
      const session of [
        [primarySessionId, "primary", null],
        [workerSessionId, "worker", primarySessionId],
        [guardianSessionId, "guardian", primarySessionId],
        [automationSessionId, "automation", null],
      ] as const
    ) {
      await tx.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           parent_session_id, actor_role, role_version, project_key, started_at
         ) values ($1, $2, $3, 'synthetic-collector', $4, $5, $6,
                   'test.role.v1', 'sherlock', '2026-08-15T00:00:00Z')`,
        [
          session[0],
          workspaceId,
          personId,
          `native-${session[0]}`,
          session[2],
          session[1],
        ],
      );
    }
    const definitions = [
      [
        primarySessionId,
        "message",
        "user_message",
        "primary",
        "replaced-turn",
        null,
        "human",
        50,
        "message:user:turn-1",
        "2026-08-15T00:00:01Z",
        null,
        null,
      ],
      [
        primarySessionId,
        "message",
        "user_message",
        "primary",
        "turn-1",
        null,
        "human",
        100,
        "message:user:turn-1",
        "2026-08-15T00:00:02Z",
        null,
        null,
      ],
      [
        primarySessionId,
        "tool_call",
        "function_call",
        "primary",
        "turn-1",
        "call-1",
        null,
        100,
        null,
        "2026-08-15T00:00:03Z",
        "completed",
        null,
      ],
      [
        workerSessionId,
        "tool_call",
        "function_call",
        "worker",
        null,
        "worker-call",
        null,
        100,
        null,
        "2026-08-15T00:00:04Z",
        "completed",
        null,
      ],
      [
        guardianSessionId,
        "lifecycle",
        "task_started",
        "guardian",
        null,
        null,
        null,
        100,
        null,
        "2026-08-15T00:00:05Z",
        null,
        null,
      ],
      [
        guardianSessionId,
        "lifecycle",
        "task_complete",
        "guardian",
        null,
        null,
        null,
        100,
        null,
        "2026-08-15T00:00:06Z",
        null,
        null,
      ],
      [
        automationSessionId,
        "tool_call",
        "function_call",
        "automation",
        null,
        "automation-call",
        null,
        100,
        null,
        null,
        "completed",
        null,
      ],
      [
        primarySessionId,
        "message",
        "agent_message",
        "primary",
        "turn-1",
        null,
        "unknown",
        100,
        null,
        "2026-08-15T00:00:08Z",
        null,
        "final_answer",
      ],
    ] as const;
    await tx.unsafe(
      `insert into telemetry.ingest_batches (
         id, workspace_id, person_id, collector_key, source_kind,
         source_stream_key, generation_key, generation_seq, start_offset,
         end_offset, source_byte_count, source_sha256, storage_path,
         storage_encoding, stored_byte_count, stored_sha256, record_count,
         contract_version
       ) values ($1, $2, $3, 'synthetic-collector', 'rollout', 'synthetic-stream',
         'synthetic-generation', 0, 0, $4::bigint, $4::bigint, $5, $6,
         'identity', $4::bigint, $7, $4::integer, 'test.contract.v1')`,
      [
        batchId,
        workspaceId,
        personId,
        definitions.length,
        "a".repeat(64),
        `synthetic/${workspaceId}`,
        "b".repeat(64),
      ],
    );
    const eventIds: bigint[] = [];
    for (let index = 0; index < definitions.length; index += 1) {
      const native = await tx.unsafe(
        `insert into telemetry.native_records (
           workspace_id, batch_id, record_index, source_start_offset,
           source_end_offset, record_sha256, parse_status
         ) values ($1, $2, $3::integer, $3::bigint, $4, $5, 'ok')
         returning id::text as id`,
        [workspaceId, batchId, index, index + 1, "c".repeat(64)],
      );
      const definition = definitions[index];
      const inserted = await tx.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, canonical_scope_key, logical_event_key,
           source_priority, event_kind, event_subtype, actor_role, occurred_at,
           observed_at, server_received_at, turn_id, tool_call_id, tool_status,
           message_origin, phase, project_key
         ) values ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, $11,
                   '2026-08-15T01:00:00Z', $12, $13, $14, $15, $16, 'sherlock')
         returning id::text as id`,
        [
          workspaceId,
          definition[0],
          native[0].id,
          normalizerVersion,
          `session:${definition[0]}`,
          definition[8],
          definition[7],
          definition[1],
          definition[2],
          definition[3],
          definition[9],
          definition[4],
          definition[5],
          definition[10],
          definition[6],
          definition[11],
        ],
      );
      eventIds.push(BigInt(String(inserted[0].id)));
    }
    return {
      workspaceId,
      primarySessionId,
      workerSessionId,
      guardianSessionId,
      automationSessionId,
      normalizerVersion,
      replacedWinnerCutoff: eventIds[0],
      canonicalMessageId: eventIds[1],
      openCutoff: eventIds[6],
      finalCutoff: eventIds[7],
    };
  });
}

async function immutableCounts(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<Record<string, number>> {
  const rows = await sql.unsafe(
    `select
       (select count(*) from telemetry.ingest_batches where workspace_id = $1) as batches,
       (select count(*) from telemetry.native_records where workspace_id = $1) as records,
       (select count(*) from telemetry.events where workspace_id = $1) as events`,
    [workspaceId],
  );
  return {
    batches: Number(rows[0].batches),
    records: Number(rows[0].records),
    events: Number(rows[0].events),
  };
}

async function spans(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
  activityVersion: string,
  sessionId: string,
) {
  return await sql.unsafe(
    `select * from analytics.activity_spans
      where workspace_id = $1 and activity_version = $2 and session_id = $3
      order by valid_from_event_id, span_key`,
    [workspaceId, activityVersion, sessionId],
  );
}

async function cleanup(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      "delete from analytics.activity_spans where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe("delete from telemetry.events where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe(
      "delete from telemetry.native_records where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe("delete from telemetry.sessions where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe(
      "delete from telemetry.ingest_batches where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe("delete from telemetry.people where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe("delete from telemetry.workspaces where id = $1", [
      workspaceId,
    ]);
  });
}
