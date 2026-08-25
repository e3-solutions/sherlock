import postgres from "npm:postgres@3.4.7";
import { FRAME_VERSION } from "../../packages/frame-evidence/constants.js";
import { proveAndActivateFrameProjection } from "../../scripts/backfill-frame-evidence.ts";
import { PostgresFrameEvidenceProjector } from "./frame-projector.ts";

const permission = await Deno.permissions.query({
  name: "env",
  variable: "SHERLOCK_TEST_DATABASE_URL",
});
const databaseUrl = permission.state === "granted"
  ? Deno.env.get("SHERLOCK_TEST_DATABASE_URL")
  : undefined;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  message: string,
  expectedError?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (expectedError) {
      assert(
        String(error).includes(expectedError),
        `${message}: unexpected error ${String(error)}`,
      );
    }
    return;
  }
  throw new Error(message);
}

Deno.test({
  name:
    "frame projector serializes reruns and activation proves source corrections",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(databaseUrl!, { prepare: false, max: 4 });
    const projector = PostgresFrameEvidenceProjector.connect(databaseUrl!);
    const workspaceId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const oldSessionId = crypto.randomUUID();
    const parentSessionId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const unrelatedWorkspaceId = crypto.randomUUID();
    const unrelatedPersonId = crypto.randomUUID();
    const unrelatedBatchId = crypto.randomUUID();
    const now = new Date("2026-08-20T20:00:00.000Z");
    const proofWindowStart = new Date("2026-08-20T19:58:00.000Z");
    try {
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Frame projector test')`,
        [workspaceId, `frame-projector-${workspaceId}`],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key)
         values ($1, $2, $3)`,
        [personId, workspaceId, `frame-person-${personId}`],
      );
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1,$2,$3,'frame-collector',$4,'unknown','test.role.v1',$5)`,
        [
          sessionId,
          workspaceId,
          personId,
          `native-${sessionId}`,
          "2026-08-20T19:58:00Z",
        ],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values ($1,$2,$3,'frame-collector','rollout','frame-stream',
           'frame-generation',0,0,2,2,$4,$5,'identity',2,$6,2,'test.contract.v1')`,
        [
          batchId,
          workspaceId,
          personId,
          "a".repeat(64),
          `frame/${workspaceId}`,
          "b".repeat(64),
        ],
      );
      await sql.unsafe(
        `insert into telemetry.workspaces (id, slug, name)
         values ($1, $2, 'Unrelated frame projector test')`,
        [
          unrelatedWorkspaceId,
          `unrelated-frame-projector-${unrelatedWorkspaceId}`,
        ],
      );
      await sql.unsafe(
        `insert into telemetry.people (id, workspace_id, identity_key)
         values ($1, $2, $3)`,
        [
          unrelatedPersonId,
          unrelatedWorkspaceId,
          `unrelated-frame-person-${unrelatedPersonId}`,
        ],
      );
      await sql.unsafe(
        `insert into telemetry.ingest_batches (
           id, workspace_id, person_id, collector_key, source_kind,
           source_stream_key, generation_key, generation_seq, start_offset,
           end_offset, source_byte_count, source_sha256, storage_path,
           storage_encoding, stored_byte_count, stored_sha256, record_count,
           contract_version
         ) values ($1,$2,$3,'unrelated-frame-collector','rollout',
           'unrelated-frame-stream','unrelated-frame-generation',0,0,1,1,$4,
           $5,'identity',1,$6,1,'test.contract.v1')`,
        [
          unrelatedBatchId,
          unrelatedWorkspaceId,
          unrelatedPersonId,
          "e".repeat(64),
          `unrelated-frame/${unrelatedWorkspaceId}`,
          "f".repeat(64),
        ],
      );
      const nativeRows = [];
      for (const index of [0, 1]) {
        const inserted = await sql.unsafe(
          `insert into telemetry.native_records (
             workspace_id, batch_id, record_index, source_start_offset,
             source_end_offset, record_sha256, native_type,
             native_payload_type, occurred_at, parse_status
           ) values ($1,$2,$3::integer,$3::bigint,$4,$5,
                     'event_msg','user_message',$6,'ok')
           returning id::text id`,
          [
            workspaceId,
            batchId,
            index,
            index + 1,
            "c".repeat(64),
            `2026-08-20T19:59:0${index}.000Z`,
          ],
        );
        nativeRows.push(String(inserted[0].id));
      }
      const reserved = await sql.unsafe(
        "select nextval(pg_get_serial_sequence('telemetry.events','id'))::text id",
      );
      const lowerEventId = BigInt(String(reserved[0].id));
      const high = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at,
           message_role, message_origin, content_sha256, content_byte_size,
           content_excerpt
         ) values ($1,$2,$3,'sherlock.codex-rollout.v1',0,100,'message',
           'user_message','unknown',$4,$4,$4,'user','human',$5,12,'Visible prompt')
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          nativeRows[1],
          "2026-08-20T19:59:01.000Z",
          "d".repeat(64),
        ],
      );
      const highEventId = BigInt(String(high[0].id));
      assert(lowerEventId < highEventId);
      const otherVersion = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) values ($1,$2,$3,'sherlock.claude-code-transcript.v1',0,100,
           'lifecycle','turn_complete','unknown',$4,$4,$4)
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          nativeRows[0],
          "2026-08-20T19:59:02.000Z",
        ],
      );
      const otherVersionEventId = BigInt(String(otherVersion[0].id));
      assert(otherVersionEventId > highEventId);
      const laterTimestamp = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, canonical_scope_key, logical_event_key,
           source_priority, event_kind, event_subtype, actor_role,
           occurred_at, observed_at, server_received_at
         ) values ($1,$2,$3,'sherlock.codex-rollout.v1',1,'micro-scope',
           'micro-logical',100,'reasoning','reasoning','unknown',
           $4::text::timestamptz,$4::text::timestamptz,$4::text::timestamptz)
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          nativeRows[0],
          "2026-08-20T19:59:03.000900Z",
        ],
      );
      const laterTimestampEventId = BigInt(String(laterTimestamp[0].id));
      const earlierTimestamp = await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, canonical_scope_key, logical_event_key,
           source_priority, event_kind, event_subtype, actor_role,
           occurred_at, observed_at, server_received_at
         ) values ($1,$2,$3,'sherlock.codex-rollout.v1',2,'micro-scope',
           'micro-logical',100,'reasoning','reasoning','unknown',
           $4::text::timestamptz,$4::text::timestamptz,$4::text::timestamptz)
         returning id::text id`,
        [
          workspaceId,
          sessionId,
          nativeRows[0],
          "2026-08-20T19:59:03.000100Z",
        ],
      );
      const earlierTimestampEventId = BigInt(String(earlierTimestamp[0].id));
      assert(earlierTimestampEventId > laterTimestampEventId);
      const rawMicroseconds = await sql.unsafe(
        `select id::text id,
                to_char(occurred_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at
           from telemetry.events
          where workspace_id = $1 and id in ($2::bigint, $3::bigint)
          order by id`,
        [
          workspaceId,
          laterTimestampEventId.toString(),
          earlierTimestampEventId.toString(),
        ],
      );
      assert(
        rawMicroseconds.length === 2,
        `microsecond fixture row count: ${JSON.stringify(rawMicroseconds)}`,
      );
      assert(
        rawMicroseconds[0].id === laterTimestampEventId.toString() &&
          rawMicroseconds[0].occurred_at ===
            "2026-08-20T19:59:03.000900Z",
        `later microsecond fixture changed: ${JSON.stringify(rawMicroseconds)}`,
      );
      assert(
        rawMicroseconds[1].id === earlierTimestampEventId.toString() &&
          rawMicroseconds[1].occurred_at ===
            "2026-08-20T19:59:03.000100Z",
        `earlier microsecond fixture changed: ${
          JSON.stringify(rawMicroseconds)
        }`,
      );

      const rolePrivileges = await sql.unsafe(
        `select has_table_privilege(
           'sherlock_frame_projector', 'telemetry.sessions', 'UPDATE'
         ) can_update_sessions`,
      );
      assert(
        rolePrivileges.length === 1 &&
          !rolePrivileges[0].can_update_sessions,
        "projector role must not need session UPDATE privilege",
      );
      const concurrent = await Promise.all([
        projector.projectSession({
          workspaceId,
          sessionId,
          requestGeneration: 1n,
          now,
        }),
        projector.projectSession({
          workspaceId,
          sessionId,
          requestGeneration: 1n,
          now,
        }),
      ]);
      assert(
        concurrent.filter((result) => result.receipt_id !== null).length === 1,
        "concurrent exact reruns must append exactly one receipt",
      );
      assert(
        concurrent.reduce((sum, result) => sum + result.inserted_count, 0) > 0,
      );
      const initialReceipts = await sql.unsafe(
        `select count(*)::int count
           from analytics.frame_projection_receipts
          where workspace_id = $1 and session_id = $2 and frame_version = $3`,
        [workspaceId, sessionId, FRAME_VERSION],
      );
      assert(initialReceipts[0].count === 1);
      const microsecondCanonical = await sql.unsafe(
        `select source_event_id::text source_event_id,
                to_char(observed_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at
           from analytics.frame_evidence_revisions
          where workspace_id = $1 and session_id = $2
            and frame_version = $3 and evidence_kind = 'activity'
            and event_kind = 'reasoning' and not is_tombstone`,
        [workspaceId, sessionId, FRAME_VERSION],
      );
      assert(
        microsecondCanonical.length === 1,
        `canonical microsecond row count: ${
          JSON.stringify(microsecondCanonical)
        }`,
      );
      assert(
        microsecondCanonical[0].source_event_id ===
          earlierTimestampEventId.toString(),
        `canonical microsecond source id: ${
          JSON.stringify(microsecondCanonical)
        }`,
      );
      assert(
        microsecondCanonical[0].observed_at ===
          "2026-08-20T19:59:03.000100Z",
        `stored canonical microseconds: ${
          JSON.stringify(microsecondCanonical)
        }`,
      );
      await assertRejects(
        () =>
          proveAndActivateFrameProjection(sql, {
            workspaceId,
            activate: false,
            windowStart: proofWindowStart,
          }),
        "target-workspace normalization backlog must block activation",
        "normalization or reduction jobs",
      );
      const completedNormalize = await sql.unsafe(
        `update processing.telemetry_jobs
            set status = 'succeeded', completed_at = now(), updated_at = now()
          where workspace_id = $1 and batch_id = $2
            and job_kind = 'normalize'
          returning id::text id`,
        [workspaceId, batchId],
      );
      assert(completedNormalize.length === 1);
      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1,$2,$3,'frame-collector',$4,'primary','test.role.v1',$5)`,
        [
          oldSessionId,
          workspaceId,
          personId,
          `native-${oldSessionId}`,
          "2026-08-18T18:00:00Z",
        ],
      );
      await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) values ($1,$2,$3,'sherlock.codex-rollout.v1',8,100,'lifecycle',
           'turn_complete','primary',$4,$4,$4)`,
        [workspaceId, oldSessionId, nativeRows[0], "2026-08-18T18:01:00Z"],
      );
      await proveAndActivateFrameProjection(sql, {
        workspaceId,
        activate: false,
        windowStart: new Date("2026-08-19T18:00:00Z"),
      });
      const oldReceipts = await sql.unsafe(
        `select count(*)::int count
           from analytics.frame_projection_receipts
          where workspace_id = $1 and session_id = $2`,
        [workspaceId, oldSessionId],
      );
      assert(oldReceipts[0].count === 0, "old-only sessions need no receipt");

      await sql.unsafe(
        `insert into telemetry.sessions (
           id, workspace_id, person_id, collector_key, native_session_id,
           actor_role, role_version, started_at
         ) values ($1,$2,$3,'frame-collector',$4,'primary','test.role.v1',$5)`,
        [
          parentSessionId,
          workspaceId,
          personId,
          `native-${parentSessionId}`,
          "2026-08-20T19:57:00Z",
        ],
      );
      await sql.unsafe(
        `update telemetry.sessions
            set parent_session_id = $3,
                updated_at = '2026-08-20T20:00:01.123456Z'
          where workspace_id = $1 and id = $2`,
        [workspaceId, sessionId, parentSessionId],
      );
      await assertRejects(
        () =>
          proveAndActivateFrameProjection(sql, {
            workspaceId,
            activate: true,
            windowStart: proofWindowStart,
          }),
        "session metadata changes must make activation proof fail",
      );
      const parentCorrection = await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 2n,
        now,
      });
      assert(
        parentCorrection.receipt_id !== null &&
          parentCorrection.inserted_count > 0,
        "parent repair must append an effective-role correction",
      );
      await proveAndActivateFrameProjection(sql, {
        workspaceId,
        activate: false,
        windowStart: proofWindowStart,
      });

      await sql.unsafe(
        `insert into telemetry.events (
           id, workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) overriding system value values (
           $1,$2,$3,$4,'sherlock.codex-rollout.v1',0,100,'lifecycle',
           'turn_started','unknown',$5,$5,$5
         )`,
        [
          lowerEventId.toString(),
          workspaceId,
          sessionId,
          nativeRows[0],
          "2026-08-20T19:59:00.000Z",
        ],
      );
      await assertRejects(
        () =>
          proveAndActivateFrameProjection(sql, {
            workspaceId,
            activate: true,
            windowStart: proofWindowStart,
          }),
        "a committed lower-id source event must make activation proof fail",
      );
      const prematureActivations = await sql.unsafe(
        `select count(*)::int count
           from analytics.frame_projection_activations
          where workspace_id = $1 and frame_version = $2`,
        [workspaceId, FRAME_VERSION],
      );
      assert(
        prematureActivations[0].count === 0,
        "failed proof and activation must roll back atomically",
      );
      const corrected = await projector.projectSession({
        workspaceId,
        sessionId,
        requestGeneration: 3n,
        now,
      });
      assert(corrected.receipt_id !== null && corrected.inserted_count > 0);
      await proveAndActivateFrameProjection(sql, {
        workspaceId,
        activate: true,
        windowStart: proofWindowStart,
      });
      const activations = await sql.unsafe(
        `select count(*)::int count
           from analytics.frame_projection_activations
          where workspace_id = $1 and frame_version = $2`,
        [workspaceId, FRAME_VERSION],
      );
      assert(
        activations[0].count === 1,
        "corrected projection must validate and activate atomically",
      );
      const receipts = await sql.unsafe(
        `select through_event_id::text through_event_id,
                source_event_count::text source_event_count,
                source_state_sha256,
                to_char(session_updated_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') session_updated_at
           from analytics.frame_projection_receipts
          where workspace_id = $1 and session_id = $2 and frame_version = $3
          order by id`,
        [workspaceId, sessionId, FRAME_VERSION],
      );
      assert(
        receipts.length === 3,
        "each source correction must append one receipt",
      );
      assert(
        receipts[0].through_event_id === earlierTimestampEventId.toString(),
        "projection must resolve the all-normalizer cutoff itself",
      );
      assert(
        receipts.every((receipt) =>
          receipt.through_event_id === receipts[0].through_event_id
        ),
      );
      assert(receipts[0].source_event_count === "4");
      assert(receipts[1].source_event_count === "4");
      assert(receipts[2].source_event_count === "5");
      assert(receipts.every((receipt) => receipt.session_updated_at !== null));
      assert(
        receipts[1].session_updated_at === "2026-08-20T20:00:01.123456Z",
        "receipt must preserve the session timestamp microseconds",
      );
      assert(
        receipts[0].source_state_sha256 !== receipts[1].source_state_sha256,
      );
      assert(
        receipts[1].source_state_sha256 !== receipts[2].source_state_sha256,
      );
      const lowerRevision = await sql.unsafe(
        `select actor_role, is_tombstone
           from analytics.frame_evidence_revisions
          where workspace_id = $1 and session_id = $2
            and source_event_id = $3 and evidence_kind = 'activity'
          order by id desc limit 1`,
        [workspaceId, sessionId, lowerEventId.toString()],
      );
      assert(
        lowerRevision.length === 1 &&
          lowerRevision[0].actor_role === "worker" &&
          !lowerRevision[0].is_tombstone,
      );
      await sql.unsafe(
        `insert into telemetry.events (
           workspace_id, session_id, source_record_id, normalizer_version,
           projection_index, source_priority, event_kind, event_subtype,
           actor_role, occurred_at, observed_at, server_received_at
         ) values ($1,$2,$3,'sherlock.codex-rollout.v1',9,100,'lifecycle',
           'turn_complete','worker',$4,$4,$4)`,
        [workspaceId, sessionId, nativeRows[0], "2026-08-21T20:00:00Z"],
      );
      await assertRejects(
        () =>
          projector.projectSession({
            workspaceId,
            sessionId,
            requestGeneration: 4n,
            now,
          }),
        "future evidence must fail closed until its timestamp is corrected",
        "future event",
      );
    } finally {
      await projector.close();
      await cleanup(sql, workspaceId);
      await cleanup(sql, unrelatedWorkspaceId);
      await sql.end();
    }
  },
});

async function cleanup(
  sql: ReturnType<typeof postgres>,
  workspaceId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      "delete from processing.telemetry_jobs where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe(
      "delete from analytics.frame_projection_activations where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe(
      "delete from analytics.frame_evidence_revisions where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe(
      "delete from analytics.frame_projection_receipts where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe("delete from telemetry.events where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe(
      "delete from telemetry.native_records where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe(
      "delete from telemetry.ingest_batches where workspace_id = $1",
      [workspaceId],
    );
    await tx.unsafe("delete from telemetry.sessions where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe("delete from telemetry.people where workspace_id = $1", [
      workspaceId,
    ]);
    await tx.unsafe("delete from telemetry.workspaces where id = $1", [
      workspaceId,
    ]);
  });
}
