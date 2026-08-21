import { createHash } from "node:crypto";

import postgres from "postgres";

export const BOTTLENECK_DATABASE_ROLE = "sherlock_bottleneck_writer";
export const BOTTLENECK_ATTRIBUTION_MODE = "workspace_shared_bearer";
export const BOTTLENECK_TRUST = "unverified_client_claim";

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

export function hashCandidateBatch({ method, candidates }) {
  return createHash("sha256")
    .update(canonicalJson({ method, candidates }), "utf8")
    .digest("hex");
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BottleneckSourceError("database_result_invalid");
  }
  return date.toISOString();
}

function json(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new BottleneckSourceError("database_result_invalid");
  }
}

function rowValue(row) {
  const candidates = json(row?.candidates);
  if (!row || !/^[0-9a-f]{64}$/.test(String(row.request_sha256)) ||
      !Array.isArray(candidates) || !json(row.method) ||
      row.attribution_mode !== BOTTLENECK_ATTRIBUTION_MODE ||
      row.trust !== BOTTLENECK_TRUST || row.client_claims_verified !== false) {
    throw new BottleneckSourceError("database_result_invalid");
  }
  return {
    schemaVersion: "bonaparte.candidate-batch-receipt.v1",
    submissionId: String(row.submission_id),
    requestSha256: String(row.request_sha256),
    candidateCount: candidates.length,
    server: {
      attributionMode: String(row.attribution_mode),
      trust: String(row.trust),
      clientClaimsVerified: false,
      createdAt: iso(row.created_at),
    },
  };
}

function sameJson(left, right) {
  return canonicalJson(json(left)) === canonicalJson(right);
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
  constructor({ databaseUrl, workspaceId, writesEnabled = false }) {
    this.workspaceId = workspaceId;
    this.writesEnabled = writesEnabled;
    this.sql = postgres(databaseUrl, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async transaction(callback, { signal, readOnly = false } = {}) {
    try {
      return await this.sql.begin(async (tx) => {
        await run(tx, readOnly
          ? "set transaction isolation level read committed, read only"
          : "set transaction isolation level read committed", undefined, signal);
        await run(tx, "set local statement_timeout = '20s'", undefined, signal);
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
    if (!this.writesEnabled) throw new BottleneckSourceError("writes_disabled");
    const requestSha256 = hashCandidateBatch(request);
    return await this.transaction(async (tx) => {
      const params = [
        this.workspaceId,
        request.submissionId,
        requestSha256,
        tx.json(request.method),
        tx.json(request.candidates),
      ];
      const inserted = (await run(tx, `
        insert into product.bottleneck_submissions (
          workspace_id, submission_id, request_sha256, method, candidates
        ) values ($1, $2, $3, $4, $5)
        on conflict (workspace_id, submission_id) do nothing
        returning submission_id::text, request_sha256, method, candidates,
                  attribution_mode, trust, client_claims_verified, created_at
      `, params, signal))[0];
      if (inserted) return rowValue(inserted);

      const existing = (await run(tx, `
        select submission_id::text, request_sha256, method, candidates,
               attribution_mode, trust, client_claims_verified, created_at
          from product.bottleneck_submissions
         where workspace_id = $1 and submission_id = $2
      `, [this.workspaceId, request.submissionId], signal))[0];
      if (!existing || existing.request_sha256 !== requestSha256 ||
          !sameJson(existing.method, request.method) ||
          !sameJson(existing.candidates, request.candidates)) {
        throw new BottleneckSourceError("idempotency_conflict");
      }
      return rowValue(existing);
    }, { signal });
  }

  async getCandidateBatch({ submissionId, signal } = {}) {
    return await this.transaction(async (tx) => {
      const row = (await run(tx, `
        select submission_id::text, request_sha256, method, candidates,
               attribution_mode, trust, client_claims_verified, created_at
          from product.bottleneck_submissions
         where workspace_id = $1 and submission_id = $2
      `, [this.workspaceId, submissionId], signal))[0];
      if (!row) throw new BottleneckSourceError("not_found");
      return { ...rowValue(row), method: json(row.method), candidates: json(row.candidates) };
    }, { signal, readOnly: true });
  }
}
