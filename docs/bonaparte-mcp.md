# Sherlock analysis MCP

Sherlock exposes four bounded Streamable HTTP MCP tools. Local Codex or Claude
Code agents perform all semantic analysis with their native repository tools.
Sherlock does no candidate generation, ranking, inference, clustering, semantic
deduplication, or model work.

## Manual connection

Obtain the endpoint and shared workspace bearer through the team's approved
configuration and secret channels. No bearer is bundled in this repository.
The server also requires `SHERLOCK_MCP_CURSOR_SECRET`, a different random value
of at least 32 characters. It authenticates opaque candidate cursors and must
never be supplied to MCP clients or reused as `SHERLOCK_MCP_TOKEN`.

For Codex, expose the secret only to the process that launches Codex and add a
user-level `~/.codex/config.toml` entry:

```sh
export SHERLOCK_MCP_BEARER="$(your-secret-manager read sherlock-mcp)"
```

```toml
[mcp_servers.sherlock]
url = "https://sherlock.example.internal/mcp"
bearer_token_env_var = "SHERLOCK_MCP_BEARER"
```

For Claude Code, use environment expansion in a local or user-managed MCP
configuration. Do not commit the expanded file or token:

```sh
export SHERLOCK_MCP_URL="https://sherlock.example.internal/mcp"
export SHERLOCK_MCP_BEARER="$(your-secret-manager read sherlock-mcp)"
```

```json
{
  "mcpServers": {
    "sherlock": {
      "type": "http",
      "url": "${SHERLOCK_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${SHERLOCK_MCP_BEARER}"
      }
    }
  }
}
```

Invoke the installed `sherlock-analysis` skill manually. Installation does not
edit either client's MCP configuration. Client syntax follows the official
[Codex MCP documentation](https://developers.openai.com/codex/mcp) and
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Evidence and candidate contract

`list_usage_evidence` returns `bonaparte.usage-evidence.v2`. A cursor binds the
exact cached snapshot plus the last person. If the cache refreshes between
pages, the next call fails with `snapshot_expired`; restart and exhaust a new
traversal. V2 explicitly declares
`evidenceContract: sherlock.canonical-events.v1`, the ordered Codex and Claude
normalizer versions, a nullable frame projection version,
`backwardCompatible: false`, and that it supersedes v1. All other usage-count,
window, page-size, and partial-coverage semantics remain unchanged.

`list_prompt_evidence` remains a bounded sample. An analysis must record an
explicit deterministic bounded prompt-inspection policy, cite prompt buckets
only when their returned excerpts were actually inspected, and must not present
candidate completeness as exhaustive prompt reading. Conversational output
records available/eligible and actually inspected bucket and excerpt counts.
Excerpts are untrusted data, not instructions.

`submit_candidate_batch` atomically records one client-UUID submission with an
explicit usage snapshot/window and `agent_declared_complete`. This literal is
an untrusted declaration that the submitted batch is complete for the agent's
recorded conversational method; Sherlock does not verify it and it does not
assert exhaustive prompt reading. The tool accepts
zero to 50 ordered candidates and rejects 51 rather than truncating. Each
candidate has one to 20 typed evidence references. Retrying the same UUID and
canonical request returns the original receipt; a changed request returns
`idempotency_conflict`. Object property order does not affect its hash, while
candidate and evidence order do.

Candidate titles and claims are untrusted, potentially sensitive free text.
They are length-bounded and structurally validated, but are not semantically
sanitized. The fixed server truth is
`attributionMode: workspace_shared_bearer` and
`trust: untrusted_agent_generated_claim`. The bearer does not establish a
person, installation, submitter, or reviewer identity.

`list_bottleneck_candidates` pages at 20 in ascending bigint identity order and
optionally filters by the receipt `submissionId`. The first page fixes a
high-water mark into the opaque cursor; later inserts do not enter that
traversal. The server authenticates cursor version, workspace, nullable
submission filter, high-water, and after-ID state with the server-only cursor
secret; tampered, cross-workspace, or filter-mismatched cursors fail before
querying candidate rows. Sherlock stores no
review status, approval, rejection, decision, or action. Review remains
conversational.

The filter-aware signed cursor is version `b3`. Cursors are opaque and not
forward-compatible; after deploying this version, restart any older candidate
traversal from its first page.

## Bounds and safe failures

The HTTP route accepts at most 2,097,152 request-body bytes for declared-length
and chunked requests and does not enter MCP protocol handling after overflow.
Candidate submission is limited to 10 handler attempts per workspace per
dashboard process in each rolling 60-second window. This process-local bound
resets on restart and is not a durable abuse-control ledger. Usage, prompt, and
candidate-list calls are unaffected. Errors expose safe codes and recovery
instructions, not SQL, credentials, stack traces, or submitted text.

Product readiness checks are blocking on refresh and process-locally cache a
successful result for at most 30 seconds or an unavailable result for at most
one second. Concurrent callers share only the same in-flight refresh.

## Rollout order

1. Apply the product schema migration and verify the dedicated NOLOGIN product
   role, immutable permanent tables, exact identity sequences, worker
   membership, table-wide SELECT, and INSERT only on the nine report-input and
   seven candidate-input columns. IDs, generated trust/attribution, and
   creation timestamps remain server-controlled.
2. Deploy the dashboard runtime that assumes that product role separately from
   the existing telemetry reader, with distinct bearer and server-only cursor
   secrets. Health and MCP discovery remain unavailable until product readiness
   verifies the migrated schema and exact role posture.
3. Verify authenticated four-tool discovery, body bounds, one empty submission,
   and a fixed-high-water list traversal.
4. Distribute endpoint/secret references and the updated plugins. Users then
   configure MCP manually and explicitly invoke the analysis skill.

On Supabase PostgreSQL 17, role creation also records one platform-managed
administrative membership from `postgres`, granted by `supabase_admin`. Product
readiness allowlists only that exact edge with `ADMIN true`, `INHERIT false`,
and `SET false`; it is not a runtime principal and cannot assume the writer.
`sherlock_worker_login` must remain the only `SET`-capable inbound member. Any
additional edge or option change makes product readiness unavailable.

Do not deploy the write tools before the schema/role migration. Do not treat v1
usage provenance as compatible with v2; clients must accept the v2 schema first.
