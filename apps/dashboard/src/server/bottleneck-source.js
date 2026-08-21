import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import postgres from "postgres";

export const BOTTLENECK_DATABASE_ROLE = "sherlock_bottleneck_writer";
export const BOTTLENECK_PAGE_LIMIT = 20;
export const BOTTLENECK_CURSOR_MAX_LENGTH = 512;
export const BOTTLENECK_ATTRIBUTION_MODE = "workspace_shared_bearer";
export const BOTTLENECK_TRUST = "untrusted_agent_generated_claim";
export const BOTTLENECK_CURSOR_SECRET_MIN_LENGTH = 32;
export const BOTTLENECK_CURSOR_SECRET_MAX_LENGTH = 512;
export const BOTTLENECK_READINESS_SUCCESS_TTL_MS = 30_000;
export const BOTTLENECK_READINESS_UNAVAILABLE_TTL_MS = 1_000;

const CURSOR_VERSION = "b3";
const DECIMAL_BIGINT = /^(?:0|[1-9][0-9]*)$/;
const UUID_TEXT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export class BottleneckSourceError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "BottleneckSourceError";
    this.code = code;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCandidateBatch(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function validateBottleneckCursorSecret(value) {
  if (typeof value !== "string" ||
      value.length < BOTTLENECK_CURSOR_SECRET_MIN_LENGTH ||
      value.length > BOTTLENECK_CURSOR_SECRET_MAX_LENGTH) {
    throw new TypeError(
      `SHERLOCK_MCP_CURSOR_SECRET must contain ${BOTTLENECK_CURSOR_SECRET_MIN_LENGTH} to ` +
      `${BOTTLENECK_CURSOR_SECRET_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BottleneckSourceError("database_result_invalid");
  return date.toISOString();
}

function reportReceipt(row) {
  if (!row) throw new BottleneckSourceError("database_result_invalid");
  return {
    schemaVersion: "bonaparte.bottleneck-report-receipt.v1",
    reportId: String(row.id),
    submissionId: String(row.submission_id),
    requestSha256: String(row.request_sha256),
    candidateCount: Number(row.candidate_count),
    attributionMode: String(row.attribution_mode),
    trust: String(row.trust),
    createdAt: asIso(row.created_at),
  };
}

function evidenceRefs(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error("not_array");
    return parsed;
  } catch {
    throw new BottleneckSourceError("database_result_invalid");
  }
}

function cursorDigest(cursorSecret, body) {
  return createHmac("sha256", cursorSecret)
    .update(`${CURSOR_VERSION}.${body}`, "utf8")
    .digest();
}

function submissionFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID_TEXT.test(value)) {
    throw new BottleneckSourceError("cursor_invalid");
  }
  return value.toLowerCase();
}

export function encodeBottleneckCursor({
  workspaceId,
  highWaterId,
  afterId,
  submissionId = null,
  cursorSecret,
}) {
  validateBottleneckCursorSecret(cursorSecret);
  if (typeof workspaceId !== "string" || !workspaceId ||
      !DECIMAL_BIGINT.test(highWaterId) || !DECIMAL_BIGINT.test(afterId) ||
      BigInt(afterId) > BigInt(highWaterId)) {
    throw new BottleneckSourceError("cursor_invalid");
  }
  const body = Buffer.from(JSON.stringify({
    w: workspaceId,
    h: highWaterId,
    a: afterId,
    s: submissionFilter(submissionId),
  }))
    .toString("base64url");
  const digest = cursorDigest(cursorSecret, body).toString("base64url");
  return `${CURSOR_VERSION}.${body}.${digest}`;
}

export function decodeBottleneckCursor(cursor, {
  workspaceId,
  submissionId = null,
  cursorSecret,
}) {
  validateBottleneckCursorSecret(cursorSecret);
  if (typeof cursor !== "string" || cursor.length === 0 ||
      cursor.length > BOTTLENECK_CURSOR_MAX_LENGTH) {
    throw new BottleneckSourceError("cursor_invalid");
  }
  const [version, body, encodedDigest, extra] = cursor.split(".");
  if (version !== CURSOR_VERSION || !body || !encodedDigest || extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(encodedDigest)) {
    throw new BottleneckSourceError("cursor_invalid");
  }
  try {
    const suppliedDigest = Buffer.from(encodedDigest, "base64url");
    const expectedDigest = cursorDigest(cursorSecret, body);
    if (suppliedDigest.length !== expectedDigest.length ||
        Buffer.from(suppliedDigest).toString("base64url") !== encodedDigest ||
        !timingSafeEqual(suppliedDigest, expectedDigest)) {
      throw new Error("authentication");
    }
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== body) throw new Error("encoding");
    const value = JSON.parse(decoded);
    if (!value || Object.keys(value).sort().join(",") !== "a,h,s,w" ||
        value.w !== workspaceId ||
        value.s !== submissionFilter(submissionId) ||
        !DECIMAL_BIGINT.test(value.h) || !DECIMAL_BIGINT.test(value.a) ||
        BigInt(value.a) > BigInt(value.h)) throw new Error("shape");
    return { highWaterId: value.h, afterId: value.a };
  } catch (error) {
    if (error instanceof BottleneckSourceError) throw error;
    throw new BottleneckSourceError("cursor_invalid");
  }
}

async function run(tx, text, params, signal) {
  if (signal?.aborted) throw new BottleneckSourceError("request_aborted");
  const query = params === undefined ? tx.unsafe(text) : tx.unsafe(text, params);
  const cancel = () => void query.cancel?.().catch?.(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await query;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export class BottleneckSource {
  constructor({ databaseUrl, workspaceId, cursorSecret }) {
    this.workspaceId = workspaceId;
    this.workspaceKey = workspaceId;
    this.cursorSecret = validateBottleneckCursorSecret(cursorSecret);
    this.sql = postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async readiness({ signal } = {}) {
    try {
      return await this.transaction(async (tx) => {
        const row = (await run(tx, `
          with writer as (
            select oid from pg_roles where rolname = current_role
          )
          select current_role = '${BOTTLENECK_DATABASE_ROLE}' as exact_role,
                 session_user = 'sherlock_worker_login' as exact_session_user,
                 current_setting('transaction_read_only') = 'on' as read_only,
                 coalesce((
                   select not rolcanlogin and not rolinherit and not rolsuper
                          and not rolcreatedb and not rolcreaterole
                          and not rolreplication and not rolbypassrls
                          and rolconnlimit = 0
                     from pg_roles where rolname = current_role
                 ), false) as role_posture,
                 coalesce((
                   select rolcanlogin and not rolinherit and not rolsuper
                          and not rolcreatedb and not rolcreaterole
                          and not rolreplication and not rolbypassrls
                     from pg_roles where rolname = session_user
                 ), false) as worker_login_posture,
                 pg_has_role(session_user, '${BOTTLENECK_DATABASE_ROLE}', 'member') as session_member,
                 coalesce((
                   select count(*) = 2
                          and count(*) filter (
                            where member_role.rolname = 'sherlock_worker_login'
                              and grantor_role.oid = (
                                select nspowner from pg_namespace
                                 where nspname = 'product'
                              )
                              and not membership.admin_option
                              and not membership.inherit_option
                              and membership.set_option
                          ) = 1
                          and count(*) filter (
                            where member_role.rolname = 'postgres'
                              and grantor_role.rolname = 'supabase_admin'
                              and membership.admin_option
                              and not membership.inherit_option
                              and not membership.set_option
                          ) = 1
                     from pg_auth_members as membership
                     join pg_roles as granted_role
                       on granted_role.oid = membership.roleid
                     join pg_roles as member_role
                       on member_role.oid = membership.member
                     join pg_roles as grantor_role
                       on grantor_role.oid = membership.grantor
                    where granted_role.rolname = '${BOTTLENECK_DATABASE_ROLE}'
                 ), false) as worker_member,
                 not exists (
                   select 1
                     from pg_auth_members as unsafe_membership
                     join pg_roles as unsafe_member
                       on unsafe_member.oid = unsafe_membership.member
                    where unsafe_member.rolname = current_role
                 ) as role_memberships_absent,
                 to_regclass('product.bottleneck_reports') is not null as reports_exist,
                 to_regclass('product.bottleneck_candidates') is not null as candidates_exist,
                 coalesce((
                   select count(*) = 2
                          and bool_and(
                            column_contract.relpersistence = 'p'
                            and column_contract.column_hash =
                              case column_contract.relname
                                when 'bottleneck_reports' then
                                  'f3c0e5a9a4368028fca03867e1866a75'
                                when 'bottleneck_candidates' then
                                  '016e8ea38ea0d6b491939a97aaa9dee4'
                                else null
                              end
                          )
                     from (
                       select product_table.relname,
                              product_table.relpersistence,
                              md5(jsonb_agg(jsonb_build_array(
                                product_column.attnum,
                                product_column.attname,
                                format_type(
                                  product_column.atttypid,
                                  product_column.atttypmod
                                ),
                                product_column.attnotnull,
                                product_column.attidentity,
                                product_column.attgenerated,
                                coalesce(pg_get_expr(
                                  column_default.adbin,
                                  column_default.adrelid
                                ), ''),
                                case when product_column.attcollation = 0 then ''
                                  else format(
                                    '%I.%I', collation_namespace.nspname,
                                    product_collation.collname
                                  )
                                end
                              ) order by product_column.attnum)::text) as column_hash
                         from pg_class as product_table
                         join pg_namespace as product_namespace
                           on product_namespace.oid = product_table.relnamespace
                         join pg_attribute as product_column
                           on product_column.attrelid = product_table.oid
                          and product_column.attnum > 0
                          and not product_column.attisdropped
                         left join pg_attrdef as column_default
                           on column_default.adrelid = product_column.attrelid
                          and column_default.adnum = product_column.attnum
                         left join pg_collation as product_collation
                           on product_collation.oid = product_column.attcollation
                         left join pg_namespace as collation_namespace
                           on collation_namespace.oid = product_collation.collnamespace
                        where product_namespace.nspname = 'product'
                          and product_table.relname in (
                            'bottleneck_reports', 'bottleneck_candidates'
                          )
                        group by product_table.relname,
                                 product_table.relpersistence
                     ) as column_contract
                 ), false) as column_contract,
                 obj_description(
                   to_regclass('product.bottleneck_reports'), 'pg_class'
                 ) = 'sherlock.bottleneck-product.v1; migration=20260821090000'
                   as migration_receipt,
                 coalesce((
                   select product_namespace.nspowner <> writer.oid
                          and count(*) filter (
                            where schema_acl.grantee = writer.oid
                              and schema_acl.privilege_type = 'USAGE'
                              and not schema_acl.is_grantable
                          ) = 1
                          and count(*) filter (
                            where schema_acl.grantee = writer.oid
                              and schema_acl.privilege_type <> 'USAGE'
                          ) = 0
                          and count(*) filter (
                            where schema_acl.grantee not in (
                              product_namespace.nspowner, writer.oid
                            )
                          ) = 0
                     from pg_namespace as product_namespace
                     cross join writer
                     cross join lateral aclexplode(product_namespace.nspacl) as schema_acl
                    where product_namespace.nspname = 'product'
                    group by product_namespace.nspowner, writer.oid
                 ), false) as product_schema_posture,
                 coalesce(
                   (
                     select count(*) = 3
                            and bool_and(
                              product_function.proowner <> writer.oid
                              and not product_function.prosecdef
                              and (
                                select count(*) = 1
                                       and bool_and(
                                         function_acl.privilege_type = 'EXECUTE'
                                         and not function_acl.is_grantable
                                       )
                                  from aclexplode(product_function.proacl) as function_acl
                                 where function_acl.grantee = writer.oid
                              )
                              and not exists (
                                select 1
                                  from aclexplode(product_function.proacl) as function_acl
                                 where function_acl.grantee not in (
                                   product_function.proowner, writer.oid
                                 )
                              )
                            )
                       from pg_proc as product_function
                       cross join writer
                      where product_function.oid in (
                        to_regprocedure('product.valid_bottleneck_evidence_refs(jsonb)'),
                        to_regprocedure('product.enforce_bottleneck_candidate_count()'),
                        to_regprocedure('product.reject_bottleneck_mutation()')
                      )
                   ),
                   false
                 ) as required_functions_execute,
                 coalesce((
                   select count(*) = 3
                          and bool_and(
                            product_function.proowner = product_namespace.nspowner
                            and product_language.lanname = 'plpgsql'
                            and product_function.prokind = 'f'
                            and not product_function.prosecdef
                            and product_function.proconfig =
                              array['search_path=pg_catalog']::text[]
                            and case product_function.oid
                              when to_regprocedure(
                                'product.valid_bottleneck_evidence_refs(jsonb)'
                              ) then
                                product_function.pronargs = 1
                                and product_function.prorettype = 'boolean'::regtype
                                and product_function.provolatile = 'i'
                                and product_function.proisstrict
                                and md5(product_function.prosrc) =
                                  '7cbea8e215fc261adc13fa4e52e14ad7'
                              when to_regprocedure(
                                'product.enforce_bottleneck_candidate_count()'
                              ) then
                                product_function.pronargs = 0
                                and product_function.prorettype = 'trigger'::regtype
                                and product_function.provolatile = 'v'
                                and not product_function.proisstrict
                                and md5(product_function.prosrc) =
                                  '9724f8fe2f3a7f867399ebc1f88e8874'
                              when to_regprocedure(
                                'product.reject_bottleneck_mutation()'
                              ) then
                                product_function.pronargs = 0
                                and product_function.prorettype = 'trigger'::regtype
                                and product_function.provolatile = 'v'
                                and not product_function.proisstrict
                                and md5(product_function.prosrc) =
                                  '29800e4093732398c0050fbce7fbcd19'
                              else false
                            end
                          )
                     from pg_proc as product_function
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_function.pronamespace
                     join pg_language as product_language
                       on product_language.oid = product_function.prolang
                    where product_function.oid in (
                      to_regprocedure('product.valid_bottleneck_evidence_refs(jsonb)'),
                      to_regprocedure('product.enforce_bottleneck_candidate_count()'),
                      to_regprocedure('product.reject_bottleneck_mutation()')
                    )
                 ), false) as function_integrity,
                 not exists (
                   select 1
                     from pg_proc as product_function
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_function.pronamespace
                    where product_namespace.nspname = 'product'
                      and has_function_privilege(
                        current_role, product_function.oid, 'execute'
                      )
                      and product_function.oid not in (
                        to_regprocedure('product.valid_bottleneck_evidence_refs(jsonb)'),
                        to_regprocedure('product.enforce_bottleneck_candidate_count()'),
                        to_regprocedure('product.reject_bottleneck_mutation()')
                      )
                 ) as product_functions_not_widened,
                 not exists (
                   select 1
                     from pg_class as product_relation
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_relation.relnamespace
                     cross join writer
                    where product_namespace.nspname = 'product'
                      and product_relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
                      and product_relation.relname not in (
                        'bottleneck_reports', 'bottleneck_candidates',
                        'bottleneck_reports_id_seq', 'bottleneck_candidates_id_seq'
                      )
                      and (
                        product_relation.relowner = writer.oid
                        or exists (
                          select 1 from aclexplode(product_relation.relacl) as relation_acl
                           where relation_acl.grantee <> product_relation.relowner
                        )
                      )
                 ) as product_relations_scoped,
                 has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'select')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'insert')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'update')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'delete')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'truncate')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'references')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_reports'), 'trigger')
                   and coalesce((
                     select product_table.relowner <> writer.oid
                            and count(*) filter (
                              where table_acl.grantee = writer.oid
                                and table_acl.privilege_type = 'SELECT'
                                and not table_acl.is_grantable
                            ) = 1
                            and count(*) filter (
                              where table_acl.grantee = writer.oid
                                and (
                                  table_acl.privilege_type <> 'SELECT'
                                  or table_acl.is_grantable
                                )
                            ) = 0
                            and count(*) filter (
                              where table_acl.grantee not in (
                                product_table.relowner, writer.oid
                              )
                            ) = 0
                       from pg_class as product_table
                       cross join writer
                       cross join lateral aclexplode(product_table.relacl) as table_acl
                      where product_table.oid = to_regclass('product.bottleneck_reports')
                      group by product_table.relowner, writer.oid
                   ), false)
                   as reports_posture,
                 has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'select')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'insert')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'update')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'delete')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'truncate')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'references')
                   and not has_table_privilege(current_role, to_regclass('product.bottleneck_candidates'), 'trigger')
                   and coalesce((
                     select product_table.relowner <> writer.oid
                            and count(*) filter (
                              where table_acl.grantee = writer.oid
                                and table_acl.privilege_type = 'SELECT'
                                and not table_acl.is_grantable
                            ) = 1
                            and count(*) filter (
                              where table_acl.grantee = writer.oid
                                and (
                                  table_acl.privilege_type <> 'SELECT'
                                  or table_acl.is_grantable
                                )
                            ) = 0
                            and count(*) filter (
                              where table_acl.grantee not in (
                                product_table.relowner, writer.oid
                              )
                            ) = 0
                       from pg_class as product_table
                       cross join writer
                       cross join lateral aclexplode(product_table.relacl) as table_acl
                      where product_table.oid = to_regclass('product.bottleneck_candidates')
                      group by product_table.relowner, writer.oid
                   ), false)
                   as candidates_posture,
                 coalesce((
                   select count(*) = 16
                          and bool_and(
                            column_acl.grantee = writer.oid
                            and column_acl.privilege_type = 'INSERT'
                            and not column_acl.is_grantable
                            and case product_table.relname
                              when 'bottleneck_reports' then
                                product_column.attname in (
                                  'workspace_id', 'submission_id',
                                  'request_sha256', 'scope_snapshot_token',
                                  'scope_window_start', 'scope_window_end',
                                  'scope_read_at', 'scope_completeness',
                                  'candidate_count'
                                )
                              when 'bottleneck_candidates' then
                                product_column.attname in (
                                  'workspace_id', 'report_id', 'ordinal',
                                  'candidate_key', 'title', 'claim',
                                  'evidence_refs'
                                )
                              else false
                            end
                          )
                     from pg_attribute as product_column
                     join pg_class as product_table
                       on product_table.oid = product_column.attrelid
                     cross join writer
                     cross join lateral aclexplode(product_column.attacl) as column_acl
                    where product_column.attrelid in (
                            to_regclass('product.bottleneck_reports'),
                            to_regclass('product.bottleneck_candidates')
                          )
                      and product_column.attnum > 0
                      and not product_column.attisdropped
                 ), false) as column_insert_posture,
                 has_sequence_privilege(current_role, to_regclass('product.bottleneck_reports_id_seq'), 'select')
                   and has_sequence_privilege(current_role, to_regclass('product.bottleneck_reports_id_seq'), 'usage')
                   and not has_sequence_privilege(current_role, to_regclass('product.bottleneck_reports_id_seq'), 'update')
                   and pg_get_serial_sequence('product.bottleneck_reports', 'id') =
                     'product.bottleneck_reports_id_seq'
                   and coalesce((
                     select product_sequence.relowner <> writer.oid
                            and product_sequence.relpersistence = 'p'
                            and identity_column.attidentity = 'a'
                            and sequence_parameters.seqtypid = 'bigint'::regtype
                            and sequence_parameters.seqstart = 1
                            and sequence_parameters.seqincrement = 1
                            and sequence_parameters.seqmax = 9223372036854775807
                            and sequence_parameters.seqmin = 1
                            and sequence_parameters.seqcache = 1
                            and not sequence_parameters.seqcycle
                            and count(*) filter (
                              where sequence_acl.grantee = writer.oid
                                and sequence_acl.privilege_type in ('SELECT', 'USAGE')
                                and not sequence_acl.is_grantable
                            ) = 2
                            and count(*) filter (
                              where sequence_acl.grantee = writer.oid
                                and (
                                  sequence_acl.privilege_type not in ('SELECT', 'USAGE')
                                  or sequence_acl.is_grantable
                                )
                            ) = 0
                            and count(*) filter (
                              where sequence_acl.grantee not in (
                                product_sequence.relowner, writer.oid
                              )
                            ) = 0
                       from pg_class as product_sequence
                       cross join writer
                       join pg_attribute as identity_column
                         on identity_column.attrelid = to_regclass('product.bottleneck_reports')
                        and identity_column.attname = 'id'
                       join pg_sequence as sequence_parameters
                         on sequence_parameters.seqrelid = product_sequence.oid
                       cross join lateral aclexplode(product_sequence.relacl) as sequence_acl
                      where product_sequence.oid = to_regclass(
                        'product.bottleneck_reports_id_seq'
                      )
                      group by product_sequence.relowner,
                               product_sequence.relpersistence, writer.oid,
                               identity_column.attidentity,
                               sequence_parameters.seqtypid,
                               sequence_parameters.seqstart,
                               sequence_parameters.seqincrement,
                               sequence_parameters.seqmax,
                               sequence_parameters.seqmin,
                               sequence_parameters.seqcache,
                               sequence_parameters.seqcycle
                   ), false)
                   as reports_sequence_posture,
                 has_sequence_privilege(current_role, to_regclass('product.bottleneck_candidates_id_seq'), 'select')
                   and has_sequence_privilege(current_role, to_regclass('product.bottleneck_candidates_id_seq'), 'usage')
                   and not has_sequence_privilege(current_role, to_regclass('product.bottleneck_candidates_id_seq'), 'update')
                   and pg_get_serial_sequence('product.bottleneck_candidates', 'id') =
                     'product.bottleneck_candidates_id_seq'
                   and coalesce((
                     select product_sequence.relowner <> writer.oid
                            and product_sequence.relpersistence = 'p'
                            and identity_column.attidentity = 'a'
                            and sequence_parameters.seqtypid = 'bigint'::regtype
                            and sequence_parameters.seqstart = 1
                            and sequence_parameters.seqincrement = 1
                            and sequence_parameters.seqmax = 9223372036854775807
                            and sequence_parameters.seqmin = 1
                            and sequence_parameters.seqcache = 1
                            and not sequence_parameters.seqcycle
                            and count(*) filter (
                              where sequence_acl.grantee = writer.oid
                                and sequence_acl.privilege_type in ('SELECT', 'USAGE')
                                and not sequence_acl.is_grantable
                            ) = 2
                            and count(*) filter (
                              where sequence_acl.grantee = writer.oid
                                and (
                                  sequence_acl.privilege_type not in ('SELECT', 'USAGE')
                                  or sequence_acl.is_grantable
                                )
                            ) = 0
                            and count(*) filter (
                              where sequence_acl.grantee not in (
                                product_sequence.relowner, writer.oid
                              )
                            ) = 0
                       from pg_class as product_sequence
                       cross join writer
                       join pg_attribute as identity_column
                         on identity_column.attrelid = to_regclass('product.bottleneck_candidates')
                        and identity_column.attname = 'id'
                       join pg_sequence as sequence_parameters
                         on sequence_parameters.seqrelid = product_sequence.oid
                       cross join lateral aclexplode(product_sequence.relacl) as sequence_acl
                      where product_sequence.oid = to_regclass(
                        'product.bottleneck_candidates_id_seq'
                      )
                      group by product_sequence.relowner,
                               product_sequence.relpersistence, writer.oid,
                               identity_column.attidentity,
                               sequence_parameters.seqtypid,
                               sequence_parameters.seqstart,
                               sequence_parameters.seqincrement,
                               sequence_parameters.seqmax,
                               sequence_parameters.seqmin,
                               sequence_parameters.seqcache,
                               sequence_parameters.seqcycle
                   ), false)
                   as candidates_sequence_posture,
                 not has_schema_privilege(current_role, 'telemetry', 'usage')
                   and not has_schema_privilege(current_role, 'telemetry', 'create')
                   and not has_schema_privilege(current_role, 'analytics', 'usage')
                   and not has_schema_privilege(current_role, 'analytics', 'create')
                   and not has_schema_privilege(current_role, 'processing', 'usage')
                   and not has_schema_privilege(current_role, 'processing', 'create')
                   as source_schemas_revoked,
                 not exists (
                   select 1
                     from pg_class as source_relation
                     join pg_namespace as source_namespace
                       on source_namespace.oid = source_relation.relnamespace
                     cross join writer
                    where source_namespace.nspname in (
                            'telemetry', 'analytics', 'processing'
                          )
                      and (
                        source_relation.relowner = writer.oid
                        or exists (
                          select 1 from aclexplode(source_relation.relacl) as source_acl
                           where source_acl.grantee = writer.oid
                        )
                      )
                 )
                   and not exists (
                     select 1
                       from pg_proc as source_function
                       join pg_namespace as source_namespace
                         on source_namespace.oid = source_function.pronamespace
                       cross join writer
                      where source_namespace.nspname in (
                              'telemetry', 'analytics', 'processing'
                            )
                        and (
                          source_function.proowner = writer.oid
                          or exists (
                            select 1 from aclexplode(source_function.proacl) as source_acl
                             where source_acl.grantee = writer.oid
                          )
                        )
                   ) as source_objects_revoked,
                 (
                   select count(*) = 4
                          and bool_and(
                            format_type(product_column.atttypid, product_column.atttypmod) = 'text'
                            and product_column.attgenerated = 's'
                            and pg_get_expr(
                              column_default.adbin, column_default.adrelid
                            ) = case product_column.attname
                              when 'attribution_mode' then '''workspace_shared_bearer''::text'
                              when 'trust' then '''untrusted_agent_generated_claim''::text'
                            end
                          )
                     from pg_attribute as product_column
                     join pg_class as product_table
                       on product_table.oid = product_column.attrelid
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_table.relnamespace
                     left join pg_attrdef as column_default
                       on column_default.adrelid = product_column.attrelid
                      and column_default.adnum = product_column.attnum
                    where product_namespace.nspname = 'product'
                      and product_table.relname in (
                        'bottleneck_reports', 'bottleneck_candidates'
                      )
                      and product_column.attname in ('attribution_mode', 'trust')
                      and not product_column.attisdropped
                 ) as fixed_claim_columns,
                 (
                   select count(*) = 6
                          and bool_and(
                            product_trigger.tgenabled = 'O'
                            and product_trigger.tgqual is null
                            and product_trigger.tgnargs = 0
                            and product_trigger.tgattr = ''::int2vector
                            and product_trigger.tgparentid = 0
                            and case product_table.relname || '.' || product_trigger.tgname
                              when 'bottleneck_reports.bottleneck_reports_immutable' then
                                product_trigger.tgtype = 27
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.reject_bottleneck_mutation()'
                                )
                                and product_trigger.tgconstraint = 0
                                and not product_trigger.tgdeferrable
                                and not product_trigger.tginitdeferred
                              when 'bottleneck_reports.bottleneck_reports_no_truncate' then
                                product_trigger.tgtype = 34
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.reject_bottleneck_mutation()'
                                )
                                and product_trigger.tgconstraint = 0
                                and not product_trigger.tgdeferrable
                                and not product_trigger.tginitdeferred
                              when 'bottleneck_candidates.bottleneck_candidates_immutable' then
                                product_trigger.tgtype = 27
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.reject_bottleneck_mutation()'
                                )
                                and product_trigger.tgconstraint = 0
                                and not product_trigger.tgdeferrable
                                and not product_trigger.tginitdeferred
                              when 'bottleneck_candidates.bottleneck_candidates_no_truncate' then
                                product_trigger.tgtype = 34
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.reject_bottleneck_mutation()'
                                )
                                and product_trigger.tgconstraint = 0
                                and not product_trigger.tgdeferrable
                                and not product_trigger.tginitdeferred
                              when 'bottleneck_reports.bottleneck_reports_exact_candidate_count' then
                                product_trigger.tgtype = 5
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.enforce_bottleneck_candidate_count()'
                                )
                                and product_trigger.tgconstraint <> 0
                                and product_trigger.tgdeferrable
                                and product_trigger.tginitdeferred
                              when 'bottleneck_candidates.bottleneck_candidates_exact_candidate_count' then
                                product_trigger.tgtype = 5
                                and product_trigger.tgfoid = to_regprocedure(
                                  'product.enforce_bottleneck_candidate_count()'
                                )
                                and product_trigger.tgconstraint <> 0
                                and product_trigger.tgdeferrable
                                and product_trigger.tginitdeferred
                              else false
                            end
                          )
                     from pg_trigger as product_trigger
                     join pg_class as product_table
                       on product_table.oid = product_trigger.tgrelid
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_table.relnamespace
                    where product_namespace.nspname = 'product'
                      and product_table.relname in (
                        'bottleneck_reports', 'bottleneck_candidates'
                      )
                      and not product_trigger.tgisinternal
                 ) as critical_triggers,
                 (
                   select count(*) = 9
                          and bool_and(
                            product_constraint.convalidated
                            and not product_constraint.condeferrable
                            and not product_constraint.condeferred
                            and (
                              product_constraint.contype = 'f'
                              or exists (
                                select 1 from pg_index as constraint_index
                                 where constraint_index.indexrelid =
                                         product_constraint.conindid
                                   and constraint_index.indisunique
                                   and constraint_index.indisvalid
                                   and constraint_index.indisready
                                   and constraint_index.indislive
                              )
                            )
                            and case product_table.relname || '.' || product_constraint.conname
                              when 'bottleneck_reports.bottleneck_reports_pkey' then
                                product_constraint.contype = 'p'
                                and product_constraint.conkey = '{1}'::smallint[]
                              when 'bottleneck_reports.bottleneck_reports_workspace_id_id_key' then
                                product_constraint.contype = 'u'
                                and product_constraint.conkey = '{2,1}'::smallint[]
                              when 'bottleneck_reports.bottleneck_reports_workspace_id_submission_id_key' then
                                product_constraint.contype = 'u'
                                and product_constraint.conkey = '{2,3}'::smallint[]
                              when 'bottleneck_reports.bottleneck_reports_workspace_id_fkey' then
                                product_constraint.contype = 'f'
                                and product_constraint.conkey = '{2}'::smallint[]
                                and product_constraint.confrelid =
                                  (
                                    select referenced_table.oid
                                      from pg_class as referenced_table
                                      join pg_namespace as referenced_namespace
                                        on referenced_namespace.oid =
                                           referenced_table.relnamespace
                                     where referenced_namespace.nspname = 'telemetry'
                                       and referenced_table.relname = 'workspaces'
                                  )
                                and product_constraint.confkey = '{1}'::smallint[]
                                and product_constraint.confupdtype = 'a'
                                and product_constraint.confdeltype = 'a'
                                and product_constraint.confmatchtype = 's'
                              when 'bottleneck_candidates.bottleneck_candidates_pkey' then
                                product_constraint.contype = 'p'
                                and product_constraint.conkey = '{1}'::smallint[]
                              when 'bottleneck_candidates.bottleneck_candidates_workspace_id_id_key' then
                                product_constraint.contype = 'u'
                                and product_constraint.conkey = '{2,1}'::smallint[]
                              when 'bottleneck_candidates.bottleneck_candidates_report_id_ordinal_key' then
                                product_constraint.contype = 'u'
                                and product_constraint.conkey = '{3,4}'::smallint[]
                              when 'bottleneck_candidates.bottleneck_candidates_report_id_candidate_key_key' then
                                product_constraint.contype = 'u'
                                and product_constraint.conkey = '{3,5}'::smallint[]
                              when 'bottleneck_candidates.bottleneck_candidates_workspace_id_report_id_fkey' then
                                product_constraint.contype = 'f'
                                and product_constraint.conkey = '{2,3}'::smallint[]
                                and product_constraint.confrelid =
                                  to_regclass('product.bottleneck_reports')
                                and product_constraint.confkey = '{2,1}'::smallint[]
                                and product_constraint.confupdtype = 'a'
                                and product_constraint.confdeltype = 'a'
                                and product_constraint.confmatchtype = 's'
                              else false
                            end
                          )
                     from pg_constraint as product_constraint
                     join pg_class as product_table
                       on product_table.oid = product_constraint.conrelid
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_table.relnamespace
                    where product_namespace.nspname = 'product'
                      and product_table.relname in (
                        'bottleneck_reports', 'bottleneck_candidates'
                      )
                      and product_constraint.contype in ('p', 'u', 'f')
                 ) as critical_constraints,
                 (
                   select count(*) = 18
                          and bool_and(
                            product_check.convalidated
                            and product_check.conislocal
                            and product_check.coninhcount = 0
                            and not product_check.connoinherit
                            and not product_check.condeferrable
                            and not product_check.condeferred
                            and md5(pg_get_expr(
                              product_check.conbin, product_check.conrelid
                            )) = case product_table.relname || '.' || product_check.conname
                              when 'bottleneck_reports.bottleneck_reports_request_sha256_check' then
                                '76283a0b6718e6748134b0d4d4152b98'
                              when 'bottleneck_reports.bottleneck_reports_scope_snapshot_token_check' then
                                '1d8f539474fc619b9146e461cc4c215c'
                              when 'bottleneck_reports.bottleneck_reports_scope_completeness_check' then
                                '176d3ab604eb78670837118e401f8480'
                              when 'bottleneck_reports.bottleneck_reports_candidate_count_check' then
                                'de60cc02913cef93177813ba41868168'
                              when 'bottleneck_reports.bottleneck_reports_id_positive_check' then
                                '971d06b5efd12f11437a2da7ff1087b6'
                              when 'bottleneck_reports.bottleneck_reports_scope_window_start_finite_check' then
                                '4425e5aca9f051b429198ff6aaec3276'
                              when 'bottleneck_reports.bottleneck_reports_scope_window_end_finite_check' then
                                'bef77c038c8f83b2d242489b619b385b'
                              when 'bottleneck_reports.bottleneck_reports_scope_read_at_finite_check' then
                                'e033cf95bad1201a797dc60767f9c3ff'
                              when 'bottleneck_reports.bottleneck_reports_created_at_finite_check' then
                                'b56439f320a65d4cbb40328834698b83'
                              when 'bottleneck_reports.bottleneck_reports_window_bounds_check' then
                                'd66dd9657f10992b317ffa8aeab5baf3'
                              when 'bottleneck_reports.bottleneck_reports_read_at_check' then
                                '1206790d8ef5c2c5554855baaab3d385'
                              when 'bottleneck_candidates.bottleneck_candidates_ordinal_check' then
                                '32d73b0401dd46c62cf7fbc0a7508dde'
                              when 'bottleneck_candidates.bottleneck_candidates_candidate_key_check' then
                                '8cc0c5dbdb0553b5d9901f0d77374881'
                              when 'bottleneck_candidates.bottleneck_candidates_title_check' then
                                'fdf4a23e1a745141adab8e8abbb6b965'
                              when 'bottleneck_candidates.bottleneck_candidates_claim_check' then
                                'c6b7f8fb80f270e2b79d4ed5be6061d8'
                              when 'bottleneck_candidates.bottleneck_candidates_evidence_refs_check' then
                                'd1370229f949a2ae1a39e3f23404e62d'
                              when 'bottleneck_candidates.bottleneck_candidates_id_positive_check' then
                                '971d06b5efd12f11437a2da7ff1087b6'
                              when 'bottleneck_candidates.bottleneck_candidates_created_at_finite_check' then
                                'b56439f320a65d4cbb40328834698b83'
                              else false::text
                            end
                          )
                     from pg_constraint as product_check
                     join pg_class as product_table
                       on product_table.oid = product_check.conrelid
                     join pg_namespace as product_namespace
                       on product_namespace.oid = product_table.relnamespace
                    where product_namespace.nspname = 'product'
                      and product_table.relname in (
                        'bottleneck_reports', 'bottleneck_candidates'
                      )
                      and product_check.contype = 'c'
                 ) as critical_checks
        `, undefined, signal))[0];
        if (!row || Object.values(row).some((value) => value !== true)) {
          throw new BottleneckSourceError("database_role_unsafe");
        }
        return { status: "ok", mode: "sherlock_bottleneck_product" };
      }, { signal, readOnly: true });
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof BottleneckSourceError
          ? `bottleneck_${error.code}`
          : "bottleneck_database_unavailable",
      };
    }
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async transaction(callback, {
    signal,
    readOnly = false,
    readOnlyIsolation = "repeatable read",
  } = {}) {
    if (readOnly && readOnlyIsolation !== "repeatable read" &&
        readOnlyIsolation !== "read committed") {
      throw new TypeError("unsupported read-only transaction isolation");
    }
    try {
      return await this.sql.begin(async (tx) => {
        await run(
          tx,
          readOnly
            ? readOnlyIsolation === "read committed"
              ? "set transaction isolation level read committed, read only"
              : "set transaction isolation level repeatable read, read only"
            : "set transaction isolation level read committed",
          undefined,
          signal,
        );
        await run(tx, "select set_config('statement_timeout', '20000', true)", undefined, signal);
        await run(tx, `set local role ${BOTTLENECK_DATABASE_ROLE}`, undefined, signal);
        return await callback(tx);
      });
    } catch (error) {
      if (error instanceof BottleneckSourceError) throw error;
      if (signal?.aborted) throw new BottleneckSourceError("request_aborted");
      throw new BottleneckSourceError("database_unavailable", { cause: error });
    }
  }

  async submitCandidateBatch(request, { signal } = {}) {
    const normalizedSubmissionId = submissionFilter(request.submissionId);
    const canonicalRequest = {
      ...request,
      submissionId: normalizedSubmissionId,
    };
    const requestSha256 = hashCandidateBatch(canonicalRequest);
    return await this.transaction(async (tx) => {
      await run(tx, "select pg_advisory_xact_lock(hashtextextended($1, 730241))", [this.workspaceId], signal);
      const existing = (await run(tx, `
        select id::text, submission_id::text, request_sha256, candidate_count,
               attribution_mode, trust, created_at
          from product.bottleneck_reports
         where workspace_id = $1 and submission_id = $2
      `, [this.workspaceId, normalizedSubmissionId], signal))[0];
      if (existing) {
        if (existing.request_sha256 !== requestSha256) {
          throw new BottleneckSourceError("idempotency_conflict");
        }
        return reportReceipt(existing);
      }

      const scope = request.analysisScope;
      const inserted = (await run(tx, `
        insert into product.bottleneck_reports (
          workspace_id, submission_id, request_sha256, scope_snapshot_token,
          scope_window_start, scope_window_end, scope_read_at,
          scope_completeness, candidate_count
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id::text, submission_id::text, request_sha256, candidate_count,
                  attribution_mode, trust, created_at
      `, [
        this.workspaceId,
        normalizedSubmissionId,
        requestSha256,
        scope.usageSnapshotToken,
        scope.window.startInclusive,
        scope.window.endExclusive,
        scope.window.readAt,
        scope.completeness,
        request.candidates.length,
      ], signal))[0];

      if (request.candidates.length > 0) {
        await run(tx, `
          insert into product.bottleneck_candidates (
            workspace_id, report_id, ordinal, candidate_key, title, claim, evidence_refs
          )
          select $1, $2, candidate.ordinal, candidate.candidate_key,
                 candidate.title, candidate.claim, candidate.evidence_refs
            from jsonb_to_recordset($3::jsonb) as candidate(
              ordinal integer,
              candidate_key text,
              title text,
              claim text,
              evidence_refs jsonb
            )
           order by candidate.ordinal
        `, [
          this.workspaceId,
          inserted.id,
          tx.json(request.candidates.map((candidate, ordinal) => ({
            ordinal,
            candidate_key: candidate.candidateKey,
            title: candidate.title,
            claim: candidate.claim,
            evidence_refs: candidate.evidence,
          }))),
        ], signal);
      }
      return reportReceipt(inserted);
    }, { signal });
  }

  async listBottleneckCandidates({ cursor = "", submissionId = null, signal } = {}) {
    const normalizedSubmissionId = submissionFilter(submissionId);
    const requestedBoundary = cursor
      ? decodeBottleneckCursor(cursor, {
        workspaceId: this.workspaceId,
        submissionId: normalizedSubmissionId,
        cursorSecret: this.cursorSecret,
      })
      : null;
    return await this.transaction(async (tx) => {
      let boundary;
      if (requestedBoundary) {
        boundary = requestedBoundary;
      } else {
        await run(tx, "select pg_advisory_xact_lock(hashtextextended($1, 730241))", [this.workspaceId], signal);
        const row = (await run(tx, `
          select coalesce(max(c.id), 0)::text high_water_id
            from product.bottleneck_candidates c
            join product.bottleneck_reports r
              on r.workspace_id = c.workspace_id and r.id = c.report_id
           where c.workspace_id = $1
             and ($2::uuid is null or r.submission_id = $2::uuid)
        `, [this.workspaceId, normalizedSubmissionId], signal))[0];
        boundary = { highWaterId: String(row?.high_water_id ?? "0"), afterId: "0" };
      }
      const rows = await run(tx, `
        select c.id::text candidate_id, c.report_id::text, c.ordinal,
               c.candidate_key, c.title, c.claim, c.evidence_refs,
               c.attribution_mode, c.trust, c.created_at,
               r.submission_id::text, r.scope_snapshot_token,
               r.scope_window_start, r.scope_window_end, r.scope_read_at,
               r.scope_completeness
          from product.bottleneck_candidates c
          join product.bottleneck_reports r
            on r.workspace_id = c.workspace_id and r.id = c.report_id
         where c.workspace_id = $1 and c.id > $2::bigint and c.id <= $3::bigint
           and ($4::uuid is null or r.submission_id = $4::uuid)
         order by c.id asc
         limit $5
      `, [
        this.workspaceId,
        boundary.afterId,
        boundary.highWaterId,
        normalizedSubmissionId,
        BOTTLENECK_PAGE_LIMIT + 1,
      ], signal);
      const hasMore = rows.length > BOTTLENECK_PAGE_LIMIT;
      const selected = hasMore ? rows.slice(0, BOTTLENECK_PAGE_LIMIT) : rows;
      const candidates = selected.map((row) => ({
        candidateId: String(row.candidate_id),
        reportId: String(row.report_id),
        submissionId: String(row.submission_id),
        ordinal: Number(row.ordinal),
        candidateKey: String(row.candidate_key),
        title: String(row.title),
        claim: String(row.claim),
        evidence: evidenceRefs(row.evidence_refs),
        analysisScope: {
          usageSnapshotToken: String(row.scope_snapshot_token),
          window: {
            startInclusive: asIso(row.scope_window_start),
            endExclusive: asIso(row.scope_window_end),
            readAt: asIso(row.scope_read_at),
          },
          completeness: String(row.scope_completeness),
        },
        attributionMode: String(row.attribution_mode),
        trust: String(row.trust),
        createdAt: asIso(row.created_at),
      }));
      return {
        schemaVersion: "bonaparte.bottleneck-candidates.v1",
        candidates,
        nextCursor: hasMore
          ? encodeBottleneckCursor({
            workspaceId: this.workspaceId,
            highWaterId: boundary.highWaterId,
            afterId: candidates.at(-1).candidateId,
            submissionId: normalizedSubmissionId,
            cursorSecret: this.cursorSecret,
          })
          : null,
      };
    }, {
      signal,
      readOnly: true,
      readOnlyIsolation: "read committed",
    });
  }
}

export function createBottleneckReadinessGate(source, {
  now = Date.now,
  successTtlMs = BOTTLENECK_READINESS_SUCCESS_TTL_MS,
  unavailableTtlMs = BOTTLENECK_READINESS_UNAVAILABLE_TTL_MS,
} = {}) {
  if (typeof source?.readiness !== "function") {
    throw new TypeError("A bottleneck source with readiness is required");
  }
  let pending = null;
  let cached = null;
  let expiresAt = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    async readiness(options) {
      if (cached && now() < expiresAt) return cached;
      if (!pending) {
        pending = Promise.resolve()
          .then(() => source.readiness(options))
          .then((receipt) => {
            cached = receipt;
            expiresAt = now() + (
              receipt?.status === "ok" ? successTtlMs : unavailableTtlMs
            );
            return receipt;
          })
          .finally(() => {
            pending = null;
          });
      }
      return await pending;
    },
  });
}
