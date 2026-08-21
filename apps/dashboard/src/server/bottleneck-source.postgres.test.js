import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  BottleneckSource,
  BottleneckSourceError,
  createBottleneckReadinessGate,
} from "./bottleneck-source.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const START = "2026-08-20T00:00:00.000Z";
const END = "2026-08-21T00:00:00.000Z";
const READ = "2026-08-21T00:00:01.000Z";
const CURSOR_SECRET = "p".repeat(32);

function batch(submissionId, count, claim = "claim") {
  return {
    submissionId,
    analysisScope: {
      usageSnapshotToken: "v2.integration-snapshot",
      window: { startInclusive: START, endExclusive: END, readAt: READ },
      completeness: "agent_declared_complete",
    },
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateKey: `candidate-${String(index).padStart(2, "0")}`,
      title: `Candidate ${index}`,
      claim: `${claim} ${index}`,
      evidence: [{
        type: "usage_summary",
        personId: "11111111-1111-4111-8111-111111111111",
      }],
    })),
  };
}

async function configureWorkerLogin(sql) {
  const password = `bottleneck-test-${crypto.randomUUID()}`;
  await sql.unsafe(`alter role sherlock_worker_login password '${password}'`);
  const url = new URL(DATABASE_URL);
  url.username = "sherlock_worker_login";
  url.password = password;
  return url.toString();
}

async function clearWorkerLogin(sql) {
  await sql.unsafe("alter role sherlock_worker_login password null");
}

async function restoreProductPrivileges(sql, posture) {
  await sql.unsafe(
    posture.validator_public_execute
      ? "grant execute on function product.valid_bottleneck_evidence_refs(jsonb) to public"
      : "revoke execute on function product.valid_bottleneck_evidence_refs(jsonb) from public",
  );
  if (posture.validator_writer_grant_option) {
    await sql.unsafe(
      "grant execute on function product.valid_bottleneck_evidence_refs(jsonb) to sherlock_bottleneck_writer with grant option",
    );
  } else {
    await sql.unsafe(
      "revoke grant option for execute on function product.valid_bottleneck_evidence_refs(jsonb) from sherlock_bottleneck_writer",
    );
  }
  await sql.unsafe(
    posture.validator_execute
      ? "grant execute on function product.valid_bottleneck_evidence_refs(jsonb) to sherlock_bottleneck_writer"
      : "revoke execute on function product.valid_bottleneck_evidence_refs(jsonb) from sherlock_bottleneck_writer",
  );
  await sql.unsafe(
    posture.product_create
      ? "grant create on schema product to sherlock_bottleneck_writer"
      : "revoke create on schema product from sherlock_bottleneck_writer",
  );
  await sql.unsafe(
    posture.writer_inherit
      ? "alter role sherlock_bottleneck_writer inherit"
      : "alter role sherlock_bottleneck_writer noinherit",
  );
  await sql.unsafe(
    posture.reader_membership
      ? "grant sherlock_reader to sherlock_bottleneck_writer with inherit false, set true"
      : "revoke sherlock_reader from sherlock_bottleneck_writer",
  );
  await sql.unsafe(
    posture.report_update
      ? "grant update on product.bottleneck_reports to sherlock_bottleneck_writer"
      : "revoke update on product.bottleneck_reports from sherlock_bottleneck_writer",
  );
  await sql.unsafe(
    posture.candidate_title_update
      ? "grant update (title) on product.bottleneck_candidates to sherlock_bottleneck_writer"
      : "revoke update (title) on product.bottleneck_candidates from sherlock_bottleneck_writer",
  );
  const triggerAction = {
    A: "enable always",
    D: "disable",
    O: "enable",
    R: "enable replica",
  }[posture.report_immutable_enabled];
  await sql.unsafe(
    `alter table product.bottleneck_reports ${triggerAction} trigger bottleneck_reports_immutable`,
  );
}

describePostgres("bottleneck candidate PostgreSQL source", () => {
  it("rechecks a warmed gate against privilege, role, ACL, and trigger drift", async () => {
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const workerDatabaseUrl = await configureWorkerLogin(sql);
    const originalPosture = (await sql.unsafe(`
      select has_function_privilege(
               'sherlock_bottleneck_writer',
               'product.valid_bottleneck_evidence_refs(jsonb)', 'execute'
             ) as validator_execute,
             has_function_privilege(
               'public', 'product.valid_bottleneck_evidence_refs(jsonb)', 'execute'
             ) as validator_public_execute,
             has_function_privilege(
               'sherlock_bottleneck_writer',
               'product.valid_bottleneck_evidence_refs(jsonb)',
               'execute with grant option'
             ) as validator_writer_grant_option,
             has_schema_privilege(
               'sherlock_bottleneck_writer', 'product', 'create'
             ) as product_create,
             (select rolinherit from pg_roles
               where rolname = 'sherlock_bottleneck_writer') as writer_inherit,
             pg_has_role(
               'sherlock_bottleneck_writer', 'sherlock_reader', 'member'
             ) as reader_membership,
             has_table_privilege(
               'sherlock_bottleneck_writer',
               'product.bottleneck_reports', 'update'
             ) as report_update,
             has_column_privilege(
               'sherlock_bottleneck_writer',
               'product.bottleneck_candidates', 'title', 'update'
             ) as candidate_title_update,
             (select tgenabled from pg_trigger
               where tgrelid = 'product.bottleneck_reports'::regclass
                 and tgname = 'bottleneck_reports_immutable')
               as report_immutable_enabled
    `))[0];
    let source;
    let workerSql;
    let unexpectedFunction;
    let extraMember = false;
    let wrongLogin;
    let wrongSource;
    let extraTable;
    let extraSequence;
    let telemetryGrant = false;
    let originalRejectDefinition;
    let rejectFunctionChanged = false;
    let evidenceCheckDropped = false;
    let createdAtDefaultChanged = false;
    let candidateTitleNullable = false;
    let reportSequenceCycles = false;
    let candidatesUnlogged = false;
    try {
      source = new BottleneckSource({
        databaseUrl: workerDatabaseUrl,
        workspaceId: crypto.randomUUID(),
        cursorSecret: CURSOR_SECRET,
      });
      workerSql = postgres(workerDatabaseUrl, { max: 1, prepare: false });
      const gate = createBottleneckReadinessGate(source, {
        successTtlMs: 0,
        unavailableTtlMs: 0,
      });
      const ready = {
        status: "ok",
        mode: "sherlock_bottleneck_product",
      };
      const unavailable = {
        status: "unavailable",
        reason: "bottleneck_database_role_unsafe",
      };
      await expect(gate.readiness()).resolves.toEqual(ready);

      const insertBoundaryWorkspace = crypto.randomUUID();
      const insertBoundarySubmission = crypto.randomUUID();
      await sql.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)",
        [
          insertBoundaryWorkspace,
          `insert-boundary-${insertBoundaryWorkspace}`,
          "Insert boundary proof",
        ],
      );
      const insertBoundaryReport = (await sql.unsafe(`
        insert into product.bottleneck_reports (
          workspace_id, submission_id, request_sha256, scope_snapshot_token,
          scope_window_start, scope_window_end, scope_read_at,
          scope_completeness, candidate_count
        ) values ($1, $2, $3, 'snapshot', $4, $5, $6,
                  'agent_declared_complete', 0)
        returning id::text
      `, [
        insertBoundaryWorkspace, insertBoundarySubmission, "c".repeat(64),
        START, END, READ,
      ]))[0].id;
      const forbiddenInserts = [
        [`
          insert into product.bottleneck_reports (
            id, workspace_id, submission_id, request_sha256,
            scope_snapshot_token, scope_window_start, scope_window_end,
            scope_read_at, scope_completeness, candidate_count
          ) overriding system value values (
            9001, $1, $2, $3, 'snapshot', $4, $5, $6,
            'agent_declared_complete', 0
          )
        `, [
          insertBoundaryWorkspace, crypto.randomUUID(), "d".repeat(64),
          START, END, READ,
        ]],
        [`
          insert into product.bottleneck_reports (
            workspace_id, submission_id, request_sha256,
            scope_snapshot_token, scope_window_start, scope_window_end,
            scope_read_at, scope_completeness, candidate_count, created_at
          ) values (
            $1, $2, $3, 'snapshot', $4, $5, $6,
            'agent_declared_complete', 0, $6
          )
        `, [
          insertBoundaryWorkspace, crypto.randomUUID(), "e".repeat(64),
          START, END, READ,
        ]],
        [`
          insert into product.bottleneck_reports (
            workspace_id, submission_id, request_sha256,
            scope_snapshot_token, scope_window_start, scope_window_end,
            scope_read_at, scope_completeness, candidate_count,
            attribution_mode, trust
          ) values (
            $1, $2, $3, 'snapshot', $4, $5, $6,
            'agent_declared_complete', 0, default, default
          )
        `, [
          insertBoundaryWorkspace, crypto.randomUUID(), "f".repeat(64),
          START, END, READ,
        ]],
        [`
          insert into product.bottleneck_candidates (
            id, workspace_id, report_id, ordinal, candidate_key,
            title, claim, evidence_refs
          ) overriding system value values (
            9001, $1, $2, 0, 'forbidden-id', 'Forbidden', 'Forbidden', $3
          )
        `, [
          insertBoundaryWorkspace, insertBoundaryReport,
          JSON.stringify([{ type: "usage_summary", personId: insertBoundaryWorkspace }]),
        ]],
        [`
          insert into product.bottleneck_candidates (
            workspace_id, report_id, ordinal, candidate_key,
            title, claim, evidence_refs, created_at
          ) values (
            $1, $2, 0, 'forbidden-created-at', 'Forbidden', 'Forbidden', $3, $4
          )
        `, [
          insertBoundaryWorkspace, insertBoundaryReport,
          JSON.stringify([{ type: "usage_summary", personId: insertBoundaryWorkspace }]),
          READ,
        ]],
        [`
          insert into product.bottleneck_candidates (
            workspace_id, report_id, ordinal, candidate_key,
            title, claim, evidence_refs, attribution_mode, trust
          ) values (
            $1, $2, 0, 'forbidden-generated', 'Forbidden', 'Forbidden',
            $3, default, default
          )
        `, [
          insertBoundaryWorkspace, insertBoundaryReport,
          JSON.stringify([{ type: "usage_summary", personId: insertBoundaryWorkspace }]),
        ]],
      ];
      for (const [statement, params] of forbiddenInserts) {
        await expect(workerSql.begin(async (tx) => {
          await tx.unsafe("set local role sherlock_bottleneck_writer");
          await tx.unsafe(statement, params);
        })).rejects.toMatchObject({ code: "42501" });
      }

      await sql.unsafe(
        "grant sherlock_bottleneck_writer to sherlock_reader with inherit false, set true",
      );
      extraMember = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe("revoke sherlock_bottleneck_writer from sherlock_reader");
      extraMember = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      wrongLogin = `bottleneck_wrong_${crypto.randomUUID().replaceAll("-", "_")}`;
      const wrongPassword = `wrong-test-${crypto.randomUUID()}`;
      await sql.unsafe(
        `create role ${wrongLogin} login noinherit password '${wrongPassword}'`,
      );
      await sql.unsafe(
        `grant sherlock_bottleneck_writer to ${wrongLogin} with inherit false, set true`,
      );
      const wrongUrl = new URL(DATABASE_URL);
      wrongUrl.username = wrongLogin;
      wrongUrl.password = wrongPassword;
      wrongSource = new BottleneckSource({
        databaseUrl: wrongUrl.toString(),
        workspaceId: crypto.randomUUID(),
        cursorSecret: CURSOR_SECRET,
      });
      await expect(wrongSource.readiness()).resolves.toEqual(unavailable);
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await wrongSource.close();
      wrongSource = undefined;
      await sql.unsafe(`revoke sherlock_bottleneck_writer from ${wrongLogin}`);
      await sql.unsafe(`drop role ${wrongLogin}`);
      wrongLogin = undefined;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "revoke execute on function product.valid_bottleneck_evidence_refs(jsonb) from sherlock_bottleneck_writer",
      );
      try {
        await expect(gate.readiness()).resolves.toEqual(unavailable);
      } finally {
        await restoreProductPrivileges(sql, originalPosture);
      }
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant execute on function product.valid_bottleneck_evidence_refs(jsonb) to public",
      );
      try {
        await expect(gate.readiness()).resolves.toEqual(unavailable);
      } finally {
        await restoreProductPrivileges(sql, originalPosture);
      }
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant execute on function product.valid_bottleneck_evidence_refs(jsonb) to sherlock_bottleneck_writer with grant option",
      );
      try {
        await expect(gate.readiness()).resolves.toEqual(unavailable);
      } finally {
        await restoreProductPrivileges(sql, originalPosture);
      }
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe("grant create on schema product to sherlock_bottleneck_writer");
      try {
        await expect(gate.readiness()).resolves.toEqual(unavailable);
      } finally {
        await restoreProductPrivileges(sql, originalPosture);
      }
      await expect(gate.readiness()).resolves.toEqual(ready);

      unexpectedFunction = `product.bottleneck_readiness_test_${
        crypto.randomUUID().replaceAll("-", "_")
      }()`;
      await sql.unsafe(`create function ${unexpectedFunction}
        returns boolean language sql immutable as 'select true'`);
      await sql.unsafe(`revoke all on function ${unexpectedFunction} from public`);
      await expect(gate.readiness()).resolves.toEqual(ready);
      await sql.unsafe(
        `grant execute on function ${unexpectedFunction} to sherlock_bottleneck_writer`,
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(`revoke all on function ${unexpectedFunction} from sherlock_bottleneck_writer`);
      await expect(gate.readiness()).resolves.toEqual(ready);

      extraTable = `bottleneck_scope_test_${
        crypto.randomUUID().replaceAll("-", "_")
      }`;
      extraSequence = `${extraTable}_seq`;
      await sql.unsafe(`create table product.${extraTable} (id bigint)`);
      await sql.unsafe(`create sequence product.${extraSequence}`);
      await sql.unsafe(`revoke all on table product.${extraTable} from public`);
      await sql.unsafe(`revoke all on sequence product.${extraSequence} from public`);
      await expect(gate.readiness()).resolves.toEqual(ready);
      await sql.unsafe(
        `grant select on table product.${extraTable} to sherlock_bottleneck_writer`,
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(
        `revoke all on table product.${extraTable} from sherlock_bottleneck_writer`,
      );
      await expect(gate.readiness()).resolves.toEqual(ready);
      await sql.unsafe(
        `grant usage on sequence product.${extraSequence} to sherlock_bottleneck_writer`,
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(
        `revoke all on sequence product.${extraSequence} from sherlock_bottleneck_writer`,
      );
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant select on telemetry.events to sherlock_bottleneck_writer",
      );
      telemetryGrant = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(
        "revoke all on telemetry.events from sherlock_bottleneck_writer",
      );
      telemetryGrant = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      originalRejectDefinition = (await sql.unsafe(`
        select pg_get_functiondef(
          'product.reject_bottleneck_mutation()'::regprocedure
        ) as definition
      `))[0].definition;
      await sql.unsafe(`
        create or replace function product.reject_bottleneck_mutation()
        returns trigger
        language plpgsql
        volatile
        set search_path = pg_catalog
        as $$ begin return new; end $$
      `);
      rejectFunctionChanged = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(originalRejectDefinition);
      rejectFunctionChanged = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      const immutableWorkspace = crypto.randomUUID();
      const immutableSubmission = crypto.randomUUID();
      await sql.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)",
        [immutableWorkspace, `immutable-${immutableWorkspace}`, "Immutability proof"],
      );
      await sql.unsafe(`
        insert into product.bottleneck_reports (
          workspace_id, submission_id, request_sha256, scope_snapshot_token,
          scope_window_start, scope_window_end, scope_read_at,
          scope_completeness, candidate_count
        ) values ($1, $2, $3, 'snapshot', $4, $5, $6,
                  'agent_declared_complete', 0)
      `, [immutableWorkspace, immutableSubmission, "a".repeat(64), START, END, READ]);
      await expect(sql.unsafe(
        "update product.bottleneck_reports set candidate_count = 1 where submission_id = $1",
        [immutableSubmission],
      )).rejects.toMatchObject({ code: "55000" });

      await sql.unsafe(`
        alter table product.bottleneck_candidates
          drop constraint bottleneck_candidates_evidence_refs_check
      `);
      evidenceCheckDropped = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(`
        alter table product.bottleneck_candidates
          add constraint bottleneck_candidates_evidence_refs_check
          check (product.valid_bottleneck_evidence_refs(evidence_refs))
      `);
      evidenceCheckDropped = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(`
        alter table product.bottleneck_reports
          alter column created_at set default statement_timestamp()
      `);
      createdAtDefaultChanged = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(`
        alter table product.bottleneck_reports
          alter column created_at set default transaction_timestamp()
      `);
      createdAtDefaultChanged = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(`
        alter table product.bottleneck_candidates
          alter column title drop not null
      `);
      candidateTitleNullable = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe(`
        alter table product.bottleneck_candidates
          alter column title set not null
      `);
      candidateTitleNullable = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe("alter sequence product.bottleneck_reports_id_seq cycle");
      reportSequenceCycles = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe("alter sequence product.bottleneck_reports_id_seq no cycle");
      reportSequenceCycles = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe("alter table product.bottleneck_candidates set unlogged");
      candidatesUnlogged = true;
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await sql.unsafe("alter table product.bottleneck_candidates set logged");
      candidatesUnlogged = false;
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe("alter role sherlock_bottleneck_writer inherit");
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await restoreProductPrivileges(sql, originalPosture);
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant sherlock_reader to sherlock_bottleneck_writer with inherit false, set true",
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await restoreProductPrivileges(sql, originalPosture);
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant update on product.bottleneck_reports to sherlock_bottleneck_writer",
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await restoreProductPrivileges(sql, originalPosture);
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "grant update (title) on product.bottleneck_candidates to sherlock_bottleneck_writer",
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await restoreProductPrivileges(sql, originalPosture);
      await expect(gate.readiness()).resolves.toEqual(ready);

      await sql.unsafe(
        "alter table product.bottleneck_reports disable trigger bottleneck_reports_immutable",
      );
      await expect(gate.readiness()).resolves.toEqual(unavailable);
      await restoreProductPrivileges(sql, originalPosture);
      await expect(gate.readiness()).resolves.toEqual(ready);
    } finally {
      await workerSql?.end({ timeout: 5 });
      await wrongSource?.close();
      if (wrongLogin) {
        await sql.unsafe(`revoke sherlock_bottleneck_writer from ${wrongLogin}`);
        await sql.unsafe(`drop role if exists ${wrongLogin}`);
      }
      if (extraMember) {
        await sql.unsafe("revoke sherlock_bottleneck_writer from sherlock_reader");
      }
      if (telemetryGrant) {
        await sql.unsafe(
          "revoke all on telemetry.events from sherlock_bottleneck_writer",
        );
      }
      if (rejectFunctionChanged && originalRejectDefinition) {
        await sql.unsafe(originalRejectDefinition);
      }
      if (evidenceCheckDropped) {
        await sql.unsafe(`
          alter table product.bottleneck_candidates
            add constraint bottleneck_candidates_evidence_refs_check
            check (product.valid_bottleneck_evidence_refs(evidence_refs))
        `);
      }
      if (createdAtDefaultChanged) {
        await sql.unsafe(`
          alter table product.bottleneck_reports
            alter column created_at set default transaction_timestamp()
        `);
      }
      if (candidateTitleNullable) {
        await sql.unsafe(`
          alter table product.bottleneck_candidates
            alter column title set not null
        `);
      }
      if (reportSequenceCycles) {
        await sql.unsafe("alter sequence product.bottleneck_reports_id_seq no cycle");
      }
      if (candidatesUnlogged) {
        await sql.unsafe("alter table product.bottleneck_candidates set logged");
      }
      if (extraTable) {
        await sql.unsafe(`drop table if exists product.${extraTable}`);
      }
      if (extraSequence) {
        await sql.unsafe(`drop sequence if exists product.${extraSequence}`);
      }
      if (unexpectedFunction) {
        await sql.unsafe(`drop function if exists ${unexpectedFunction}`);
      }
      await restoreProductPrivileges(sql, originalPosture);
      await source?.close();
      await clearWorkerLogin(sql);
      await sql.end({ timeout: 5 });
    }
  });

  it("proves atomic complete batches, idempotency races, and fixed high-water paging", async () => {
    const workspaceId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const workerDatabaseUrl = await configureWorkerLogin(sql);
    let source;
    try {
      source = new BottleneckSource({
        databaseUrl: workerDatabaseUrl,
        workspaceId,
        cursorSecret: CURSOR_SECRET,
      });
      await sql.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)",
        [workspaceId, `bottleneck-${workspaceId}`, "Bottleneck integration"],
      );
      await expect(source.readiness()).resolves.toEqual({
        status: "ok",
        mode: "sherlock_bottleneck_product",
      });

      const emptyRequest = batch(crypto.randomUUID(), 0);
      const emptyReceipt = await source.submitCandidateBatch(emptyRequest);
      expect(emptyReceipt).toMatchObject({
        candidateCount: 0,
        attributionMode: "workspace_shared_bearer",
        trust: "untrusted_agent_generated_claim",
      });
      await expect(source.submitCandidateBatch(structuredClone(emptyRequest)))
        .resolves.toEqual(emptyReceipt);
      const changed = structuredClone(emptyRequest);
      changed.analysisScope.usageSnapshotToken = "different";
      await expect(source.submitCandidateBatch(changed))
        .rejects.toMatchObject({ code: "idempotency_conflict" });

      const acceptedSubmissionIds = [
        "018f22e2-79b0-7cc3-98c4-dc0c0c07398f",
        "018f22e2-79b0-8cc3-98c4-dc0c0c07398f",
        "00000000-0000-0000-0000-000000000000",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ];
      for (const [index, submissionId] of acceptedSubmissionIds.entries()) {
        const acceptedRequest = batch(
          index === 0 ? submissionId.toUpperCase() : submissionId,
          1,
          `accepted-${index}`,
        );
        acceptedRequest.candidates[0].evidence = [{
          type: "usage_summary",
          personId: index === 0 ? submissionId.toUpperCase() : submissionId,
        }];
        if (index === 0) {
          acceptedRequest.analysisScope.usageSnapshotToken = "snapshot\u0001persisted-🕵️";
          acceptedRequest.candidates[0].title = "title\u0001persisted-🕵️";
          acceptedRequest.candidates[0].claim = "claim\u0001persisted-🕵️";
        }
        const acceptedReceipt = await source.submitCandidateBatch(acceptedRequest);
        expect(acceptedReceipt).toMatchObject({
          submissionId,
          candidateCount: 1,
        });
        if (index === 0) {
          const lowercaseRetry = structuredClone(acceptedRequest);
          lowercaseRetry.submissionId = submissionId;
          await expect(source.submitCandidateBatch(lowercaseRetry))
            .resolves.toEqual(acceptedReceipt);
          const changedRetry = structuredClone(lowercaseRetry);
          changedRetry.candidates[0].claim += " changed";
          await expect(source.submitCandidateBatch(changedRetry))
            .rejects.toMatchObject({ code: "idempotency_conflict" });
        }
        const listed = await source.listBottleneckCandidates({ submissionId });
        expect(listed.candidates).toHaveLength(1);
        expect(listed.candidates[0].submissionId).toBe(submissionId);
        expect(listed.candidates[0].evidence).toEqual([{
          type: "usage_summary",
          personId: index === 0 ? submissionId.toUpperCase() : submissionId,
        }]);
        if (index === 0) {
          expect(listed.candidates[0]).toMatchObject({
            title: "title\u0001persisted-🕵️",
            claim: "claim\u0001persisted-🕵️",
            analysisScope: { usageSnapshotToken: "snapshot\u0001persisted-🕵️" },
          });
        }
      }

      const raceId = crypto.randomUUID();
      const race = await Promise.allSettled([
        source.submitCandidateBatch(batch(raceId, 1, "left")),
        source.submitCandidateBatch(batch(raceId, 1, "right")),
      ]);
      expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((result) =>
        result.status === "rejected" &&
        result.reason instanceof BottleneckSourceError &&
        result.reason.code === "idempotency_conflict"
      )).toHaveLength(1);

      const sameRaceRequest = batch(crypto.randomUUID(), 1, "same");
      const sameRace = await Promise.all([
        source.submitCandidateBatch(structuredClone(sameRaceRequest)),
        source.submitCandidateBatch(structuredClone(sameRaceRequest)),
      ]);
      expect(sameRace[0]).toEqual(sameRace[1]);

      await expect(source.submitCandidateBatch(batch(crypto.randomUUID(), 50)))
        .resolves.toMatchObject({ candidateCount: 50 });
      const oversizedId = crypto.randomUUID();
      await expect(source.submitCandidateBatch(batch(oversizedId, 51)))
        .rejects.toMatchObject({ code: "database_unavailable" });
      const oversizedRows = await sql.unsafe(
        "select count(*)::int count from product.bottleneck_reports where workspace_id = $1 and submission_id = $2",
        [workspaceId, oversizedId],
      );
      expect(oversizedRows[0].count).toBe(0);

      const pagingWorkspaceId = crypto.randomUUID();
      await sql.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)",
        [pagingWorkspaceId, `bottleneck-${pagingWorkspaceId}`, "Paging integration"],
      );
      const pagingSource = new BottleneckSource({
        databaseUrl: workerDatabaseUrl,
        workspaceId: pagingWorkspaceId,
        cursorSecret: CURSOR_SECRET,
      });
      try {
        await pagingSource.submitCandidateBatch(batch(crypto.randomUUID(), 3, "history"));
        const initialSubmissionId = crypto.randomUUID();
        await pagingSource.submitCandidateBatch(batch(initialSubmissionId, 50));
        const first = await pagingSource.listBottleneckCandidates({});
        expect(first.candidates).toHaveLength(20);
        expect(first.nextCursor).toBeTypeOf("string");
        const filteredFirst = await pagingSource.listBottleneckCandidates({
          submissionId: initialSubmissionId,
        });
        expect(filteredFirst.candidates).toHaveLength(20);
        expect(filteredFirst.nextCursor).toBeTypeOf("string");
        expect(filteredFirst.candidates.every(
          (candidate) => candidate.submissionId === initialSubmissionId
        )).toBe(true);
        const laterSubmissionId = crypto.randomUUID();
        await pagingSource.submitCandidateBatch(batch(laterSubmissionId, 1, "later"));
        const second = await pagingSource.listBottleneckCandidates({
          cursor: first.nextCursor,
        });
        expect(second.candidates).toHaveLength(20);
        expect(second.candidates[0].evidence).toEqual([{
          type: "usage_summary",
          personId: "11111111-1111-4111-8111-111111111111",
        }]);
        expect(second.nextCursor).toBeTypeOf("string");
        const fresh = await pagingSource.listBottleneckCandidates({});
        expect(BigInt(fresh.candidates[0].candidateId)).toBeGreaterThan(0n);

        const filteredSecond = await pagingSource.listBottleneckCandidates({
          submissionId: initialSubmissionId,
          cursor: filteredFirst.nextCursor,
        });
        expect(filteredSecond.candidates).toHaveLength(20);
        expect(filteredSecond.nextCursor).toBeTypeOf("string");
        const filteredThird = await pagingSource.listBottleneckCandidates({
          submissionId: initialSubmissionId,
          cursor: filteredSecond.nextCursor,
        });
        expect(filteredThird.candidates).toHaveLength(10);
        expect(filteredThird.nextCursor).toBeNull();
        const filteredCandidates = [
          ...filteredFirst.candidates,
          ...filteredSecond.candidates,
          ...filteredThird.candidates,
        ];
        expect(filteredCandidates).toHaveLength(50);
        expect(filteredCandidates.every(
          (candidate) => candidate.submissionId === initialSubmissionId
        )).toBe(true);
        expect(filteredCandidates.map((candidate) => candidate.candidateKey)).toEqual(
          Array.from({ length: 50 }, (_, index) =>
            `candidate-${String(index).padStart(2, "0")}`
          ),
        );
        await expect(pagingSource.listBottleneckCandidates({
          submissionId: laterSubmissionId,
          cursor: filteredFirst.nextCursor,
        })).rejects.toMatchObject({ code: "cursor_invalid" });
      } finally {
        await pagingSource.close();
      }
    } finally {
      await source?.close();
      await clearWorkerLogin(sql);
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("takes a fresh high-water snapshot after a blocked writer commits", async () => {
    const workspaceId = crypto.randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const writerSql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const observerSql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const workerDatabaseUrl = await configureWorkerLogin(sql);
    const source = new BottleneckSource({
      databaseUrl: workerDatabaseUrl,
      workspaceId,
      cursorSecret: CURSOR_SECRET,
    });
    let releaseWriter;
    const writerBarrier = new Promise((resolve) => {
      releaseWriter = resolve;
    });
    let announceInsert;
    let rejectInsert;
    let writerPromise;
    const writerInserted = new Promise((resolve, reject) => {
      announceInsert = resolve;
      rejectInsert = reject;
    });
    try {
      await sql.unsafe(
        "insert into telemetry.workspaces (id, slug, name) values ($1, $2, $3)",
        [workspaceId, `locked-list-${workspaceId}`, "Locked list integration"],
      );
      await source.submitCandidateBatch(batch(crypto.randomUUID(), 20, "before lock"));

      const submissionId = crypto.randomUUID();
      writerPromise = writerSql.begin(async (tx) => {
        try {
          await tx.unsafe(
            "select pg_advisory_xact_lock(hashtextextended($1, 730241))",
            [workspaceId],
          );
          const report = (await tx.unsafe(`
            insert into product.bottleneck_reports (
              workspace_id, submission_id, request_sha256, scope_snapshot_token,
              scope_window_start, scope_window_end, scope_read_at,
              scope_completeness, candidate_count
            ) values ($1, $2, $3, 'v2.locked-snapshot', $4, $5, $6,
                      'agent_declared_complete', 1)
            returning id::text
          `, [workspaceId, submissionId, "9".repeat(64), START, END, READ]))[0];
          await tx.unsafe(`
            insert into product.bottleneck_candidates (
              workspace_id, report_id, ordinal, candidate_key, title, claim,
              evidence_refs
            ) values ($1, $2, 0, 'committed-after-lock', 'Committed after lock',
                      'The fresh traversal must include this committed row.', $3::jsonb)
          `, [
            workspaceId,
            report.id,
            tx.json([{
              type: "usage_summary",
              personId: "11111111-1111-4111-8111-111111111111",
            }]),
          ]);
          announceInsert();
          await writerBarrier;
        } catch (error) {
          rejectInsert(error);
          throw error;
        }
      });
      await writerInserted;

      let listingSettled = false;
      const listing = source.listBottleneckCandidates({}).finally(() => {
        listingSettled = true;
      });
      await vi.waitFor(async () => {
        const lockWait = (await observerSql.unsafe(`
          select exists (
            select 1 from pg_stat_activity
             where usename = 'sherlock_worker_login'
               and wait_event_type = 'Lock'
               and wait_event = 'advisory'
               and query like '%pg_advisory_xact_lock%'
          ) as blocked
        `))[0];
        expect(lockWait.blocked).toBe(true);
      }, { timeout: 5_000, interval: 10 });
      expect(listingSettled).toBe(false);

      releaseWriter();
      await writerPromise;
      const first = await listing;
      expect(first.candidates).toHaveLength(20);
      expect(first.nextCursor).toBeTypeOf("string");
      const second = await source.listBottleneckCandidates({
        cursor: first.nextCursor,
      });
      expect(second.nextCursor).toBeNull();
      expect(second.candidates).toHaveLength(1);
      expect(second.candidates[0]).toMatchObject({
        candidateKey: "committed-after-lock",
        submissionId,
        analysisScope: {
          usageSnapshotToken: "v2.locked-snapshot",
          completeness: "agent_declared_complete",
        },
      });
    } finally {
      releaseWriter();
      await writerPromise?.catch(() => {});
      await source.close();
      await clearWorkerLogin(sql);
      await Promise.all([
        sql.end({ timeout: 5 }),
        writerSql.end({ timeout: 5 }),
        observerSql.end({ timeout: 5 }),
      ]);
    }
  }, 30_000);
});
