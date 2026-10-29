import {
  type BatchManifest,
  CONTRACT_VERSION,
  IngestError,
  sha256Hex,
} from "./contract.ts";
import {
  DATABASE_ATTEMPTS,
  DATABASE_RETRY_WINDOW_MS,
  handleRequest,
  ingestDatabaseUrl,
  parseWorkloadClassHint,
} from "./index.ts";
import {
  exclusionsError,
  isDatabaseConnectionError,
  PostgresBatchRepository,
} from "./postgres.ts";
import { IngestService } from "./service.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("ingest uses its custom pooler URL despite injected direct database URL", () => {
  const variables: Record<string, string> = {
    SHERLOCK_INGEST_DATABASE_URL:
      "postgresql://postgres.project:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require",
    SUPABASE_DB_URL:
      "postgresql://postgres:injected-secret@db.project.supabase.co:5432/postgres",
  };
  const url = new URL(ingestDatabaseUrl((name) => variables[name]));
  assert(url.hostname === "aws-0-us-east-1.pooler.supabase.com");
  assert(url.port === "6543");
  assert(url.username === "postgres.project" && url.password === "secret");
  assert(url.searchParams.get("sslmode") === "require");
});

Deno.test("ingest configuration fails actionably without exposing credentials", () => {
  for (
    const [value, message] of [
      [undefined, "SHERLOCK_INGEST_DATABASE_URL is required"],
      ["", "SHERLOCK_INGEST_DATABASE_URL is required"],
      [
        "not-a-url:secret",
        "SHERLOCK_INGEST_DATABASE_URL must be a valid Postgres URL",
      ],
      [
        "https://user:secret@example.com/db",
        "SHERLOCK_INGEST_DATABASE_URL must be a valid Postgres URL",
      ],
      [
        "postgresql://postgres:secret@db.project.supabase.co:5432/postgres",
        "SHERLOCK_INGEST_DATABASE_URL must use the Supabase transaction pooler (port 6543)",
      ],
    ] as const
  ) {
    let thrown: unknown;
    try {
      ingestDatabaseUrl((name) =>
        name === "SHERLOCK_INGEST_DATABASE_URL"
          ? value
          : "postgresql://postgres:injected-secret@db.project.supabase.co/postgres"
      );
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof IngestError);
    assert(thrown.status === 500 && thrown.code === "invalid_configuration");
    assert(thrown.message === message);
    assert(!thrown.message.includes("secret"));
  }
});

Deno.test("ingest supports explicit local Postgres configuration", () => {
  const local = "postgresql://postgres:local@127.0.0.1:54322/postgres";
  assert(ingestDatabaseUrl(() => local) === local);
});

Deno.test("workload class header is optional and strictly bounded", () => {
  assert(parseWorkloadClassHint(null) === null);
  assert(parseWorkloadClassHint("") === null);
  assert(parseWorkloadClassHint("live") === "live");
  assert(parseWorkloadClassHint("backfill") === "backfill");
  let rejected = false;
  try {
    parseWorkloadClassHint("urgent");
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown scheduling classes must be rejected");
});

async function requestFor(email: string): Promise<Request> {
  const source = new TextEncoder().encode("test\n");
  const compressed = new Blob([source]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const stored = new Uint8Array(await new Response(compressed).arrayBuffer());
  const body = {
    collector: {
      name: "Test User",
      github_id: "test-user",
      email,
      installation_id: "00000000-0000-4000-8000-000000000001",
    },
    manifest: {
      contract_version: CONTRACT_VERSION,
      source_provider: "codex",
      source_kind: "rollout",
      source_stream_key: "stream-test",
      generation_key: "generation-test",
      generation_seq: 0,
      start_offset: 0,
      end_offset: source.byteLength,
      source_byte_count: source.byteLength,
      source_sha256: await sha256Hex(source),
      storage_encoding: "gzip",
      stored_byte_count: stored.byteLength,
      stored_sha256: await sha256Hex(stored),
      record_count: 1,
      records: [{
        record_index: 0,
        source_start_offset: 0,
        source_end_offset: source.byteLength,
        record_sha256: await sha256Hex(source),
        native_type: "event",
        native_payload_type: null,
        occurred_at: null,
        parse_status: "ok",
      }],
      observed_native_session_id: null,
      observed_parent_native_session_id: null,
      first_occurred_at: null,
      last_occurred_at: null,
      codex_version: null,
      source_version: null,
      collector_version: "test",
    },
    stored_payload_base64: btoa(String.fromCharCode(...stored)),
  };
  return new Request("https://example.test/ingest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("unknown collector domain is rejected before backend initialization", async () => {
  let backendCalls = 0;
  const response = await handleRequest(
    await requestFor("outsider@example.com"),
    {
      environment: (name) =>
        ({
          SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
          SHERLOCK_SIXTYFOUR_WORKSPACE_ID:
            "00000000-0000-4000-8000-000000000002",
        })[name],
      backendFactory: (() => {
        backendCalls += 1;
        throw new Error("backend must not initialize");
      }) as never,
    },
  );

  assert(response.status === 403);
  assert(response.headers.get("Cache-Control") === "no-store");
  assert((await response.json()).error.code === "collector_domain_forbidden");
  assert(backendCalls === 0);
});

Deno.test("handler passes the server-selected workspace for each approved domain", async () => {
  for (
    const [email, expectedWorkspaceId] of [
      ["USER@E3GROUP.AI", "00000000-0000-4000-8000-000000000001"],
      ["user@sixtyfour.ai", "00000000-0000-4000-8000-000000000002"],
    ]
  ) {
    let selectedWorkspaceId = "";
    const response = await handleRequest(await requestFor(email), {
      environment: (name) =>
        ({
          SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
          SHERLOCK_SIXTYFOUR_WORKSPACE_ID:
            "00000000-0000-4000-8000-000000000002",
        })[name],
      backendFactory: (() => ({
        batches: {
          resolveAttribution: (grant: { workspace_id: string }) => {
            selectedWorkspaceId = grant.workspace_id;
            return Promise.resolve({
              workspace_id: grant.workspace_id,
              person_id: "00000000-0000-4000-8000-000000000003",
              collector_key: "team-test",
            });
          },
        },
        service: {
          ingest: (attribution: Record<string, string>) =>
            Promise.resolve({ status: "committed", ...attribution }),
        },
      })) as never,
    });

    assert(response.status === 200);
    assert(selectedWorkspaceId === expectedWorkspaceId);
    assert((await response.json()).workspace_id === expectedWorkspaceId);
  }
});

const ENVIRONMENT = (name: string) =>
  ({
    SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
    SHERLOCK_SIXTYFOUR_WORKSPACE_ID: "00000000-0000-4000-8000-000000000002",
  })[name];
const ROOT = "0199f0b4-1c2d-7a3e-8f40-123456789abc";
const CHILD = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function exclusionsRequest(
  ids: unknown,
  email = "owner@e3group.ai",
  op: unknown = "exclusions",
): Request {
  return new Request("https://example.test/ingest", {
    method: "POST",
    body: JSON.stringify({
      op,
      collector: {
        name: "Owner",
        github_id: "owner",
        email,
        installation_id: "00000000-0000-4000-8000-000000000009",
      },
      excluded_session_ids: ids,
    }),
  });
}

function exclusionsBackend(
  calls: { attribution: unknown; ids: readonly string[] }[],
  result: () => Promise<{ accepted: number; total: number }> = () =>
    Promise.resolve({ accepted: 1, total: 2 }),
) {
  return (() => ({
    batches: {
      resolveAttribution: (grant: { workspace_id: string }) =>
        Promise.resolve({
          workspace_id: grant.workspace_id,
          person_id: "00000000-0000-4000-8000-000000000003",
          collector_key: "team-owner",
        }),
      recordOwnerExclusions: (
        attribution: unknown,
        ids: readonly string[],
      ) => {
        calls.push({ attribution, ids });
        return result();
      },
    },
    service: {
      ingest: () => {
        throw new Error("exclusions must not ingest a batch");
      },
    },
  })) as never;
}

Deno.test("exclusions are recorded for the authenticated collector only", async () => {
  const calls: { attribution: unknown; ids: readonly string[] }[] = [];
  const response = await handleRequest(
    exclusionsRequest([ROOT.toUpperCase(), CHILD, ROOT]),
    { environment: ENVIRONMENT, backendFactory: exclusionsBackend(calls) },
  );
  assert(response.status === 200);
  assert(response.headers.get("Cache-Control") === "no-store");
  const body = await response.json();
  assert(body.accepted === 1 && body.total === 2);
  assert(Object.keys(body).sort().join() === "accepted,total");
  assert(calls.length === 1);
  const attribution = calls[0].attribution as Record<string, string>;
  assert(attribution.workspace_id === "00000000-0000-4000-8000-000000000001");
  assert(attribution.person_id === "00000000-0000-4000-8000-000000000003");
  assert(calls[0].ids.join() === [ROOT, CHILD].sort().join());
});

Deno.test("invalid exclusions are rejected before backend initialization", async () => {
  const cases: [Request, number, string][] = [
    [exclusionsRequest(["not-a-uuid"]), 400, "invalid_exclusions"],
    [exclusionsRequest([42]), 400, "invalid_exclusions"],
    [exclusionsRequest(ROOT), 400, "invalid_exclusions"],
    [exclusionsRequest([`${ROOT} `]), 400, "invalid_exclusions"],
    [
      exclusionsRequest(Array.from({ length: 5001 }, () => ROOT)),
      413,
      "payload_too_large",
    ],
    [
      exclusionsRequest([ROOT], "outsider@example.com"),
      403,
      "collector_domain_forbidden",
    ],
    [
      exclusionsRequest([ROOT], "owner@e3group.ai", "delete"),
      400,
      "unsupported_operation",
    ],
  ];
  for (const [request, status, code] of cases) {
    let backendCalls = 0;
    const response = await handleRequest(request, {
      environment: ENVIRONMENT,
      backendFactory: (() => {
        backendCalls += 1;
        throw new Error("backend must not initialize");
      }) as never,
    });
    assert(response.status === status, `${code}: ${response.status}`);
    assert((await response.json()).error.code === code);
    assert(backendCalls === 0);
  }
});

Deno.test("exactly 5000 exclusions and an empty report are accepted", async () => {
  for (const ids of [Array.from({ length: 5000 }, () => ROOT), []]) {
    const calls: { attribution: unknown; ids: readonly string[] }[] = [];
    const response = await handleRequest(exclusionsRequest(ids), {
      environment: ENVIRONMENT,
      backendFactory: exclusionsBackend(calls),
    });
    assert(response.status === 200);
    assert(calls[0].ids.length === Math.min(ids.length, 1));
  }
});

Deno.test("repository failures map to stable exclusion error codes", async () => {
  for (
    const [error, status, code] of [
      [
        Object.assign(new Error("x"), { code: "3F000" }),
        503,
        "exclusions_unavailable",
      ],
      [
        Object.assign(new Error("x"), { code: "42883" }),
        503,
        "exclusions_unavailable",
      ],
      [
        Object.assign(new Error("owner_exclusions_unknown_person"), {
          code: "22023",
        }),
        400,
        "invalid_exclusions",
      ],
      [new Error("boom"), 500, "internal_error"],
    ] as [Error, number, string][]
  ) {
    const response = await handleRequest(exclusionsRequest([ROOT]), {
      environment: ENVIRONMENT,
      backendFactory: exclusionsBackend(
        [],
        () => Promise.reject(exclusionsError(error)),
      ),
    });
    assert(response.status === status, `${code}: ${response.status}`);
    assert((await response.json()).error.code === code);
  }
});

Deno.test("the repository records as the ingest role with a text array", async () => {
  const statements: [string, unknown[] | undefined][] = [];
  const tx = {
    unsafe: (query: string, parameters?: unknown[]) => {
      statements.push([query, parameters]);
      return Promise.resolve(
        query.includes("record_owner_session_exclusions")
          ? [{ accepted: 2, total: 2 }]
          : [],
      );
    },
  };
  const repository = new PostgresBatchRepository({
    begin: (work: (value: typeof tx) => Promise<unknown>) => work(tx),
  } as never);
  const receipt = await repository.recordOwnerExclusions(
    {
      workspace_id: "00000000-0000-4000-8000-000000000001",
      person_id: "00000000-0000-4000-8000-000000000003",
    },
    [CHILD, ROOT],
  );
  assert(receipt.accepted === 2 && receipt.total === 2);
  assert(statements[0][0] === "set local role sherlock_ingest");
  assert(statements[1][1]?.[2] === `{${CHILD},${ROOT}}`);
});

function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} pooler:6543`), { code });
}

const ATTRIBUTION = {
  workspace_id: "00000000-0000-4000-8000-000000000001",
  person_id: "00000000-0000-4000-8000-000000000003",
  collector_key: "team-test",
};

function retryOptions(
  backendFactory: () => unknown,
  { elapsedPerAttemptMs = 0 } = {},
) {
  const record = { discarded: 0, sleeps: [] as number[] };
  let clock = 0;
  return {
    record,
    options: {
      environment: ENVIRONMENT,
      backendFactory: backendFactory as never,
      discardBackend: () => {
        record.discarded += 1;
        clock += elapsedPerAttemptMs;
      },
      sleep: (milliseconds: number) => {
        record.sleeps.push(milliseconds);
        return Promise.resolve();
      },
      now: () => clock,
    },
  };
}

Deno.test("connection-level failures are classified as retryable", () => {
  for (
    const code of [
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      "CONNECTION_DESTROYED",
      "ECONNRESET",
      "EBADF",
      "08006",
      "57P01",
      "53300",
    ]
  ) {
    assert(isDatabaseConnectionError(connectionError(code)), code);
  }
  const supavisor = Object.assign(
    new Error("(EDBHANDLEREXITED) connection to database closed"),
    { code: "XX000" },
  );
  assert(isDatabaseConnectionError(supavisor));
  const nextWrite = new TypeError(
    "Cannot read properties of null (reading 'write')",
  );
  nextWrite.stack =
    `TypeError: Cannot read properties of null (reading 'write')\n    at nextWrite (file:///var/tmp/sb-compile-edge-runtime/node_modules/localhost/postgres/3.4.7/src/connection.js:255:22)`;
  assert(isDatabaseConnectionError(nextWrite));

  for (
    const error of [
      new TypeError("Cannot read properties of null (reading 'write')"),
      Object.assign(new Error("canceling statement"), { code: "57014" }),
      Object.assign(new Error("internal"), { code: "XX000" }),
      Object.assign(new Error("(ENOTFOUND) Tenant or user not found"), {
        code: "XX000",
      }),
      Object.assign(new TypeError("x.map is not a function"), {
        stack:
          "TypeError: x.map is not a function\n    at handle (file:///node_modules/postgres/3.4.7/src/connection.js:1:1)",
      }),
      new IngestError("range_overlap", "overlap", 409),
      new Error("boom"),
      "CONNECT_TIMEOUT",
      null,
    ]
  ) {
    assert(!isDatabaseConnectionError(error), String(error));
  }
});

Deno.test("a connection failure is retried on a fresh backend", async () => {
  let factoryCalls = 0;
  const { record, options } = retryOptions(() => {
    factoryCalls += 1;
    const attempt = factoryCalls;
    return {
      batches: {
        resolveAttribution: () =>
          attempt === 1
            ? Promise.reject(connectionError("CONNECT_TIMEOUT"))
            : Promise.resolve(ATTRIBUTION),
      },
      service: {
        ingest: (attribution: Record<string, string>) =>
          Promise.resolve({ status: "committed", ...attribution }),
      },
    };
  });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 200, `status ${response.status}`);
  assert(factoryCalls === 2 && record.discarded === 1);
  assert(record.sleeps.length === 1 && record.sleeps[0] >= 200);
  assert(record.sleeps[0] < 500);
});

Deno.test("a retried identical batch returns its receipt, not a 409", async () => {
  // The first attempt commits, then the pooler drops the socket before the
  // response arrives. The retry must find the exact committed range.
  let committed: Record<string, unknown> | null = null;
  let commits = 0;
  let lostResponse = false;
  let uploads = 0;
  const batches = {
    resolveAttribution: () => Promise.resolve(ATTRIBUTION),
    findExact: () => Promise.resolve(committed),
    commit: (attribution: typeof ATTRIBUTION, manifest: BatchManifest) => {
      commits += 1;
      if (committed) {
        return Promise.reject(
          new IngestError("range_overlap", "overlap", 409),
        );
      }
      committed = {
        ...attribution,
        status: "committed",
        batch_id: "00000000-0000-4000-8000-0000000000b1",
        end_offset: manifest.end_offset,
      };
      if (!lostResponse) {
        lostResponse = true;
        return Promise.reject(connectionError("CONNECTION_CLOSED"));
      }
      return Promise.resolve(committed);
    },
  };
  const service = new IngestService({
    ensure: () => {
      uploads += 1;
      return Promise.resolve();
    },
  }, batches as never);
  const { record, options } = retryOptions(() => ({ batches, service }));

  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );

  assert(response.status === 200, `status ${response.status}`);
  const body = await response.json();
  assert(body.batch_id === "00000000-0000-4000-8000-0000000000b1");
  assert(commits === 1, "the retry must not attempt a second insert");
  assert(uploads === 1, "the retry must not upload again after commit");
  assert(record.discarded === 1);
});

Deno.test("persistent connection failure answers 503 database_unavailable", async () => {
  let factoryCalls = 0;
  const { record, options } = retryOptions(() => {
    factoryCalls += 1;
    return {
      batches: {
        resolveAttribution: () =>
          Promise.reject(connectionError("CONNECT_TIMEOUT")),
      },
      service: {},
    };
  });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 503);
  assert(response.headers.get("Retry-After") === "5");
  assert(response.headers.get("Cache-Control") === "no-store");
  const body = await response.json();
  assert(body.error.code === "database_unavailable");
  assert(!JSON.stringify(body).includes("pooler"));
  assert(factoryCalls === DATABASE_ATTEMPTS);
  assert(record.discarded === DATABASE_ATTEMPTS);
  assert(record.sleeps.length === DATABASE_ATTEMPTS - 1);
});

Deno.test("no retry starts once the retry window has passed", async () => {
  let factoryCalls = 0;
  const { options } = retryOptions(() => {
    factoryCalls += 1;
    return {
      batches: {
        resolveAttribution: () =>
          Promise.reject(connectionError("CONNECT_TIMEOUT")),
      },
      service: {},
    };
  }, { elapsedPerAttemptMs: DATABASE_RETRY_WINDOW_MS });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 503);
  assert(factoryCalls === 1);
});

Deno.test("exclusions retry a connection failure too", async () => {
  const calls: { attribution: unknown; ids: readonly string[] }[] = [];
  let attempts = 0;
  const backend = exclusionsBackend(calls, () => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(connectionError("ECONNRESET"))
      : Promise.resolve({ accepted: 0, total: 1 });
  });
  const { record, options } = retryOptions(backend);
  const response = await handleRequest(exclusionsRequest([ROOT]), options);
  assert(response.status === 200);
  assert((await response.json()).total === 1);
  assert(calls.length === 2 && record.discarded === 1);
});

Deno.test("non-connection failures are not retried", async () => {
  for (
    const [error, status] of [
      [new IngestError("range_overlap", "overlap", 409), 409],
      [Object.assign(new Error("slow"), { code: "57014" }), 500],
      [new Error("boom"), 500],
    ] as [Error, number][]
  ) {
    let factoryCalls = 0;
    const { record, options } = retryOptions(() => {
      factoryCalls += 1;
      return {
        batches: { resolveAttribution: () => Promise.reject(error) },
        service: {},
      };
    });
    const response = await handleRequest(
      await requestFor("user@e3group.ai"),
      options,
    );
    assert(response.status === status, `${error.message}: ${response.status}`);
    assert(factoryCalls === 1 && record.discarded === 0);
    assert(response.headers.get("Retry-After") === null);
  }
});

Deno.test("detached postgres.js connection errors do not crash the worker", () => {
  const detached = new PromiseRejectionEvent("unhandledrejection", {
    promise: Promise.resolve(),
    reason: connectionError("CONNECT_TIMEOUT"),
    cancelable: true,
  });
  globalThis.dispatchEvent(detached);
  assert(detached.defaultPrevented, "connection rejection must be absorbed");

  const nextWrite = new TypeError(
    "Cannot read properties of null (reading 'write')",
  );
  nextWrite.stack =
    `TypeError: x\n    at nextWrite (file:///node_modules/postgres/3.4.7/src/connection.js:1:1)`;
  const thrown = new ErrorEvent("error", {
    error: nextWrite,
    cancelable: true,
  });
  globalThis.dispatchEvent(thrown);
  assert(thrown.defaultPrevented, "nextWrite crash must be absorbed");

  const unrelated = new PromiseRejectionEvent("unhandledrejection", {
    promise: Promise.resolve(),
    reason: new Error("a real bug"),
    cancelable: true,
  });
  globalThis.dispatchEvent(unrelated);
  assert(!unrelated.defaultPrevented, "other crashes must stay visible");
});

Deno.test("a request that outlives its deadline answers 503 and drops the client", async () => {
  let discarded = 0;
  const started = performance.now();
  const response = await handleRequest(await requestFor("user@e3group.ai"), {
    environment: ENVIRONMENT,
    backendFactory: (() => ({
      batches: { resolveAttribution: () => new Promise(() => {}) },
      service: {},
    })) as never,
    discardBackend: () => {
      discarded += 1;
    },
    requestDeadlineMs: 50,
  });
  assert(response.status === 503, `status ${response.status}`);
  assert(response.headers.get("Retry-After") === "5");
  assert((await response.json()).error.code === "ingest_timeout");
  assert(discarded === 1);
  assert(performance.now() - started < 1_000);
});
