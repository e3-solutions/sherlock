import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// COR-5002: owner-excluded sessions are hidden from every reader surface that
// already hides restricted people. Everything runs on the synthetic production
// privacy shape inside a transaction that is always rolled back.
const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const migration = (name) => DATABASE_URL
  ? readFileSync(new FileURL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8")
  : null;
const SEARCH_MIGRATION = migration("20261012135923_add_bounded_excerpt_search.sql");
const PRODUCT_ROLE_MIGRATION = migration("20261012140548_filter_excerpt_search_product_roles.sql");
const EXCLUSIONS_MIGRATION = migration("20261027233920_hide_owner_excluded_sessions.sql");
const SEARCH = "analytics.search_excerpt_candidates(uuid, text, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer)";
const GATE = "analytics._assert_excerpt_search_policy_shape()";
const RECORD = "sherlock_access.record_owner_session_exclusions(uuid, uuid, text[])";
const RPC = "sherlock_access.excluded_native_session_ids(timestamptz)";
const PUBLIC_RPC = "public.sherlock_excluded_native_session_ids(timestamptz)";
const READER = "sherlock_reader";
const SESH = "sesh_sherlock_reader";
const SHA = "0".repeat(64);
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-01T12:00:00.000Z";
const READ_AT = "2026-01-02T00:00:00.000Z";

// The production helpers and reader policies before COR-5002 (same as
// mcp-search.postgres.test.js).
const HELPERS = {
  private_principal: ["boolean", `
 select session_user='sherlock_aqil_private_login'
 and pg_has_role(session_user,'sherlock_reader','member')
`],
  protected_record_ids: ["setof bigint", `
 select n.id from sherlock_access.restricted_people r
 join telemetry.ingest_batches b on b.workspace_id=r.workspace_id and b.person_id=r.person_id
 join telemetry.native_records n on n.workspace_id=b.workspace_id and n.batch_id=b.id
`],
  private_session_ids: ["setof uuid", `
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 where s.parent_session_id is null or exists(
 select 1 from telemetry.sessions parent
 join sherlock_access.restricted_people pr on pr.workspace_id=parent.workspace_id and pr.person_id=parent.person_id
 where parent.workspace_id=s.workspace_id and parent.id=s.parent_session_id)
`],
  hidden_session_ids: ["setof uuid", `
 select s.id from telemetry.sessions s
 join sherlock_access.restricted_people r on r.workspace_id=s.workspace_id and r.person_id=s.person_id
 union
 select child.id from telemetry.sessions parent
 join sherlock_access.restricted_people r on r.workspace_id=parent.workspace_id and r.person_id=parent.person_id
 join telemetry.sessions child on child.workspace_id=parent.workspace_id and child.parent_session_id=parent.id
`],
  protected_person_ids: ["setof uuid", `
 select person_id from sherlock_access.restricted_people
`],
};
const POLICIES = {
  events: `
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN ((source_record_id IN ( SELECT sherlock_access.protected_record_ids() AS protected_record_ids)) AND ((session_id IS NULL) OR (session_id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))) AND ((related_session_id IS NULL) OR (related_session_id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))))
    ELSE ((NOT (source_record_id IN ( SELECT sherlock_access.protected_record_ids() AS protected_record_ids))) AND ((session_id IS NULL) OR (NOT (session_id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))) AND ((related_session_id IS NULL) OR (NOT (related_session_id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))))
END`,
  sessions: `
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN (id IN ( SELECT sherlock_access.private_session_ids() AS private_session_ids))
    ELSE (NOT (id IN ( SELECT sherlock_access.hidden_session_ids() AS hidden_session_ids)))
END`,
  people: `
CASE
    WHEN ( SELECT sherlock_access.private_principal() AS private_principal) THEN (id IN ( SELECT sherlock_access.protected_person_ids() AS protected_person_ids))
    ELSE (NOT (id IN ( SELECT sherlock_access.protected_person_ids() AS protected_person_ids)))
END`,
};

class Rollback extends Error {}

async function inRollback(sql, work) {
  await sql.begin(async (tx) => {
    await work(tx);
    throw new Rollback();
  }).catch((error) => {
    if (!(error instanceof Rollback)) throw error;
  });
}

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

async function asRole(tx, role, work) {
  const outcome = await inSavepoint(tx, async (sp) => {
    await sp.unsafe(`set local role ${role}`);
    await sp.unsafe("set local search_path = pg_temp, public");
    return work(sp);
  });
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

// The production shape before this migration, including the Sesh reader role
// and its person-level batch policy.
async function installProductionShape(tx) {
  const [{ absent }] = await tx`select to_regnamespace('sherlock_access') is null as absent`;
  expect(absent).toBe(true);
  await tx.unsafe(`
    create schema sherlock_access;
    create table sherlock_access.restricted_people (workspace_id uuid, person_id uuid);
    grant usage on schema sherlock_access to ${READER};
  `);
  for (const [name, [returns, body]] of Object.entries(HELPERS)) {
    await tx.unsafe(`
      create function sherlock_access.${name}() returns ${returns}
        language sql stable security definer set search_path to '' as $function$${body}$function$;
      revoke all on function sherlock_access.${name}() from public;
      grant execute on function sherlock_access.${name}() to ${READER};
    `);
  }
  for (const table of Object.keys(POLICIES)) {
    await tx.unsafe(`
      alter table telemetry.${table} enable row level security;
      create policy sherlock_product_reader on telemetry.${table} for select to ${READER} using (${POLICIES[table]});
    `);
  }
  const [{ exists }] = await tx`select exists(select from pg_roles where rolname = ${SESH}) as exists`;
  if (!exists) await tx.unsafe(`create role ${SESH} nologin`);
  // Supabase's postgres is not a superuser: it needs membership to `set role`.
  await tx.unsafe(`grant ${SESH} to current_user`);
  await tx.unsafe(`
    grant usage on schema sherlock_access, telemetry to ${SESH};
    grant execute on function sherlock_access.protected_person_ids() to ${SESH};
    grant execute on function sherlock_access.hidden_session_ids() to ${SESH};
    grant select on telemetry.ingest_batches, telemetry.sessions to ${SESH};
    alter table telemetry.ingest_batches enable row level security;
    create policy sesh_reader_rows on telemetry.ingest_batches for select to ${SESH}
      using (not (person_id in (select sherlock_access.protected_person_ids())));
    create policy sesh_reader_rows on telemetry.sessions for select to ${SESH}
      using (not (id in (select sherlock_access.hidden_session_ids())));
  `);
  // Strictly new search functions: replace a locally applied copy inside the rollback.
  await tx.unsafe(`drop function if exists ${SEARCH}; drop function if exists ${GATE};`);
  await tx.unsafe(SEARCH_MIGRATION);
  await tx.unsafe(PRODUCT_ROLE_MIGRATION);
}

async function seedFixture(tx) {
  const home = randomUUID();
  await tx`insert into telemetry.workspaces (id, slug, name) values (${home}, ${`exclusions-${home}`}, 'Exclusions')`;
  const people = {};
  for (const key of ["alice", "bob", "rita"]) {
    const [row] = await tx`
      insert into telemetry.people (workspace_id, identity_key, email)
      values (${home}, ${key}, ${`${key}@e3group.ai`}) returning id`;
    people[key] = row.id;
  }
  await tx`insert into sherlock_access.restricted_people (workspace_id, person_id) values (${home}, ${people.rita})`;

  const sessions = {};
  const session = async (key, owner, { parent = null, parentNative = null, native = randomUUID() } = {}) => {
    const [row] = await tx`
      insert into telemetry.sessions (
        workspace_id, person_id, started_at, actor_role, collector_key, native_session_id,
        role_version, parent_session_id, parent_native_session_id
      ) values (
        ${home}, ${people[owner]}, ${START}, ${parent || parentNative ? "worker" : "primary"},
        ${`collector-${owner}`}, ${native}, 'test', ${parent ? sessions[parent].id : null}, ${parentNative}
      ) returning id, native_session_id`;
    sessions[key] = { id: row.id, native: row.native_session_id, owner };
  };
  await session("root", "alice");
  await session("child", "alice", { parent: "root" });
  await session("grandchild", "alice", { parent: "child" });
  await session("unresolved", "alice", { parentNative: sessions.root.native });
  await session("unresolvedChild", "alice", { parent: "unresolved" });
  await session("keep", "alice");
  await session("bob", "bob");
  await session("ritaRoot", "rita");

  let projection = 0;
  const batches = {};
  const events = {};
  const batch = async (key, owner, observed, observedParent = null) => {
    const [row] = await tx`
      insert into telemetry.ingest_batches (
        workspace_id, person_id, collector_key, source_kind, source_stream_key, generation_key,
        generation_seq, start_offset, end_offset, source_byte_count, source_sha256, storage_path,
        storage_encoding, stored_byte_count, stored_sha256, record_count, contract_version,
        observed_native_session_id, observed_parent_native_session_id
      ) values (
        ${home}, ${people[owner]}, ${`collector-${owner}`}, 'rollout', ${randomUUID()}, 'generation',
        0, 0, 1, 1, ${SHA}, ${`exclusions/${randomUUID()}`}, 'identity', 1, ${SHA}, 1, 'test',
        ${observed}, ${observedParent}
      ) returning id`;
    const records = await tx`
      insert into telemetry.native_records (
        workspace_id, batch_id, record_index, source_start_offset, source_end_offset, record_sha256, parse_status
      ) select ${home}, ${row.id}, r, r, r + 1, ${SHA}, 'ok' from generate_series(0, 3) r
      returning id`;
    batches[key] = { id: String(row.id), records: records.map((r) => r.id) };
  };
  for (const key of Object.keys(sessions)) {
    const s = sessions[key];
    await batch(key, s.owner, s.native);
  }
  // A child transcript whose session row has not been projected yet.
  await batch("pendingChild", "alice", randomUUID(), sessions.root.native);
  const event = async (key, batchKey, sessionKey, index = 0) => {
    const [row] = await tx`
      insert into telemetry.events (
        workspace_id, session_id, source_record_id, normalizer_version, projection_index,
        source_priority, event_kind, is_replay, content_excerpt, occurred_at, server_received_at
      ) values (
        ${home}, ${sessionKey ? sessions[sessionKey].id : null}, ${batches[batchKey].records[index]},
        'exclusions', ${projection++}, 0, ${sessionKey ? "message" : "lifecycle"}, false,
        'zebrafind synthetic excerpt', '2026-01-01T06:00:00Z', '2026-01-01T23:00:00Z'
      ) returning id`;
    events[key] = String(row.id);
  };
  for (const key of Object.keys(sessions)) await event(key, key, key);
  // Lifecycle rows without a session: one from an excluded batch, one not.
  await event("rootOrphan", "root", null, 1);
  await event("keepOrphan", "keep", null, 1);
  return { home, people, sessions, batches, events };
}

const sorted = (values) => [...values].map(String).sort();
const visibleSessions = (tx, f) => asRole(tx, READER, (sp) => sp`
  select id from telemetry.sessions where workspace_id = ${f.home}`).then((rows) => sorted(rows.map((r) => r.id)));
const visibleEvents = (tx, f) => asRole(tx, READER, (sp) => sp`
  select id from telemetry.events where workspace_id = ${f.home}`).then((rows) => sorted(rows.map((r) => r.id)));
const searchCandidates = (tx, f) => asRole(tx, READER, (sp) => sp`
  select event_id from analytics.search_excerpt_candidates(
    ${f.home}::uuid, 'zebrafind', ${START}::timestamptz, ${END}::timestamptz, ${READ_AT}::timestamptz,
    'e3group.ai', null, null, 2000)`).then((rows) => sorted(rows.map((r) => r.event_id)));
const record = (tx, f, owner, ids) => tx.unsafe(
  `select accepted, total from ${RECORD.replace("(uuid, uuid, text[])", "")}($1, $2, $3::text[])`,
  [f.home, f.people[owner], ids],
).then(([row]) => row);
const pick = (f, kind, keys) => sorted(keys.map((key) => f[kind][key].id ?? f[kind][key]));

describePostgres("owner session exclusions", { timeout: 180_000 }, () => {
  let sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("is only the index and gate without the private schema", async () => {
    await inRollback(sql, async (tx) => {
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      const [row] = await tx`
        select to_regnamespace('sherlock_access') is null as absent,
          to_regclass('telemetry.sessions_native_owner_idx') is not null as indexed,
          to_regprocedure('public.sherlock_excluded_native_session_ids(timestamptz)') is null as no_wrapper,
          analytics._assert_excerpt_search_policy_shape() as privacy`;
      expect(row).toEqual({ absent: true, indexed: true, no_wrapper: true, privacy: false });
    });
  });

  it("upgrades the recognized production shape idempotently with locked-down grants", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      const helpers = async () => tx`
        select p.oid::regprocedure::text fn, md5(p.prosrc) src, p.proacl::text acl
        from pg_proc p where p.pronamespace in ('sherlock_access'::regnamespace, 'public'::regnamespace)
          and p.proname not like 'pg\\_%' order by 1`;
      const first = await helpers();
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      expect(await helpers()).toEqual(first);
      const [gate] = await tx`select analytics._assert_excerpt_search_policy_shape() as privacy`;
      expect(gate.privacy).toBe(true);

      const [table] = await tx`
        select c.relrowsecurity rls, c.relacl::text acl,
          (select count(*)::int from pg_policy p where p.polrelid = c.oid) policies
        from pg_class c where c.oid = 'sherlock_access.owner_session_exclusions'::regclass`;
      expect(table.rls).toBe(true);
      expect(table.policies).toBe(0);
      for (const role of ["anon", "authenticated", "service_role", READER, SESH, "sherlock_ingest"]) {
        const [p] = await tx`select has_table_privilege(${role}, 'sherlock_access.owner_session_exclusions', 'SELECT,INSERT,UPDATE,DELETE') as any`;
        expect(p.any, role).toBe(false);
      }
      const can = async (role, fn) => (await tx`select has_function_privilege(${role}, ${fn}, 'execute') as ok`)[0].ok;
      for (const fn of [RPC, PUBLIC_RPC]) {
        expect(await can("anon", fn)).toBe(false);
        expect(await can("authenticated", fn)).toBe(false);
        expect(await can("service_role", fn)).toBe(true);
        expect(await can(SESH, fn)).toBe(true);
        expect(await can(READER, fn)).toBe(false);
        expect(await can("sherlock_ingest", fn)).toBe(false);
      }
      expect(await can("sherlock_ingest", RECORD)).toBe(true);
      for (const role of ["anon", "authenticated", "service_role", READER, SESH]) {
        expect(await can(role, RECORD), role).toBe(false);
      }
      for (const fn of ["sherlock_access.owner_excluded_sessions()"]) {
        for (const role of ["anon", "authenticated", "service_role", READER, SESH, "sherlock_ingest"]) {
          expect(await can(role, fn), `${role} ${fn}`).toBe(false);
        }
      }
    });
  });

  it("refuses an unrecognized privacy helper", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(`create or replace function sherlock_access.hidden_session_ids() returns setof uuid
        language sql stable security definer set search_path to '' as $f$ select null::uuid where false $f$`);
      const outcome = await inSavepoint(tx, (sp) => sp.unsafe(EXCLUSIONS_MIGRATION));
      expect(outcome.error?.message).toBe("excerpt_search_policy_unrecognized");
    });
  });

  it("hides excluded sessions, descendants and their records from every reader path", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      const f = await seedFixture(tx);
      const everyone = ["root", "child", "grandchild", "unresolved", "unresolvedChild", "keep", "bob"];
      expect(await visibleSessions(tx, f)).toEqual(pick(f, "sessions", everyone));
      expect(await searchCandidates(tx, f)).toEqual(pick(f, "events", everyone));

      // Alice also names Bob's session: it is stored under Alice and hides nothing.
      expect(await record(tx, f, "alice", [f.sessions.root.native, f.sessions.bob.native, f.sessions.root.native]))
        .toEqual({ accepted: 2, total: 2 });
      expect(await record(tx, f, "alice", [f.sessions.root.native])).toEqual({ accepted: 0, total: 1 });
      // Additive only: an empty report removes nothing.
      expect(await record(tx, f, "alice", [])).toEqual({ accepted: 0, total: 0 });

      const visible = ["keep", "bob"];
      expect(await visibleSessions(tx, f)).toEqual(pick(f, "sessions", visible));
      expect(await visibleEvents(tx, f)).toEqual(pick(f, "events", [...visible, "keepOrphan"]));
      expect(await searchCandidates(tx, f)).toEqual(pick(f, "events", visible));

      // Restricted behaviour is unchanged; the private principal set drops excluded sessions too.
      const [{ hidden }] = await tx`select array_agg(id order by id)::text[] hidden from sherlock_access.hidden_session_ids() id
        where id in (select id from telemetry.sessions where workspace_id = ${f.home})`;
      expect(sorted(hidden)).toEqual(pick(f, "sessions", ["root", "child", "grandchild", "unresolved", "unresolvedChild", "ritaRoot"]));
      expect(sorted((await tx`select id from sherlock_access.private_session_ids() id`).map((r) => r.id)))
        .toEqual(pick(f, "sessions", ["ritaRoot"]));
      await tx`insert into sherlock_access.owner_session_exclusions (workspace_id, person_id, native_session_id)
        values (${f.home}, ${f.people.rita}, ${f.sessions.ritaRoot.native})`;
      expect((await tx`select id from sherlock_access.private_session_ids() id`).length).toBe(0);

      // Only the orphan event's record needs record-level protection.
      const protectedIds = (await tx`select id from sherlock_access.protected_record_ids() id`).map((r) => String(r.id));
      expect(protectedIds).toContain(String(f.batches.root.records[1]));
      expect(protectedIds).not.toContain(String(f.batches.keep.records[1]));

      // Sesh: excluded sessions and their batches (including a child batch with
      // no session row yet) are gone; Bob's same-workspace rows stay.
      const seshBatches = await asRole(tx, SESH, (sp) => sp`
        select id from telemetry.ingest_batches where workspace_id = ${f.home}`);
      expect(sorted(seshBatches.map((r) => r.id))).toEqual(sorted([f.batches.keep.id, f.batches.bob.id]));
      const seshSessions = await asRole(tx, SESH, (sp) => sp`
        select id from telemetry.sessions where workspace_id = ${f.home}`);
      expect(sorted(seshSessions.map((r) => r.id))).toEqual(pick(f, "sessions", ["keep", "bob"]));
    });
  });

  it("serves the Sesh sync with roots, descendants and watermark times", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      const f = await seedFixture(tx);
      const orphanRoot = randomUUID();
      await tx`insert into sherlock_access.owner_session_exclusions (workspace_id, person_id, native_session_id, added_at)
        values (${f.home}, ${f.people.alice}, ${f.sessions.root.native}, '2026-02-01T00:00:00Z'),
               (${f.home}, ${f.people.alice}, ${orphanRoot}, '2026-02-02T00:00:00Z'),
               (${f.home}, ${f.people.alice}, ${f.sessions.bob.native}, '2026-02-03T00:00:00Z')`;
      // A subagent first seen after its root was excluded keeps its own time.
      await tx`update telemetry.sessions set created_at = '2026-03-01T00:00:00Z' where id = ${f.sessions.grandchild.id}`;
      await tx`update telemetry.sessions set created_at = '2026-01-01T00:00:00Z'
        where workspace_id = ${f.home} and id <> ${f.sessions.grandchild.id}`;

      const rows = await asRole(tx, SESH, (sp) => sp`select native_session_id, added_at from public.sherlock_excluded_native_session_ids()`);
      const byId = Object.fromEntries(rows.map((r) => [r.native_session_id, r.added_at.toISOString()]));
      const feb1 = "2026-02-01T00:00:00.000Z";
      expect(byId).toEqual({
        [f.sessions.root.native]: feb1,
        [f.sessions.child.native]: feb1,
        [f.sessions.grandchild.native]: "2026-03-01T00:00:00.000Z",
        [f.sessions.unresolved.native]: feb1,
        [f.sessions.unresolvedChild.native]: feb1,
        [orphanRoot]: "2026-02-02T00:00:00.000Z",
      });
      const after = await asRole(tx, SESH, (sp) => sp`
        select native_session_id from sherlock_access.excluded_native_session_ids('2026-02-01T00:00:00Z')`);
      expect(sorted(after.map((r) => r.native_session_id))).toEqual(sorted([orphanRoot, f.sessions.grandchild.native]));
      const service = await asRole(tx, "service_role", (sp) => sp`select count(*)::int n from public.sherlock_excluded_native_session_ids()`);
      expect(service[0].n).toBe(6);
      const denied = await inSavepoint(tx, async (sp) => {
        await sp.unsafe("set local role anon");
        return sp`select * from public.sherlock_excluded_native_session_ids()`;
      });
      expect(denied.error?.code).toBe("42501");
    });
  });

  it("validates collector reports and runs as the ingest role", async () => {
    await inRollback(sql, async (tx) => {
      await installProductionShape(tx);
      await tx.unsafe(EXCLUSIONS_MIGRATION);
      const f = await seedFixture(tx);
      const call = (person, ids) => asRole(tx, "sherlock_ingest", (sp) => sp.unsafe(
        "select accepted, total from sherlock_access.record_owner_session_exclusions($1, $2, $3::text[])",
        [f.home, person, ids],
      ));
      // Savepoints roll back, so the stored row is read in the same one.
      const stored = await asRole(tx, "sherlock_ingest", async (sp) => {
        const [result] = await sp.unsafe(
          "select accepted, total from sherlock_access.record_owner_session_exclusions($1, $2, $3::text[])",
          [f.home, f.people.alice, [f.sessions.keep.native]],
        );
        await sp.unsafe("reset role");
        const [row] = await sp`select count(*)::int n, max(source) source from sherlock_access.owner_session_exclusions
          where workspace_id = ${f.home}`;
        return { result, row };
      });
      expect(stored).toEqual({ result: { accepted: 1, total: 1 }, row: { n: 1, source: "collector" } });
      for (const ids of [["not-a-uuid"], [f.sessions.keep.native.toUpperCase()], [null],
        Array.from({ length: 5001 }, () => randomUUID())]) {
        await expect(call(f.people.alice, ids)).rejects.toMatchObject({ message: "owner_exclusions_invalid_argument" });
      }
      await expect(call(randomUUID(), [randomUUID()])).rejects.toMatchObject({ message: "owner_exclusions_unknown_person" });
    });
  });
});
