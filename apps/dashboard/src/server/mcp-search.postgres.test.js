import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORK_CONTEXT_PREFIXES } from "./flame-source.js";
import { createSherlockSearchSource } from "./mcp-search-source.js";
import { expandSearchAliases } from "./search-aliases.js";

const DATABASE_URL = process.env.SHERLOCK_TEST_DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;
const migration = (name) => DATABASE_URL ? readFileSync(new FileURL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8") : null;
const MIGRATION = migration("20261012135923_add_bounded_excerpt_search.sql");
const PRODUCT_ROLE_MIGRATION = migration("20261012140548_filter_excerpt_search_product_roles.sql");
const BOUNDED_LOOKUP_MIGRATION = migration("20261012065436_bound_protected_record_lookup.sql");
const SEARCH = "analytics.search_excerpt_candidates(uuid, text, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer)";
const GATE = "analytics._assert_excerpt_search_policy_shape()";
const READER = "sherlock_reader";
const SHA = "0".repeat(64);
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-01T12:00:00.000Z";
const READ_AT = "2026-01-02T00:00:00.000Z";
const AFTER_READ = "2026-01-02T00:00:00.001Z";

// Sanitized current production privacy helpers and reader policies (pg_get_functiondef
// bodies and pg_policies.qual). The privacy schema is optional and absent from migrations.
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

// Every synthetic schema, role, policy, and row lives in a transaction that is
// always rolled back, so shared telemetry and permissions are never changed.
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

async function installMigration(tx) {
  // Strictly new functions: drop a locally applied copy inside the rollback.
  await tx.unsafe(`drop function if exists ${SEARCH}; drop function if exists ${GATE};`);
  await tx.unsafe(MIGRATION);
  await tx.unsafe(PRODUCT_ROLE_MIGRATION);
}

async function installPrivacyShape(tx, { tables = ["events", "sessions", "people"], schema = "telemetry" } = {}) {
  const [{ present }] = await tx`select to_regnamespace('sherlock_access') is not null as present`;
  if (!present) {
    await tx.unsafe(`
      create schema sherlock_access;
      -- Nullable on purpose: a NULL member must hide rows exactly like NOT IN.
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
  }
  for (const table of tables) {
    await tx.unsafe(`
      alter table ${schema}.${table} enable row level security;
      create policy sherlock_product_reader on ${schema}.${table} for select to ${READER} using (${POLICIES[table]});
    `);
  }
}

let projection = 0;

async function seedRecords(tx, workspaceId, personId, count) {
  const [batch] = await tx`
    insert into telemetry.ingest_batches (
      workspace_id, person_id, collector_key, source_kind, source_stream_key,
      generation_key, generation_seq, start_offset, end_offset, source_byte_count,
      source_sha256, storage_path, storage_encoding, stored_byte_count,
      stored_sha256, record_count, contract_version
    ) values (
      ${workspaceId}, ${personId}, 'excerpt-search', 'rollout', ${randomUUID()},
      'generation', 0, 0, 1, 1, ${SHA}, ${`excerpt-search/${randomUUID()}`},
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
  return rows.map((row) => row.id);
}

async function seedFixture(tx) {
  const home = randomUUID();
  const foreign = randomUUID();
  await tx`
    insert into telemetry.workspaces (id, slug, name)
    values (${home}, ${`excerpt-search-${home}`}, 'Excerpt search home'),
      (${foreign}, ${`excerpt-search-${foreign}`}, 'Excerpt search foreign')`;
  const people = {};
  for (const [key, workspace, email, githubId] of [
    ["alice", home, "alice@e3group.ai", null],
    ["bob", home, "bob@e3group.ai", null],
    ["smoke", home, "smoke@e3group.ai", "sherlock-smoke"],
    ["outsider", home, "carol@example.test", null],
    ["nested", home, "dave@e3group.ai@example.test", null],
    ["sixty", home, "erin@sixtyfour.ai", null],
    ["foreigner", foreign, "frank@e3group.ai", null],
  ]) {
    const [row] = await tx`
      insert into telemetry.people (workspace_id, identity_key, email, github_id)
      values (${workspace}, ${key}, ${email}, ${githubId}) returning id`;
    people[key] = { id: row.id, workspace, records: await seedRecords(tx, workspace, row.id, 40), next: 0 };
  }
  const sessions = {};
  const session = async (key, owner, parent = null) => {
    const [row] = await tx`
      insert into telemetry.sessions (
        workspace_id, person_id, started_at, actor_role, collector_key,
        native_session_id, role_version, parent_session_id
      ) values (
        ${people[owner].workspace}, ${people[owner].id}, ${START}, 'primary', 'excerpt-search',
        ${randomUUID()}, 'test', ${parent}
      ) returning id`;
    sessions[key] = { id: row.id, owner };
  };
  await session("alice", "alice");
  await session("alice2", "alice");
  await session("bob", "bob");
  // Owned by a visible person but hidden as a child of a restricted session.
  await session("bobChild", "alice", sessions.bob.id);
  for (const key of ["smoke", "outsider", "nested", "sixty", "foreigner"]) await session(key, key);

  const events = {};
  const event = async (key, sessionKey, options = {}) => {
    const owner = people[options.recordOwner ?? sessions[sessionKey].owner];
    const [row] = await tx`
      insert into telemetry.events (
        workspace_id, session_id, related_session_id, source_record_id, normalizer_version,
        projection_index, source_priority, event_kind, is_replay, content_excerpt,
        occurred_at, server_received_at
      ) values (
        ${owner.workspace}, ${sessions[sessionKey].id}, ${options.related ? sessions[options.related].id : null},
        ${owner.records[owner.next++]}, 'excerpt-search', ${projection++}, 0,
        ${options.kind ?? "message"}, ${options.replay ?? false},
        ${options.text === undefined ? "zebrafind synthetic excerpt" : options.text},
        ${options.occurredAt === undefined ? "2026-01-01T06:00:00Z" : options.occurredAt},
        ${options.receivedAt ?? "2026-01-01T23:00:00Z"}
      ) returning id`;
    events[key] = String(row.id);
  };
  await event("visible", "alice");
  await event("agentMessage", "alice", { kind: "agent_message" });
  await event("otherSession", "alice2");
  await event("relatedVisible", "alice", { related: "alice2" });
  await event("atStart", "alice", { occurredAt: START });
  await event("atReadAt", "alice", { receivedAt: READ_AT });
  await event("protectedRecord", "alice", { recordOwner: "bob" });
  await event("relatedHidden", "alice", { related: "bob" });
  await event("bobSession", "bob");
  await event("childOfHidden", "bobChild");
  await event("sixty", "sixty");
  // Never returned: wrong kind, replay, no excerpt, no hit, outside time, scope.
  await event("reasoning", "alice", { kind: "reasoning" });
  await event("replay", "alice", { replay: true });
  await event("noExcerpt", "alice", { text: null });
  await event("noHit", "alice", { text: "unrelated synthetic excerpt" });
  await event("atEnd", "alice", { occurredAt: END });
  await event("noOccurredAt", "alice", { occurredAt: null });
  await event("afterReadAt", "alice", { receivedAt: AFTER_READ });
  await event("smoke", "smoke");
  await event("outsider", "outsider");
  await event("nested", "nested");
  await event("foreigner", "foreigner");
  return { home, foreign, people, sessions, events };
}

const sortIds = (ids) => ids.map(String).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));

function args(fixture, overrides = {}) {
  return {
    workspace: fixture.home, query: "zebrafind", start: START, end: END, readAt: READ_AT,
    domain: "e3group.ai", person: null, session: null, limit: 2000, ...overrides,
  };
}

const callSearch = (tx, a) => tx`
  select event_id, score from analytics.search_excerpt_candidates(
    ${a.workspace}::uuid, ${a.query}::text, ${a.start}::timestamptz, ${a.end}::timestamptz,
    ${a.readAt}::timestamptz, ${a.domain}::text, ${a.person}::uuid, ${a.session}::uuid, ${a.limit}::integer)`;

async function asReader(tx, work, role = READER) {
  return inSavepoint(tx, async (sp) => {
    await sp.unsafe(`set local role ${role}`);
    // A hostile caller search path cannot redirect the qualified definer body.
    await sp.unsafe("set local search_path = pg_temp, public");
    return work(sp);
  });
}

async function search(tx, a) {
  const outcome = await asReader(tx, (sp) => callSearch(sp, a));
  if (outcome.error) throw outcome.error;
  for (const row of outcome.value) expect(Object.keys(row).sort()).toEqual(["event_id", "score"]);
  return sortIds(outcome.value.map((row) => row.event_id));
}

// The ordinary reader query under normal RLS with identical filters, written
// independently of the function body.
async function readerVisible(tx, a) {
  const outcome = await asReader(tx, (sp) => sp`
    select e.id
    from telemetry.events e
    join telemetry.sessions s on s.workspace_id = e.workspace_id and s.id = e.session_id
    join telemetry.people pe on pe.workspace_id = s.workspace_id and pe.id = s.person_id
    where e.workspace_id = ${a.workspace}::uuid
      and e.event_kind in ('message', 'agent_message')
      and e.message_search @@ websearch_to_tsquery('simple', ${a.query}::text)
      and not e.is_replay and e.content_excerpt is not null
      and e.occurred_at >= ${a.start}::timestamptz and e.occurred_at < ${a.end}::timestamptz
      and e.server_received_at <= ${a.readAt}::timestamptz
      and pe.github_id is distinct from 'sherlock-smoke'
      and split_part(pe.email, '@', 2) = ${a.domain}::text and split_part(pe.email, '@', 3) = ''
      and (${a.person}::uuid is null or s.person_id = ${a.person}::uuid)
      and (${a.session}::uuid is null or s.id = ${a.session}::uuid)`);
  if (outcome.error) throw outcome.error;
  return sortIds(outcome.value.map((row) => row.id));
}

async function expectEquivalent(tx, fixture, overrides, expectedKeys) {
  const a = args(fixture, overrides);
  const candidates = await search(tx, a);
  expect(candidates).toEqual(await readerVisible(tx, a));
  if (expectedKeys) expect(candidates).toEqual(sortIds(expectedKeys.map((key) => fixture.events[key])));
  return candidates;
}

async function searchError(tx, a, role = READER) {
  const outcome = await asReader(tx, (sp) => callSearch(sp, a), role);
  return outcome.error;
}

async function catalogSnapshot(tx) {
  const [row] = await tx`
    select
      (select json_agg(json_build_object('rel', c.oid::regclass::text, 'acl', c.relacl::text[],
         'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) order by c.oid::regclass::text)
         from pg_class c where c.relnamespace in ('telemetry'::regnamespace, 'analytics'::regnamespace)) as relations,
      (select json_agg(json_build_object('p', p.*) order by p.schemaname, p.tablename, p.policyname) from pg_policies p) as policies,
      (select json_agg(json_build_object('role', r.rolname, 'bypass', r.rolbypassrls, 'super', r.rolsuper) order by r.rolname)
         from pg_roles r where r.rolname like 'sherlock%') as roles,
      (select json_agg(json_build_object('role', m.roleid::regrole::text, 'member', m.member::regrole::text)
         order by m.roleid::regrole::text, m.member::regrole::text)
         from pg_auth_members m where 'sherlock_reader'::regrole in (m.roleid, m.member)) as memberships,
      (select json_agg(json_build_object('fn', p.oid::regprocedure::text, 'acl', p.proacl::text[], 'src', md5(p.prosrc))
         order by p.oid::regprocedure::text)
         from pg_proc p
        where p.pronamespace in ('telemetry'::regnamespace, 'analytics'::regnamespace)
          and p.proname not in ('search_excerpt_candidates', '_assert_excerpt_search_policy_shape')) as functions`;
  return row;
}

function planNodes(value, nodes = []) {
  if (Array.isArray(value)) {
    for (const item of value) planNodes(item, nodes);
  } else if (value && typeof value === "object") {
    if (typeof value["Node Type"] === "string") nodes.push(value);
    for (const child of Object.values(value)) planNodes(child, nodes);
  }
  return nodes;
}

const usesSearchIndex = (nodes) => nodes.some((node) => node["Relation Name"] === undefined
  && node["Node Type"] === "Bitmap Index Scan" && /message_search/.test(node["Index Name"] ?? ""));

describePostgres("bounded excerpt search candidates", { timeout: 180_000 }, () => {
  let sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("installs on the fresh shape with reader-only execute and no other catalog change", async () => {
    await inRollback(sql, async (tx) => {
      const [{ absent }] = await tx`select to_regnamespace('sherlock_access') is null as absent`;
      expect(absent).toBe(true);
      await tx.unsafe(`drop function if exists ${SEARCH}; drop function if exists ${GATE};`);
      const before = await catalogSnapshot(tx);
      await tx.unsafe(MIGRATION);
  await tx.unsafe(PRODUCT_ROLE_MIGRATION);
      expect(await catalogSnapshot(tx)).toEqual(before);

      const acl = await tx.unsafe(`
        select p.oid::regprocedure::text fn, p.proacl::text[] acl, p.prosecdef, p.provolatile,
          p.proconfig, pg_get_userbyid(p.proowner) owner
        from pg_proc p where p.oid in ('${SEARCH}'::regprocedure, '${GATE}'::regprocedure) order by 1`);
      expect(acl.map((row) => [row.acl, row.prosecdef, row.provolatile, row.proconfig, row.owner])).toEqual([
        [["postgres=X/postgres"], true, "s", ['search_path=""'], "postgres"],
        [["postgres=X/postgres", "sherlock_reader=X/postgres"], true, "s",
          ['search_path=""', "plan_cache_mode=force_custom_plan"], "postgres"],
      ]);
      const [privileges] = await tx.unsafe(`
        select array(select r from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
                      where has_function_privilege(r, '${SEARCH}', 'execute')) search_grantees,
               has_function_privilege('${READER}', '${SEARCH}', 'execute') reader_search,
               has_function_privilege('${READER}', '${GATE}', 'execute') reader_gate,
               analytics._assert_excerpt_search_policy_shape() privacy`);
      expect(privileges).toEqual({ search_grantees: [], reader_search: true, reader_gate: false, privacy: false });

      const fixture = await seedFixture(tx);
      const all = ["visible", "agentMessage", "otherSession", "relatedVisible", "atStart", "atReadAt",
        "protectedRecord", "relatedHidden", "childOfHidden"];
      await expectEquivalent(tx, fixture, {}, [...all, "bobSession"]);
      await expectEquivalent(tx, fixture, { domain: "sixtyfour.ai" }, ["sixty"]);
      await expectEquivalent(tx, fixture, { workspace: fixture.foreign }, ["foreigner"]);
      await expectEquivalent(tx, fixture, { person: fixture.people.alice.id }, all);
      await expectEquivalent(tx, fixture, { session: fixture.sessions.alice2.id }, ["otherSession"]);
      await expectEquivalent(tx, fixture, { person: fixture.people.smoke.id }, []);
      await expectEquivalent(tx, fixture, { person: fixture.people.foreigner.id }, []);
      // Exact half-open occurrence window and inclusive read cut.
      await expectEquivalent(tx, fixture, { end: "2026-01-01T06:00:00Z" }, ["atStart"]);
      await expectEquivalent(tx, fixture, { readAt: "2026-01-01T23:59:59Z", end: "2026-01-01T23:00:00Z" },
        ["visible", "agentMessage", "otherSession", "relatedVisible", "atStart", "protectedRecord",
          "relatedHidden", "childOfHidden", "bobSession", "atEnd"]);
      await expectEquivalent(tx, fixture, { query: "zebrafind -alpha" }, [...all, "bobSession"]);
      await expectEquivalent(tx, fixture, { query: "\"unrelated synthetic\" or nothinghere" }, ["noHit"]);
    });
  });

  it("matches the exact PP-OCRv6 spelling through expanded real PostgreSQL lexemes", async () => {
    await inRollback(sql, async (tx) => {
      const expanded = expandSearchAliases("paddleocr 500", true);
      const [{ ocr, paddle, exact }] = await tx`
        select
          to_tsvector('simple', '500 PP-OCRv6 completed') @@ websearch_to_tsquery('simple', ${expanded}) as ocr,
          to_tsvector('simple', 'Paddle 200 completed') @@ websearch_to_tsquery('simple', ${expanded}) as paddle,
          to_tsvector('simple', '500 PP-OCRv6 completed') @@ websearch_to_tsquery('simple', ${"paddleocr 500"}) as exact`;
      expect({ ocr, paddle, exact }).toEqual({ ocr: true, paddle: false, exact: false });
    });
  });

  it("expands the exact 27-node alias within SQL limits and falls back above them", async () => {
    await inRollback(sql, async (tx) => {
      await installMigration(tx);
      const f = await seedFixture(tx);
      await tx`update telemetry.ingest_batches set source_provider = 'codex' where workspace_id = ${f.home}`;
      await tx`update telemetry.events set normalizer_version = 'sherlock.codex-rollout.v3' where workspace_id = ${f.home}`;
      const [event] = await tx`insert into telemetry.events (
        workspace_id, session_id, source_record_id, normalizer_version, projection_index,
        source_priority, event_kind, message_role, content_excerpt, occurred_at, server_received_at
      ) values (${f.home}, ${f.sessions.alice.id}, ${f.people.alice.records[30]},
        'sherlock.codex-rollout.v3', 8100, 0, 'message', 'assistant',
        'PP-OCRv6 alpha beta gamma', ${START}, ${READ_AT}) returning id`;

      let transactions = 0;
      const api = createSherlockSearchSource({
        workspaceId: f.home, expectedEmailDomain: 'e3group.ai', maxPeople: 100,
        async transaction(callback) {
          transactions += 1;
          const outcome = await asReader(tx, callback);
          if (outcome.error) throw outcome.error;
          return outcome.value;
        },
      });
      const common = { personId: f.people.alice.id, start: START, end: END, now: new Date(READ_AT),
        expandAliases: true, groupIdenticalExcerpts: false };
      const expanded = expandSearchAliases('paddleocr alpha beta gamma', true);
      expect(expanded).toContain('"PP-OCRv6" alpha beta gamma');
      const [{ expanded_nodes: expandedNodes }] = await tx`
        select numnode(websearch_to_tsquery('simple', ${expanded})) expanded_nodes`;
      expect(Number(expandedNodes)).toBe(27);
      const hit = await api.searchSessions({ ...common, query: 'paddleocr alpha beta gamma' });
      expect(hit.results.map((row) => row.eventId)).toEqual([String(event.id)]);

      const overNode = 'paddleocr alpha beta gamma delta';
      expect(expandSearchAliases(overNode, true)).toBe(overNode);
      const [{ raw_nodes: rawNodes }] = await tx`
        select numnode(websearch_to_tsquery('simple', ${overNode})) raw_nodes`;
      expect(Number(rawNodes)).toBe(9);
      const fallback = await api.searchSessions({ ...common, query: overNode });
      expect(fallback.results).toEqual([]);
      const rawTokenOverflow = 'paddleocr alpha beta gamma delta epsilon zeta eta theta';
      await expect(api.searchSessions({ ...common, query: rawTokenOverflow }))
        .rejects.toMatchObject({ code: 'flame_mcp_query_request_invalid' });
      expect(transactions).toBe(2);
    });
  });

  it("reports fused 501-candidate budgets after verifying current and obsolete projections", async () => {
    await inRollback(sql, async (tx) => {
      await installPrivacyShape(tx);
      await installMigration(tx);
      const f = await seedFixture(tx);
      const records = await seedRecords(tx, f.home, f.people.alice.id, 501);
      await tx`update telemetry.ingest_batches set source_provider = 'codex' where workspace_id = ${f.home}`;
      await tx`update telemetry.events set normalizer_version = 'sherlock.codex-rollout.v3' where workspace_id = ${f.home}`;

      const recordArray = tx.array(records);
      await tx`
        insert into telemetry.events (
          workspace_id, session_id, source_record_id, normalizer_version, projection_index,
          source_priority, canonical_scope_key, logical_event_key, event_kind, message_role,
          content_excerpt, occurred_at, server_received_at
        )
        select ${f.home}, ${f.sessions.alice.id}, source_id, 'sherlock.codex-rollout.v3',
          50000 + ordinal::integer, 1, 'fused-budget', 'projection-' || ordinal,
          'message', 'assistant', 'currentfuse current ' || ordinal, ${START}, ${READ_AT}
        from unnest(${recordArray}::bigint[]) with ordinality as records(source_id, ordinal)`;
      await tx`
        insert into telemetry.events (
          workspace_id, session_id, source_record_id, normalizer_version, projection_index,
          source_priority, canonical_scope_key, logical_event_key, event_kind, message_role,
          content_excerpt, occurred_at, server_received_at
        )
        select ${f.home}, ${f.sessions.alice.id}, source_id, 'sherlock.codex-rollout.v2',
          60000 + ordinal::integer, 0, 'fused-budget', 'projection-' || ordinal,
          'message', 'assistant', 'obsoletefuse old ' || ordinal, ${START}, ${READ_AT}
        from unnest(${recordArray}::bigint[]) with ordinality as records(source_id, ordinal)`;

      const api = createSherlockSearchSource({
        workspaceId: f.home, expectedEmailDomain: 'e3group.ai', maxPeople: 100,
        async transaction(callback) {
          const outcome = await asReader(tx, callback);
          if (outcome.error) throw outcome.error;
          return outcome.value;
        },
      });
      const common = { personId: f.people.alice.id, start: START, end: END,
        now: new Date(READ_AT), limit: 20, perSessionLimit: 5, groupIdenticalExcerpts: false };
      const current = await api.searchSessions({ ...common, query: 'currentfuse' });
      expect(current).toMatchObject({
        budgetReached: true,
        matchCount: 500,
        coverage: { candidateBudget: 500, candidatesExamined: 500, canonicalMatches: 500, returnedMatches: 5 },
      });
      const obsolete = await api.searchSessions({ ...common, query: 'obsoletefuse' });
      expect(obsolete).toMatchObject({
        budgetReached: true,
        matchCount: 0,
        results: [],
        coverage: { candidateBudget: 500, candidatesExamined: 500, canonicalMatches: 0, returnedMatches: 0 },
      });
    });
  });

  it("omits runtime user envelopes before the budget without filtering assistant evidence", async () => {
    await inRollback(sql, async (tx) => {
      await installMigration(tx);
      const f = await seedFixture(tx);
      for (const [index, prefix] of WORK_CONTEXT_PREFIXES.entries()) {
        await tx`insert into telemetry.events (
          workspace_id, session_id, source_record_id, normalizer_version, projection_index,
          source_priority, event_kind, message_role, content_excerpt, occurred_at, server_received_at
        ) values (${f.home}, ${f.sessions.alice.id}, ${f.people.alice.records[30]},
          'excerpt-search', ${6000 + index}, 0, 'message', 'user',
          ${"\n\t" + prefix + " envelopeprobe"}, ${START}, ${READ_AT})`;
      }
      expect(await search(tx, args(f, { query: "envelopeprobe", limit: 1 }))).toEqual([]);
      const [real] = await tx`insert into telemetry.events (
        workspace_id, session_id, source_record_id, normalizer_version, projection_index,
        source_priority, event_kind, message_role, content_excerpt, occurred_at, server_received_at
      ) values (${f.home}, ${f.sessions.alice.id}, ${f.people.alice.records[31]},
        'excerpt-search', 7000, 0, 'message', 'assistant',
        'envelopeprobe actual experiment result', ${START}, ${READ_AT}) returning id`;
      expect(await search(tx, args(f, { query: "envelopeprobe", limit: 1 }))).toEqual([String(real.id)]);
    });
  });

  it("executes the real source search and context SQL with RLS, corrections and microsecond paging", async () => {
    await inRollback(sql, async (tx) => {
      await installPrivacyShape(tx);
      await installMigration(tx);
      const f = await seedFixture(tx);
      await tx`insert into sherlock_access.restricted_people values (${f.home}, ${f.people.bob.id})`;
      // Only synthetic rolled-back fixture projections are adjusted here.
      await tx`update telemetry.ingest_batches set source_provider = 'codex' where workspace_id = ${f.home}`;
      await tx`update telemetry.events set normalizer_version = 'sherlock.codex-rollout.v3',
        message_role = 'user', message_origin = 'human' where workspace_id = ${f.home}`;
      await tx`update telemetry.people set display_name = 'Alice Researcher' where id = ${f.people.alice.id}`;
      const api = createSherlockSearchSource({
        workspaceId: f.home, expectedEmailDomain: 'e3group.ai', maxPeople: 100,
        async transaction(callback) {
          const result = await asReader(tx, callback);
          if (result.error) throw result.error;
          return result.value;
        },
      });
      const person = await api.resolvePerson({ name: 'Alice' });
      expect(person.matches.map(x => x.personId)).toEqual([f.people.alice.id]);
      expect((await api.resolvePerson({ name: 'bob' })).matches).toEqual([]);
      const hits = await api.searchSessions({ query: 'zebrafind', personId: f.people.alice.id,
        start: START, end: END, now: new Date(READ_AT), limit: 20, perSessionLimit: 5,
        groupIdenticalExcerpts: false });
      expect(sortIds(hits.results.map(x => x.eventId))).toEqual(sortIds([
        f.events.visible, f.events.agentMessage, f.events.otherSession, f.events.relatedVisible,
        f.events.atStart, f.events.atReadAt,
      ]));
      expect(hits.results.every(x => x.source.recordSha256 === SHA)).toBe(true);
      const grouped = await api.searchSessions({ query: 'zebrafind', personId: f.people.alice.id,
        start: START, end: END, now: new Date(READ_AT), limit: 20 });
      expect(grouped.matchCount).toBe(6);
      expect(grouped.results).toHaveLength(1);
      expect(grouped.results[0].excerptGroup.occurrences).toBe(6);
      const reachable = [grouped.results[0], ...grouped.results[0].excerptGroup.alternativeSources];
      expect(sortIds(reachable.map(x => x.eventId))).toEqual(sortIds(hits.results.map(x => x.eventId)));
      for (const location of reachable) {
        const evidence = await api.readSessionEvidence({ sessionId: location.sessionId,
          anchorEventId: location.eventId, limit: 1, now: new Date(READ_AT) });
        expect(evidence.events[0]).toMatchObject({ eventId: location.eventId, isAnchor: true,
          canonicalAtRead: true });
      }
      for (const sessionId of [f.sessions.bob.id, f.sessions.bobChild.id, f.sessions.foreigner.id]) {
        await expect(api.readSessionEvidence({ sessionId })).rejects.toMatchObject({ code: 'flame_mcp_query_not_found' });
      }
      await expect(api.readSessionEvidence({ sessionId: f.sessions.alice.id,
        anchorEventId: f.events.otherSession })).rejects.toMatchObject({ code: 'flame_mcp_query_not_found' });
      // Two projections with the same identity; only the higher-priority source wins.
      const add = async (key, time, priority, text) => {
        const [row] = await tx`insert into telemetry.events (
          workspace_id, session_id, source_record_id, normalizer_version, projection_index,
          source_priority, canonical_scope_key, logical_event_key, event_kind, message_role,
          content_excerpt, occurred_at, server_received_at
        ) values (${f.home}, ${f.sessions.alice2.id}, ${f.people.alice.records[32 + priority]},
          'sherlock.codex-rollout.v3', ${8000 + projection++}, ${priority}, 'test-scope', ${key},
          'message', 'assistant', ${text}, ${time}::text::timestamptz, ${READ_AT}) returning id`;
        return String(row.id);
      };
      const stale = await add('corrected', '2026-01-01T10:00:00.000001Z', 0, 'oldresult stale');
      const winner = await add('corrected', '2026-01-01T10:00:00.000002Z', 1, 'newresult accepted');
      const next = await add('next', '2026-01-01T10:00:00.000003Z', 2, 'newresult next');
      expect((await api.searchSessions({ query: 'oldresult', now: new Date(READ_AT) })).results).toEqual([]);
      expect((await api.searchSessions({ query: 'newresult', now: new Date(READ_AT) })).results.map(x => x.eventId))
        .toEqual([next, winner]);
      const exact = await api.readSessionEvidence({ sessionId: f.sessions.alice2.id, anchorEventId: stale, limit: 2,
        now: new Date(READ_AT) });
      expect(exact.events.find(x => x.eventId === stale)).toMatchObject({ isAnchor: true, canonicalAtRead: false });
      const anchorOnly = await api.readSessionEvidence({ sessionId: f.sessions.alice2.id,
        anchorEventId: stale, limit: 1, now: new Date(READ_AT) });
      expect(anchorOnly.events.map(x => x.eventId)).toEqual([stale]);
      expect(anchorOnly.nextCursor).not.toBeNull();
      const afterAnchor = await api.readSessionEvidence({ sessionId: f.sessions.alice2.id,
        cursor: anchorOnly.nextCursor, limit: 2, now: new Date(READ_AT) });
      expect(afterAnchor.events.map(x => x.eventId)).toEqual([winner, next]);
      expect(exact.events.find(x => x.eventId === winner)?.occurredAt).toBe('2026-01-01T10:00:00.000002Z');
      expect(exact.nextCursor).not.toBeNull();
      const tail = await api.readSessionEvidence({ sessionId: f.sessions.alice2.id, cursor: exact.nextCursor,
        limit: 2, now: new Date(READ_AT) });
      expect(tail.events.map(x => x.eventId)).toEqual([next]);
      expect(tail.nextCursor).toBeNull();
    });
  });

  it("excludes guardian and automation sessions before the budget and on source-open", async () => {
    await inRollback(sql, async tx => {
      await installMigration(tx);
      const f = await seedFixture(tx);
      await tx`update telemetry.ingest_batches set source_provider = 'codex' where workspace_id = ${f.home}`;
      await tx`update telemetry.events set normalizer_version = 'sherlock.codex-rollout.v3' where workspace_id = ${f.home}`;
      await tx`update telemetry.sessions set actor_role = 'guardian' where id in (${f.sessions.alice.id}, ${f.sessions.bob.id})`;
      await tx`update telemetry.sessions set actor_role = 'automation' where id = ${f.sessions.alice2.id}`;
      expect(await search(tx, args(f, { person: f.people.alice.id, limit: 1 })))
        .toEqual([f.events.childOfHidden]);
      const api = createSherlockSearchSource({ workspaceId: f.home, expectedEmailDomain: 'e3group.ai', maxPeople: 100,
        async transaction(cb) { const result = await asReader(tx, cb); if (result.error) throw result.error; return result.value; } });
      const child = await api.readSessionEvidence({ sessionId: f.sessions.bobChild.id });
      expect(child.session).toMatchObject({ parentSessionId: null, parentOmitted: true });
      for (const sessionId of [f.sessions.alice.id, f.sessions.alice2.id]) {
        await expect(api.readSessionEvidence({ sessionId })).rejects.toMatchObject({ code: 'flame_mcp_query_not_found' });
      }
    });
  });

  it("rejects callers outside the reader role and unbounded arguments", async () => {
    await inRollback(sql, async (tx) => {
      await installMigration(tx);
      const fixture = await seedFixture(tx);
      const suffix = randomUUID().replaceAll("-", "");
      await tx.unsafe(`
        create role excerpt_outsider_${suffix} nologin;
        create role excerpt_member_${suffix} nologin in role ${READER};
        grant excerpt_outsider_${suffix}, excerpt_member_${suffix} to current_user;
      `);
      const base = args(fixture);
      // Owner and inheriting members are refused unless the normal reader role is set.
      const asOwner = await inSavepoint(tx, (sp) => callSearch(sp, base));
      expect(asOwner.error?.message).toBe("excerpt_search_role_required");
      expect((await searchError(tx, base, `excerpt_member_${suffix}`))?.message).toBe("excerpt_search_role_required");
      const outsider = await searchError(tx, base, `excerpt_outsider_${suffix}`);
      expect(outsider?.code).toBe("42501");
      expect(outsider?.message).toMatch(/permission denied/);
      const gate = await asReader(tx, (sp) => sp.unsafe(`select ${GATE}`));
      expect(gate.error?.code).toBe("42501");

      const future = new Date(Date.now() + 3_600_000).toISOString();
      for (const overrides of [
        { workspace: null }, { query: null }, { start: null }, { end: null }, { readAt: null }, { domain: null },
        { limit: null }, { limit: 0 }, { limit: 2001 }, { domain: "example.test" }, { domain: "E3GROUP.AI" },
        { query: "a" }, { query: "z".repeat(257) }, { start: END }, { end: "2026-01-02T00:00:01Z" },
        { end: future, readAt: future },
      ]) {
        const error = await searchError(tx, args(fixture, overrides));
        expect([overrides, error?.code, error?.message]).toEqual([overrides, "22023", "excerpt_search_invalid_argument"]);
      }
      const [{ clock_at }] = await tx`select clock_timestamp() + interval '2 seconds' as clock_at`;
      expect(await search(tx, args(fixture, { readAt: clock_at.toISOString() }))).not.toHaveLength(0);
      const [{ far }] = await tx`select clock_timestamp() + interval '6 seconds' far`;
      expect((await searchError(tx, args(fixture, { readAt: far.toISOString() }))).message)
        .toBe('excerpt_search_invalid_argument');
      // JavaScript dates cannot be infinite, so these bounds are SQL literals.
      for (const [start, end, readAt] of [["-infinity", END, READ_AT], [START, "infinity", "infinity"]]) {
        const outcome = await asReader(tx, (sp) => sp.unsafe(`
          select * from analytics.search_excerpt_candidates('${fixture.home}', 'zebrafind',
            '${start}', '${end}', '${readAt}', 'e3group.ai')`));
        expect([start, outcome.error?.message]).toEqual([start, "excerpt_search_invalid_argument"]);
      }
      for (const query of ["-zebrafind", "!!", "\"\"", "-alpha -beta", "zebrafind or -alpha",
        Array.from({ length: 17 }, (_, index) => `term${index}`).join(" or ")]) {
        const error = await searchError(tx, args(fixture, { query }));
        expect([query, error?.code, error?.message]).toEqual([query, "22023", "excerpt_search_invalid_query"]);
      }
      // 16 or-terms is 31 nodes, the largest accepted query.
      const widest = Array.from({ length: 16 }, (_, index) => `term${index}`).join(" or ");
      expect(await search(tx, args(fixture, { query: widest }))).toEqual([]);
    });
  });

  it("matches ordinary reader RLS visibility on the current production privacy shape", async () => {
    await inRollback(sql, async (tx) => {
      // Installed before the migration so its final gate recognizes the production shape.
      await installPrivacyShape(tx);
      await tx.unsafe(`drop function if exists ${SEARCH}; drop function if exists ${GATE};`);
      const before = await catalogSnapshot(tx);
      await tx.unsafe(MIGRATION);
  await tx.unsafe(PRODUCT_ROLE_MIGRATION);
      expect(await catalogSnapshot(tx)).toEqual(before);
      const fixture = await seedFixture(tx);
      await tx`insert into sherlock_access.restricted_people values (${fixture.home}, ${fixture.people.bob.id})`;
      const [{ privacy }] = await tx.unsafe(`select ${GATE} privacy`);
      expect(privacy).toBe(true);

      const visible = ["visible", "agentMessage", "otherSession", "relatedVisible", "atStart", "atReadAt"];
      await expectEquivalent(tx, fixture, {}, visible);
      await expectEquivalent(tx, fixture, { person: fixture.people.alice.id }, visible);
      await expectEquivalent(tx, fixture, { person: fixture.people.bob.id }, []);
      await expectEquivalent(tx, fixture, { session: fixture.sessions.bob.id }, []);
      await expectEquivalent(tx, fixture, { session: fixture.sessions.bobChild.id }, []);
      await expectEquivalent(tx, fixture, { domain: "sixtyfour.ai" }, ["sixty"]);
      await expectEquivalent(tx, fixture, { workspace: fixture.foreign }, ["foreigner"]);

      // A restriction in another workspace still hides that person id from the
      // people policy, while session restrictions stay workspace-scoped.
      await tx`insert into sherlock_access.restricted_people values (${fixture.foreign}, ${fixture.people.sixty.id})`;
      await expectEquivalent(tx, fixture, { domain: "sixtyfour.ai" }, []);
      // A NULL protected person makes NOT IN unknown for everyone.
      await tx`insert into sherlock_access.restricted_people values (${fixture.home}, null)`;
      await expectEquivalent(tx, fixture, {}, []);
      await expectEquivalent(tx, fixture, { workspace: fixture.foreign }, []);
      // Restriction changes apply on the next call.
      await tx`delete from sherlock_access.restricted_people`;
      await expectEquivalent(tx, fixture, {}, [...visible, "protectedRecord", "relatedHidden", "bobSession", "childOfHidden"]);
      await tx`insert into sherlock_access.restricted_people values (${fixture.home}, ${fixture.people.bob.id})`;

      // The PR117 bounded lookup body is also recognized; results are unchanged across repeated custom plans.
      await tx.unsafe(BOUNDED_LOOKUP_MIGRATION);
      for (let call = 0; call < 7; call += 1) await expectEquivalent(tx, fixture, {}, visible);
    });
  });

  it("filters protected matches before the candidate budget and returns one overflow row", async () => {
    await inRollback(sql, async (tx) => {
      await installPrivacyShape(tx);
      await installMigration(tx);
      const fixture = await seedFixture(tx);
      await tx`insert into sherlock_access.restricted_people values (${fixture.home}, ${fixture.people.bob.id})`;
      // Protected rows are inserted first, so an unfiltered physical scan would hit them first.
      const insert = (sessionKey, text, count, recordOwner) => tx`
        insert into telemetry.events (
          workspace_id, session_id, source_record_id, normalizer_version, projection_index,
          source_priority, event_kind, content_excerpt, occurred_at, server_received_at
        )
        select ${fixture.home}, ${fixture.sessions[sessionKey].id}, ${fixture.people[recordOwner].records[30]},
          'excerpt-search', 1000 + ${projection++} * 100 + g, 0, 'message', ${text}, ${"2026-01-01T06:00:00Z"}, ${"2026-01-01T23:00:00Z"}
        from generate_series(1, ${count}::integer) g
        returning id`;
      await insert("bob", "budgetprobe", 5, "bob");
      await insert("alice", "budgetprobe", 5, "bob");
      await insert("bobChild", "budgetprobe", 5, "alice");
      const target = await insert("alice", "budgetprobe", 1, "alice");
      expect(await search(tx, args(fixture, { query: "budgetprobe", limit: 1 }))).toEqual(sortIds([target[0].id]));

      const overflow = sortIds((await insert("alice2", "overflowprobe", 3, "alice")).map((row) => row.id));
      expect(await search(tx, args(fixture, { query: "overflowprobe", limit: 3 }))).toEqual(overflow);
      expect(await search(tx, args(fixture, { query: "overflowprobe", limit: 2 }))).toEqual(overflow);
      const one = await search(tx, args(fixture, { query: "overflowprobe", limit: 1 }));
      expect(one).toHaveLength(2);
      expect(overflow).toEqual(expect.arrayContaining(one));
    });
  });

  describe("fails closed on unrecognized policy state", () => {
    const INHERITED = `excerpt_inherited_${randomUUID().replaceAll("-", "")}`;
    const privacyCases = [
      ["revoked reader table access", "revoke select on telemetry.events from sherlock_reader"],
      ["a restrictive reader policy", "create policy extra on telemetry.events as restrictive for select to sherlock_reader using (true)"],
      ["an extra permissive reader policy", "create policy extra on telemetry.events for select to sherlock_reader using (true)"],
      ["a PUBLIC policy", "create policy extra on telemetry.sessions for select using (true)"],
      ["an ALL policy for the reader", "create policy extra on telemetry.people for all to sherlock_reader using (true)"],
      ["a policy reached through an inherited role", `
        create role ${INHERITED} nologin;
        grant ${INHERITED} to sherlock_reader;
        create policy extra on telemetry.people for select to ${INHERITED} using (true)`],
      ["an edited reader qualifier", "alter policy sherlock_product_reader on telemetry.people using (true)"],
      ["a reader policy widened to PUBLIC", "alter policy sherlock_product_reader on telemetry.sessions to public"],
      ["a dropped reader policy", "drop policy sherlock_product_reader on telemetry.events"],
      ["forced row security", "alter table telemetry.events force row level security"],
      ["disabled row security", "alter table telemetry.people disable row level security"],
      ["a caller-dependent helper body", `create or replace function sherlock_access.private_principal() returns boolean
        language sql stable security definer set search_path to '' as $f$ select current_user = 'sherlock_aqil_private_login' $f$`],
      ["a changed protected record body", `create or replace function sherlock_access.protected_record_ids() returns setof bigint
        language sql stable security definer set search_path to '' as $f$${HELPERS.protected_record_ids[1]} where n.record_index = 0 $f$`],
      ["a helper search path", "alter function sherlock_access.hidden_session_ids() set search_path = public"],
      ["a security invoker helper", "alter function sherlock_access.protected_person_ids() security invoker"],
      ["a renamed helper", "alter function sherlock_access.private_session_ids() rename to private_session_ids_old"],
      ["PUBLIC search execute", `grant execute on function ${SEARCH} to public`],
      ["anon search execute", `grant execute on function ${SEARCH} to anon`],
      ["a reader grant option", `grant execute on function ${SEARCH} to sherlock_reader with grant option`],
      ["reader gate execute", `grant execute on function ${GATE} to sherlock_reader`],
      ["anon reader membership", "grant sherlock_reader to anon"],
      ["a reader that bypasses RLS", "alter role sherlock_reader bypassrls"],
    ];
    const freshCases = [
      ["revoked reader table access", "revoke select on telemetry.events from sherlock_reader"],
      ["row security without the privacy schema", "alter table telemetry.events enable row level security"],
      ["a policy without the privacy schema", "create policy extra on telemetry.people for select to sherlock_reducer using (true)"],
      ["a partial privacy schema", "create schema sherlock_access"],
    ];

    async function expectGate(withPrivacy, change, expected) {
      await inRollback(sql, async (tx) => {
        if (withPrivacy) await installPrivacyShape(tx);
        await installMigration(tx);
        const fixture = await seedFixture(tx);
        const baseline = await search(tx, args(fixture));
        const outcome = await inSavepoint(tx, async (sp) => {
          await sp.unsafe(change);
          const error = await searchError(sp, args(fixture));
          return error ? { code: error.code, message: error.message } : await search(sp, args(fixture));
        });
        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toEqual(expected === "fail"
          ? { code: "55000", message: "excerpt_search_policy_unrecognized" }
          : baseline);
      });
    }

    it.each(privacyCases)("rejects %s", (_label, change) => expectGate(true, change, "fail"));
    it.each(freshCases)("rejects %s", (_label, change) => expectGate(false, change, "fail"));
    it.each([
      ["a renamed reader policy", "alter policy sherlock_product_reader on telemetry.events rename to renamed_reader"],
      ["a policy for a role the reader cannot use", "create policy worker_read on telemetry.events for select to sherlock_reducer using (true)"],
      ["a reader insert policy", "create policy reader_insert on telemetry.people for insert to sherlock_reader with check (false)"],
    ])("accepts %s", (_label, change) => expectGate(true, change, "pass"));
  });

  it("uses the GIN index for the definer query where reader RLS cannot", async () => {
    // Nested PL/pgSQL plans are invisible to EXPLAIN and auto_explain is not
    // loadable here, so the function's own query text runs against analyzed
    // same-shape copies under the same owner/RLS split; shared tables are not analyzed.
    const plans = await inRollback(sql, async (tx) => {
      await installPrivacyShape(tx);
      await installMigration(tx);
      const [{ prosrc }] = await tx.unsafe(`select prosrc from pg_proc where oid = '${SEARCH}'::regprocedure`);
      const statement = /return query\s+([\s\S]*?limit p_limit \+ 1)/.exec(prosrc)[1];
      await tx.unsafe(`
        create schema excerpt_search_plan;
        create table excerpt_search_plan.people (like telemetry.people including all);
        create table excerpt_search_plan.sessions (like telemetry.sessions including all);
        create table excerpt_search_plan.events (like telemetry.events including all);
        grant usage on schema excerpt_search_plan to ${READER};
        grant select on all tables in schema excerpt_search_plan to ${READER};
      `);
      await installPrivacyShape(tx, { schema: "excerpt_search_plan" });
      const workspace = randomUUID();
      const [person] = await tx`
        insert into excerpt_search_plan.people (workspace_id, identity_key, email)
        values (${workspace}, 'plan', 'plan@e3group.ai') returning id`;
      await tx`
        insert into excerpt_search_plan.sessions (workspace_id, person_id, started_at, actor_role,
          collector_key, native_session_id, role_version)
        select ${workspace}, ${person.id}, ${START}, 'primary', 'excerpt-plan', 'session-' || g, 'test'
        from generate_series(1, 50) g`;
      // 50,000 decoy messages and one rare target.
      await tx`
        insert into excerpt_search_plan.events (workspace_id, session_id, source_record_id, normalizer_version,
          projection_index, source_priority, event_kind, content_excerpt, occurred_at, server_received_at)
        select ${workspace}, s.id, g, 'excerpt-plan', 0, 0, case when g % 5 = 0 then 'agent_message' else 'message' end,
          case when g = 25000 then 'zebrararetoken target' else 'routine decoy chatter ' || g end,
          ${"2026-01-01T06:00:00Z"}::timestamptz, ${"2026-01-01T23:00:00Z"}::timestamptz
        from generate_series(1, 50001) g
        join (select id, row_number() over (order by id) - 1 slot from excerpt_search_plan.sessions) s on s.slot = g % 50`;
      // Flush the GIN fast-update pending list as vacuum does for the production index;
      // a fresh 50k-row pending list makes every GIN scan look expensive.
      await tx`
        select gin_clean_pending_list(i.indexrelid::regclass)
        from pg_index i join pg_class c on c.oid = i.indexrelid join pg_am am on am.oid = c.relam
        where i.indrelid = 'excerpt_search_plan.events'::regclass and am.amname = 'gin'`;
      await tx.unsafe("analyze excerpt_search_plan.people; analyze excerpt_search_plan.sessions; analyze excerpt_search_plan.events;");

      const params = ["p_workspace", "p_start", "p_end", "p_read_at", "p_domain", "p_person", "p_session", "p_limit",
        "v_query", "v_protected_records", "v_hidden_sessions", "v_protected_people"];
      const body = params.reduce(
        (text, name, index) => text.replace(new RegExp(`\\b${name}\\b`, "g"), () => `$${index + 1}`),
        statement.replaceAll("telemetry.", "excerpt_search_plan."),
      );
      expect(body).not.toMatch(/\b[pv]_[a-z_]+\b/);
      await tx.unsafe(`
        set local plan_cache_mode = force_custom_plan;
        prepare excerpt_plan(uuid, timestamptz, timestamptz, timestamptz, text, uuid, uuid, integer,
          tsquery, bigint[], uuid[], uuid[]) as ${body}`);
      const owner = [];
      for (let call = 0; call < 7; call += 1) {
        const [{ "QUERY PLAN": plan }] = await tx.unsafe(`
          explain (analyze, buffers, format json) execute excerpt_plan('${workspace}', '${START}', '${END}', '${READ_AT}',
            'e3group.ai', ${call % 2 ? `'${person.id}'` : "null"}, null, 2000,
            websearch_to_tsquery('simple', 'zebrararetoken'), '{}', '{}', '{}')`);
        owner.push({ rows: plan[0].Plan["Actual Rows"], nodes: planNodes(plan) });
      }
      const direct = `explain (format json) select e.id from excerpt_search_plan.events e
        where e.workspace_id = '${workspace}' and e.event_kind in ('message', 'agent_message')
          and e.message_search @@ websearch_to_tsquery('simple', 'zebrararetoken')`;
      const [{ "QUERY PLAN": ownerDirect }] = await tx.unsafe(direct);
      const reader = await asReader(tx, (sp) => sp.unsafe(direct));
      expect(reader.error).toBeUndefined();
      return { owner, ownerDirect: planNodes(ownerDirect), reader: planNodes(reader.value[0]["QUERY PLAN"]) };
    });

    expect(plans.owner).toHaveLength(7);
    for (const { rows, nodes } of plans.owner) {
      expect(rows).toBe(1);
      expect(usesSearchIndex(nodes)).toBe(true);
      expect(nodes.filter((node) => node["Relation Name"] === "events").map((node) => node["Node Type"]))
        .not.toContain("Seq Scan");
    }
    expect(usesSearchIndex(plans.ownerDirect)).toBe(true);
    // Negative control: the same predicate as the reader cannot use the GIN index under RLS.
    expect(usesSearchIndex(plans.reader)).toBe(false);
    expect(plans.reader.some((node) => node["Relation Name"] === "events" && node["Node Type"] === "Seq Scan")).toBe(true);
  });
});
