import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const MIGRATION = readFileSync(new FileURL(
  "../../../../supabase/migrations/20261012065436_bound_protected_record_lookup.sql",
  import.meta.url,
), "utf8");
const SHA = "0".repeat(64);
const FUNCTION = "sherlock_access.protected_record_ids()";

// The production body before this migration, with its original formatting
// style (multi-line, trailing semicolon) to exercise the guard normalization.
const ORIGINAL_BODY = `
  select n.id
  from sherlock_access.restricted_people r
  join telemetry.ingest_batches b
    on b.workspace_id = r.workspace_id and b.person_id = r.person_id
  join telemetry.native_records n
    on n.workspace_id = b.workspace_id and n.batch_id = b.id;
`;

class Rollback extends Error {}

// Every synthetic schema, role, and row lives in a transaction that is always
// rolled back, so shared telemetry and concurrent suites never observe them.
async function inRollback(sql, work) {
  let result;
  await sql.begin(async (tx) => {
    result = await work(tx);
    throw new Rollback();
  }).catch((error) => {
    if (!(error instanceof Rollback)) throw error;
  });
  return result;
}

// Runs work in a savepoint that is always rolled back, returning its result or error.
async function inSavepoint(tx, work) {
  let outcome;
  await tx.savepoint(async (sp) => {
    try {
      outcome = { value: await work(sp) };
    } catch (error) {
      outcome = { error };
    }
    throw new Rollback();
  }).catch((error) => {
    if (!(error instanceof Rollback)) throw error;
  });
  return outcome;
}

async function installProductionShape(tx, body = ORIGINAL_BODY) {
  const [{ absent }] = await tx`select to_regnamespace('sherlock_access') is null as absent`;
  expect(absent).toBe(true);
  await tx.unsafe(`
    create schema sherlock_access;
    create table sherlock_access.restricted_people (workspace_id uuid not null, person_id uuid not null);
    create index on sherlock_access.restricted_people (workspace_id, person_id);
    create function ${FUNCTION} returns setof bigint
      language sql stable security definer set search_path = ''
      as $body$${body}$body$;
    revoke all on function ${FUNCTION} from public;
    comment on function ${FUNCTION} is 'synthetic protected record lookup';
  `);
}

async function catalogRow(tx) {
  const [row] = await tx`
    select to_jsonb(p) - 'prosrc' as meta, p.prosrc, p.xmin::text as xmin,
      obj_description(p.oid, 'pg_proc') as comment
    from pg_proc p
    where p.oid = ${FUNCTION}::regprocedure`;
  return row;
}

async function seedBatches(tx, workspaceId, personId, recordCounts) {
  const recordIds = [];
  for (const [index, count] of recordCounts.entries()) {
    const [batch] = await tx`
      insert into telemetry.ingest_batches (
        workspace_id, person_id, collector_key, source_kind, source_stream_key,
        generation_key, generation_seq, start_offset, end_offset, source_byte_count,
        source_sha256, storage_path, storage_encoding, stored_byte_count,
        stored_sha256, record_count, contract_version
      ) values (
        ${workspaceId}, ${personId}, 'protected-lookup', 'rollout', ${`${personId}-${index}`},
        'generation', 0, 0, 1, 1, ${SHA}, ${`protected-lookup/${randomUUID()}`},
        'identity', 1, ${SHA}, 1, 'test'
      ) returning id`;
    const rows = await tx`
      insert into telemetry.native_records (
        workspace_id, batch_id, record_index, source_start_offset,
        source_end_offset, record_sha256, parse_status
      )
      select ${workspaceId}, ${batch.id}, r, r, r + 1, ${SHA}, 'ok'
      from generate_series(0, ${count - 1}::integer) r
      returning id`;
    recordIds.push(...rows.map((row) => row.id));
  }
  return recordIds;
}

async function seedTelemetry(tx) {
  const home = randomUUID();
  const foreign = randomUUID();
  const restricted = randomUUID();
  const ordinary = randomUUID();
  const foreigner = randomUUID();
  await tx`
    insert into telemetry.workspaces (id, slug, name)
    values (${home}, ${`protected-lookup-${home}`}, 'Protected lookup home'),
      (${foreign}, ${`protected-lookup-${foreign}`}, 'Protected lookup foreign')`;
  await tx`
    insert into telemetry.people (id, workspace_id, identity_key)
    values (${restricted}, ${home}, 'restricted'), (${ordinary}, ${home}, 'ordinary'),
      (${foreigner}, ${foreign}, 'foreigner')`;
  return {
    home,
    foreign,
    restricted,
    // The zero-record batch has a batch row but contributes no records.
    protectedIds: await seedBatches(tx, home, restricted, [3, 2, 0]),
    ordinaryIds: await seedBatches(tx, home, ordinary, [4]),
    foreignIds: await seedBatches(tx, foreign, foreigner, [2]),
  };
}

const sortIds = (ids) => ids.map(String).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
const lookup = async (tx) => sortIds((await tx`select id from sherlock_access.protected_record_ids() id`).map((row) => row.id));
const originalLookup = async (tx) => sortIds((await tx.unsafe(ORIGINAL_BODY)).map((row) => row.id));

function planNodes(value, nodes = []) {
  if (Array.isArray(value)) {
    for (const item of value) planNodes(item, nodes);
  } else if (value && typeof value === "object") {
    if (typeof value["Node Type"] === "string") nodes.push(value);
    for (const child of Object.values(value)) planNodes(child, nodes);
  }
  return nodes;
}

describePostgres("protected record lookup migration", { timeout: 120_000 }, () => {
  let sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("leaves an absent optional schema absent", async () => {
    const after = await inRollback(sql, async (tx) => {
      await tx.unsafe(MIGRATION);
      const [row] = await tx`
        select to_regnamespace('sherlock_access') as schema,
          to_regprocedure(${FUNCTION}) as fn`;
      return row;
    });
    expect(after).toEqual({ schema: null, fn: null });
  });

  it("returns the original multiset and preserves catalog metadata", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      const fixture = await seedTelemetry(tx);
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        values (${fixture.home}, ${fixture.restricted}), (${fixture.home}, ${fixture.restricted}),
          (${fixture.foreign}, ${fixture.restricted})`;
      const expected = sortIds([...fixture.protectedIds, ...fixture.protectedIds]);
      expect(await originalLookup(tx)).toEqual(expected);
      const before = await catalogRow(tx);

      await tx.unsafe(MIGRATION);
      const after = await catalogRow(tx);
      expect(after.prosrc).toMatch(/offset 0[\s\S]*offset 0/);
      expect(after.meta).toEqual(before.meta);
      expect(after.comment).toBe(before.comment);
      // Duplicate restrictions keep duplicate ids; ordinary, foreign-workspace,
      // and same-person-UUID-in-foreign-workspace records stay excluded.
      expect(await lookup(tx)).toEqual(await originalLookup(tx));
      expect(await lookup(tx)).toEqual(expected);

      await tx`delete from sherlock_access.restricted_people`;
      expect(await lookup(tx)).toEqual([]);
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        select workspace_id, person_id from telemetry.ingest_batches
        where workspace_id = ${fixture.foreign}`;
      expect(await lookup(tx)).toEqual(sortIds(fixture.foreignIds));
      expect(await lookup(tx)).toEqual(await originalLookup(tx));

      await tx.unsafe(MIGRATION);
      expect(await catalogRow(tx)).toEqual(after);
    });
  });

  it("treats an already bounded body as a no-op", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(MIGRATION);
      const bounded = (await catalogRow(tx)).prosrc;
      await tx.unsafe(`drop schema sherlock_access cascade`);

      await installProductionShape(tx, `\n${bounded.replace(/\s+/g, "  ")};\n`);
      const before = await catalogRow(tx);
      await tx.unsafe(MIGRATION);
      expect(await catalogRow(tx)).toEqual(before);
    });
  });

  it("keeps definer access limited to granted callers", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      const fixture = await seedTelemetry(tx);
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        values (${fixture.home}, ${fixture.restricted})`;
      await tx.unsafe(MIGRATION);

      const suffix = randomUUID().replaceAll("-", "");
      const reader = `protected_lookup_reader_${suffix}`;
      const outsider = `protected_lookup_outsider_${suffix}`;
      await tx.unsafe(`
        create role ${reader} nologin;
        create role ${outsider} nologin;
        grant ${reader}, ${outsider} to current_user;
        grant usage on schema sherlock_access to ${reader}, ${outsider};
        grant execute on function ${FUNCTION} to ${reader};
      `);
      const asRole = (role, query) => inSavepoint(tx, async (sp) => {
        await sp.unsafe(`set local role ${role}`);
        return sp.unsafe(query);
      });

      const granted = await asRole(reader, "select id from sherlock_access.protected_record_ids() id");
      expect(granted.error).toBeUndefined();
      expect(sortIds(granted.value.map((row) => row.id))).toEqual(sortIds(fixture.protectedIds));
      expect((await asRole(reader, "select id from telemetry.native_records limit 1")).error?.code).toBe("42501");
      expect((await asRole(reader, "select * from sherlock_access.restricted_people")).error?.code).toBe("42501");
      expect((await asRole(outsider, "select id from sherlock_access.protected_record_ids() id")).error?.code).toBe("42501");
    });
  });

  it("replaces only the qualified helper under a misleading migration search path", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      const before = await catalogRow(tx);
      await tx.unsafe("set local search_path = public, sherlock_access");
      expect((await tx`select to_regprocedure('public.protected_record_ids()') as fn`)[0].fn).toBeNull();
      await tx.unsafe(MIGRATION);
      const after = await catalogRow(tx);
      expect(after.prosrc).toMatch(/offset 0[\s\S]*offset 0/);
      expect(after.meta).toEqual(before.meta);
      expect((await tx`select to_regprocedure('public.protected_record_ids()') as fn`)[0].fn).toBeNull();
    });
  });

  it("preserves public and private RLS visibility without exposing source tables", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      const fixture = await seedTelemetry(tx);
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        values (${fixture.home}, ${fixture.restricted})`;
      const suffix = randomUUID().replaceAll("-", "");
      const publicReader = `protected_lookup_public_${suffix}`;
      const privateReader = `protected_lookup_private_${suffix}`;
      await tx.unsafe(`
        create role ${publicReader} nologin;
        create role ${privateReader} nologin;
        grant ${publicReader}, ${privateReader} to current_user;
        grant usage on schema sherlock_access to ${publicReader}, ${privateReader};
        grant execute on function ${FUNCTION} to ${publicReader}, ${privateReader};
        create table sherlock_access.visibility_fixture (source_record_id bigint primary key);
        alter table sherlock_access.visibility_fixture enable row level security;
        grant select on sherlock_access.visibility_fixture to ${publicReader}, ${privateReader};
        create policy public_records on sherlock_access.visibility_fixture to ${publicReader}
          using (source_record_id not in (select sherlock_access.protected_record_ids()));
        create policy private_records on sherlock_access.visibility_fixture to ${privateReader}
          using (source_record_id in (select sherlock_access.protected_record_ids()));
      `);
      await tx`
        insert into sherlock_access.visibility_fixture
        select unnest(${tx.array([...fixture.protectedIds, ...fixture.ordinaryIds, ...fixture.foreignIds])}::bigint[])`;
      const visible = async (role) => {
        const result = await inSavepoint(tx, async (sp) => {
          await sp.unsafe(`set local role ${role}`);
          // A hostile caller search path cannot redirect the qualified definer body.
          await sp.unsafe("set local search_path = pg_temp");
          return sp.unsafe("select source_record_id from sherlock_access.visibility_fixture");
        });
        expect(result.error).toBeUndefined();
        return sortIds(result.value.map((row) => row.source_record_id));
      };
      const before = { public: await visible(publicReader), private: await visible(privateReader) };
      expect(before.public).toEqual(sortIds([...fixture.ordinaryIds, ...fixture.foreignIds]));
      expect(before.private).toEqual(sortIds(fixture.protectedIds));
      const policies = await tx`select policyname, qual from pg_policies
        where schemaname = 'sherlock_access' and tablename = 'visibility_fixture' order by policyname`;
      await tx.unsafe(MIGRATION);
      expect(await visible(publicReader)).toEqual(before.public);
      expect(await visible(privateReader)).toEqual(before.private);
      expect(await tx`select policyname, qual from pg_policies
        where schemaname = 'sherlock_access' and tablename = 'visibility_fixture' order by policyname`).toEqual(policies);
    });
  });

  it.each([
    ["a changed body", `create or replace function ${FUNCTION} returns setof bigint language sql stable security definer set search_path = '' as $body$${ORIGINAL_BODY.replace(";", " and n.record_index = 0;")}$body$`],
    ["security invoker", `alter function ${FUNCTION} security invoker`],
    ["a mutable search path", `alter function ${FUNCTION} set search_path = public`],
    ["a missing search path", `alter function ${FUNCTION} reset search_path`],
    ["an extra function setting", `alter function ${FUNCTION} set work_mem = '64MB'`],
    ["volatile", `alter function ${FUNCTION} volatile`],
    ["strict", `alter function ${FUNCTION} strict`],
    ["a changed cost", `alter function ${FUNCTION} cost 200`],
    ["a changed row estimate", `alter function ${FUNCTION} rows 2000`],
    ["parallel safe", `alter function ${FUNCTION} parallel safe`],
  ])("fails closed on %s", async (_label, change) => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(change);
      const before = await catalogRow(tx);
      const outcome = await inSavepoint(tx, (sp) => sp.unsafe(MIGRATION));
      expect(outcome.error?.message).toMatch(/protected_record_ids/);
      expect(await catalogRow(tx)).toEqual(before);
    });
  });

  it("bounds record probes to protected batches under skewed statistics", async () => {
    // Shared telemetry statistics belong to other suites, so the plan regression
    // runs the function's current body against analyzed same-shape copies.
    const nodes = await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(MIGRATION);
      const { prosrc } = await catalogRow(tx);
      const home = randomUUID();
      const restricted = randomUUID();
      const decoySeed = randomUUID();
      await tx.unsafe(`
        create schema protected_lookup_plan;
        create table protected_lookup_plan.ingest_batches (like telemetry.ingest_batches including all);
        create table protected_lookup_plan.native_records (like telemetry.native_records including all);
      `);
      // 100 decoy people own 1,000 batches x 100 records; the protected person
      // has 3 batches x 5 records and one batch with no records.
      await tx`
        insert into protected_lookup_plan.ingest_batches (
          workspace_id, person_id, collector_key, source_kind, source_stream_key,
          generation_key, generation_seq, start_offset, end_offset, source_byte_count,
          source_sha256, storage_path, storage_encoding, stored_byte_count,
          stored_sha256, record_count, contract_version
        )
        select ${home}, case when g <= 4 then ${restricted}::uuid else md5(${decoySeed}::text || g % 100)::uuid end,
          'protected-lookup', 'rollout', 'stream-' || g, 'generation', 0, 0, 1, 1, ${SHA},
          'protected-lookup-plan/' || g, 'identity', 1, ${SHA}, 1, 'test'
        from generate_series(1, 1004) g`;
      await tx`
        insert into protected_lookup_plan.native_records (
          workspace_id, batch_id, record_index, source_start_offset,
          source_end_offset, record_sha256, parse_status
        )
        select b.workspace_id, b.id, r, r, r + 1, ${SHA}, 'ok'
        from protected_lookup_plan.ingest_batches b
        cross join lateral generate_series(0, case
          when b.source_stream_key = 'stream-4' then -1
          when b.person_id = ${restricted} then 4
          else 99 end) r`;
      // Most restricted people have no telemetry, which skews the join estimate
      // toward every batch and tempts the planner into a full record scan.
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        values (${home}, ${restricted}), (${randomUUID()}, ${restricted})`;
      await tx`
        insert into sherlock_access.restricted_people (workspace_id, person_id)
        select ${home}, gen_random_uuid() from generate_series(1, 198)`;
      await tx.unsafe(`
        analyze protected_lookup_plan.ingest_batches;
        analyze protected_lookup_plan.native_records;
        analyze sherlock_access.restricted_people;
      `);
      const [{ "QUERY PLAN": originalPlan }] = await tx.unsafe(
        `explain (analyze, format json) ${ORIGINAL_BODY.replaceAll("telemetry.", "protected_lookup_plan.").replace(/;\s*$/, "")}`,
      );
      expect(originalPlan[0].Plan["Actual Rows"]).toBe(15);
      expect(planNodes(originalPlan).some((node) =>
        node["Relation Name"] === "native_records" && node["Node Type"] === "Seq Scan"
      )).toBe(true);
      const [{ "QUERY PLAN": plan }] = await tx.unsafe(
        `explain (analyze, format json) ${prosrc.replaceAll("telemetry.", "protected_lookup_plan.").replace(/;\s*$/, "")}`,
      );
      expect(plan[0].Plan["Actual Rows"]).toBe(15);
      return planNodes(plan);
    });

    // Actual Rows is a rounded per-loop average, so bound probes by loop count:
    // one record probe per protected batch, never a scan of decoy records.
    const scans = (relation) => nodes.filter((node) => node["Relation Name"] === relation);
    const records = scans("native_records");
    expect(records.length).toBeGreaterThan(0);
    expect(records.map((node) => node["Node Type"])).not.toContain("Seq Scan");
    expect(records.reduce((total, node) => total + node["Actual Loops"], 0)).toBeLessThanOrEqual(4);
    expect(scans("ingest_batches").map((node) => node["Node Type"])).not.toContain("Seq Scan");
  });
});
