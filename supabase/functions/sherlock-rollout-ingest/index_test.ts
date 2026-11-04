import {
  type BatchManifest,
  CONTRACT_VERSION,
  IngestError,
  sha256Hex,
} from "./contract.ts";
import {
  DATABASE_ATTEMPTS,
  DATABASE_RETRY_MIN_REMAINING_MS,
  FORWARD_FALLBACK_MIN_REMAINING_MS,
  FORWARDED_DEADLINE_HEADER,
  FORWARDED_FROM_HEADER,
  handleRequest,
  ingestDatabaseUrl,
  parseWorkloadClassHint,
  REQUEST_DEADLINE_MS,
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
  const record = {
    discarded: 0,
    reasons: [] as string[],
    sleeps: [] as number[],
  };
  let clock = 0;
  return {
    record,
    options: {
      environment: ENVIRONMENT,
      backendFactory: backendFactory as never,
      discardBackend: (_: unknown, reason?: string) => {
        record.discarded += 1;
        record.reasons.push(reason ?? "");
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

Deno.test("no retry starts with too little of the deadline left", async () => {
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
  }, {
    elapsedPerAttemptMs: REQUEST_DEADLINE_MS - DATABASE_RETRY_MIN_REMAINING_MS +
      1,
  });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 503);
  assert(factoryCalls === 1);
});

Deno.test("a client destroyed 10 s into a request is still retried", async () => {
  // On Nov 2, requests that lost their client to a neighbour's deadline
  // gave up because they were past a fixed 9 s window.
  let factoryCalls = 0;
  const { record, options } = retryOptions(() => {
    factoryCalls += 1;
    const attempt = factoryCalls;
    return {
      batches: {
        resolveAttribution: () =>
          attempt === 1
            ? Promise.reject(connectionError("CONNECTION_DESTROYED"))
            : Promise.resolve(ATTRIBUTION),
      },
      service: {
        ingest: (attribution: Record<string, string>) =>
          Promise.resolve({ status: "committed", ...attribution }),
      },
    };
  }, { elapsedPerAttemptMs: 10_000 });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 200, `status ${response.status}`);
  assert(factoryCalls === 2);
  assert(record.reasons.join() === "broken");
});

Deno.test("CONNECTION_ENDED from a retired client is retried", async () => {
  let factoryCalls = 0;
  const { options } = retryOptions(() => {
    factoryCalls += 1;
    const attempt = factoryCalls;
    return {
      batches: {
        resolveAttribution: () =>
          attempt === 1
            ? Promise.reject(connectionError("CONNECTION_ENDED"))
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
  assert(response.status === 200);
  assert(factoryCalls === 2);
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

Deno.test("a request that outlives its deadline answers 503 and retires the client", async () => {
  let discarded = 0;
  let reason = "";
  const started = performance.now();
  const response = await handleRequest(await requestFor("user@e3group.ai"), {
    environment: ENVIRONMENT,
    backendFactory: (() => ({
      batches: { resolveAttribution: () => new Promise(() => {}) },
      service: {},
    })) as never,
    discardBackend: (_, why) => {
      discarded += 1;
      reason = why ?? "";
    },
    // 3.1 s deadline, of which reading the request "took" 3.05 s.
    requestDeadlineMs: 3_100,
    now: (() => {
      let calls = 0;
      return () => (calls++ === 0 ? 0 : 3_050);
    })(),
  });
  assert(response.status === 503, `status ${response.status}`);
  assert(response.headers.get("Retry-After") === "5");
  assert((await response.json()).error.code === "ingest_timeout");
  assert(discarded === 1);
  assert(reason === "deadline", "a neighbour's client is retired, not killed");
  assert(performance.now() - started < 1_000);
});

const FORWARD_ENVIRONMENT =
  (region: string, extra: Record<string, string> = {}) => (name: string) =>
    ({
      SHERLOCK_E3_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
      SHERLOCK_SIXTYFOUR_WORKSPACE_ID: "00000000-0000-4000-8000-000000000002",
      SUPABASE_URL: "https://project.supabase.co",
      SB_REGION: region,
      ...extra,
    })[name];

function noBackend(): never {
  throw new Error("the database must not be touched here");
}

Deno.test("a request served outside us-east-1 is forwarded there once", async () => {
  const request = await requestFor("user@e3group.ai");
  request.headers.set("x-sherlock-workload-class", "backfill");
  const sent = await request.clone().arrayBuffer();
  let call: { url: string; init: RequestInit } | null = null;
  const response = await handleRequest(request, {
    environment: FORWARD_ENVIRONMENT("ap-south-1"),
    backendFactory: noBackend as never,
    fetcher: ((url: URL, init: RequestInit) => {
      call = { url: String(url), init };
      return Promise.resolve(
        Response.json({ status: "committed", batch_id: "b1" }, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "x-sb-edge-region": "us-east-1",
          },
        }),
      );
    }) as typeof fetch,
  });
  assert(response.status === 200);
  assert((await response.json()).batch_id === "b1");
  assert(response.headers.get("Cache-Control") === "no-store");
  assert(call !== null);
  const { url, init } = call as { url: string; init: RequestInit };
  assert(
    url ===
      "https://project.supabase.co/functions/v1/sherlock-rollout-ingest?forceFunctionRegion=us-east-1",
    url,
  );
  const headers = new Headers(init.headers);
  assert(headers.get("x-region") === "us-east-1");
  assert(headers.get(FORWARDED_FROM_HEADER) === "ap-south-1");
  const deadline = Number(headers.get(FORWARDED_DEADLINE_HEADER));
  assert(
    deadline > 15_000 && deadline < REQUEST_DEADLINE_MS - 900,
    `forwarded deadline ${deadline} must leave the caller time to answer`,
  );
  assert(headers.get("x-sherlock-workload-class") === "backfill");
  assert(
    new Uint8Array(init.body as Uint8Array).toString() ===
      new Uint8Array(sent).toString(),
    "the forwarded body must be byte-identical",
  );
});

Deno.test("forwarded answers pass through, including 409 and 503", async () => {
  for (
    const [status, code] of [[409, "range_overlap"], [
      503,
      "ingest_timeout",
    ]] as const
  ) {
    const response = await handleRequest(await requestFor("user@e3group.ai"), {
      environment: FORWARD_ENVIRONMENT("ap-south-1"),
      backendFactory: noBackend as never,
      fetcher: (() =>
        Promise.resolve(
          Response.json({ error: { code } }, {
            status,
            headers: { "Retry-After": "5" },
          }),
        )) as typeof fetch,
    });
    assert(response.status === status);
    assert((await response.json()).error.code === code);
    assert(
      response.headers.get("Retry-After") === "5",
      "Retry-After must survive the hop",
    );
  }
});

Deno.test("no forward in us-east-1, when already forwarded, or when disabled", async () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["us-east-1", {}, false],
    ["ap-south-1", { SHERLOCK_INGEST_DATABASE_REGION: "off" }, false],
    ["ap-south-1", {}, true],
  ];
  for (const [region, extra, alreadyForwarded] of cases) {
    const request = await requestFor("user@e3group.ai");
    if (alreadyForwarded) {
      request.headers.set(FORWARDED_FROM_HEADER, "ap-south-1");
    }
    let fetched = false;
    const response = await handleRequest(request, {
      environment: FORWARD_ENVIRONMENT(region, extra),
      backendFactory: (() => ({
        batches: { resolveAttribution: () => Promise.resolve(ATTRIBUTION) },
        service: {
          ingest: (attribution: Record<string, string>) =>
            Promise.resolve({ status: "committed", ...attribution }),
        },
      })) as never,
      fetcher: (() => {
        fetched = true;
        return Promise.reject(new Error("must not forward"));
      }) as typeof fetch,
    });
    assert(response.status === 200, `${region} ${response.status}`);
    assert(!fetched, `${region} must not forward`);
  }
});

Deno.test("an unreachable database region falls back to ingesting here", async () => {
  let ingested = 0;
  const response = await handleRequest(await requestFor("user@e3group.ai"), {
    environment: FORWARD_ENVIRONMENT("ap-south-1"),
    backendFactory: (() => ({
      batches: { resolveAttribution: () => Promise.resolve(ATTRIBUTION) },
      service: {
        ingest: (attribution: Record<string, string>) => {
          ingested += 1;
          return Promise.resolve({ status: "committed", ...attribution });
        },
      },
    })) as never,
    fetcher: (() =>
      Promise.reject(new TypeError("error sending request"))) as typeof fetch,
  });
  assert(response.status === 200);
  assert(ingested === 1);
});

Deno.test("a forward that outlives the deadline answers 503 without ingesting here", async () => {
  const response = await handleRequest(await requestFor("user@e3group.ai"), {
    environment: FORWARD_ENVIRONMENT("ap-south-1"),
    backendFactory: noBackend as never,
    requestDeadlineMs: 4_100,
    fetcher: ((_: URL, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
        );
      })) as typeof fetch,
  });
  assert(response.status === 503);
  assert((await response.json()).error.code === "ingest_timeout");
  assert(response.headers.get("Retry-After") === "5");
});

Deno.test("a forwarded request keeps to the deadline it was given", async () => {
  const request = await requestFor("user@e3group.ai");
  request.headers.set(FORWARDED_FROM_HEADER, "ap-south-1");
  request.headers.set(FORWARDED_DEADLINE_HEADER, "3100");
  const started = performance.now();
  const response = await handleRequest(request, {
    environment: FORWARD_ENVIRONMENT("us-east-1"),
    backendFactory: (() => ({
      batches: { resolveAttribution: () => new Promise(() => {}) },
      service: {},
    })) as never,
    discardBackend: () => {},
  });
  assert(response.status === 503);
  assert((await response.json()).error.code === "ingest_timeout");
  assert(performance.now() - started < 4_000, "the 18 s default was used");

  // A deadline too short to use answers at once, without the database.
  const tiny = await requestFor("user@e3group.ai");
  tiny.headers.set(FORWARDED_FROM_HEADER, "ap-south-1");
  tiny.headers.set(FORWARDED_DEADLINE_HEADER, "1");
  const refused = await handleRequest(tiny, {
    environment: FORWARD_ENVIRONMENT("us-east-1"),
    backendFactory: noBackend as never,
  });
  assert(refused.status === 503);
  assert((await refused.json()).error.code === "ingest_timeout");

  // Only a forwarded request may shorten it, and never past 18 s.
  const direct = await requestFor("user@e3group.ai");
  direct.headers.set(FORWARDED_DEADLINE_HEADER, "50");
  const fine = await handleRequest(direct, {
    environment: FORWARD_ENVIRONMENT("us-east-1"),
    backendFactory: (() => ({
      batches: {
        resolveAttribution: () =>
          new Promise((resolve) => setTimeout(() => resolve(ATTRIBUTION), 100)),
      },
      service: {
        ingest: (attribution: Record<string, string>) =>
          Promise.resolve({ status: "committed", ...attribution }),
      },
    })) as never,
  });
  assert(fine.status === 200, "a direct request ignores the header");
});

Deno.test("a platform answer from the database region is not passed through", async () => {
  // A gateway 429 or 502 has no ingest error body; the collector would treat
  // an unknown 4xx as fatal for the whole drain.
  for (const status of [429, 502, 404]) {
    let ingested = 0;
    const response = await handleRequest(await requestFor("user@e3group.ai"), {
      environment: FORWARD_ENVIRONMENT("ap-south-1"),
      backendFactory: (() => ({
        batches: { resolveAttribution: () => Promise.resolve(ATTRIBUTION) },
        service: {
          ingest: (attribution: Record<string, string>) => {
            ingested += 1;
            return Promise.resolve({ status: "committed", ...attribution });
          },
        },
      })) as never,
      fetcher: (() =>
        Promise.resolve(
          new Response("rate limited", { status }),
        )) as typeof fetch,
    });
    assert(response.status === 200, `${status} -> ${response.status}`);
    assert(ingested === 1, `${status} must fall back to ingesting here`);
  }
});

Deno.test("without time to ingest here, a failed forward answers 503", async () => {
  let clock = 0;
  const response = await handleRequest(await requestFor("user@e3group.ai"), {
    environment: FORWARD_ENVIRONMENT("ap-south-1"),
    backendFactory: noBackend as never,
    now: () => clock,
    fetcher: (() => {
      clock = REQUEST_DEADLINE_MS - FORWARD_FALLBACK_MIN_REMAINING_MS + 1;
      return Promise.reject(new TypeError("connection reset"));
    }) as typeof fetch,
  });
  assert(response.status === 503);
  assert((await response.json()).error.code === "ingest_timeout");
});

Deno.test("a Storage stall answers 503 with Retry-After and keeps the shared client", async () => {
  let remainingSeen: number | null = null;
  let factoryCalls = 0;
  const { record, options } = retryOptions(() => {
    factoryCalls += 1;
    return {
      batches: { resolveAttribution: () => Promise.resolve(ATTRIBUTION) },
      service: {
        ingest: (
          _attribution: unknown,
          _manifest: unknown,
          _payload: unknown,
          _hint: unknown,
          remainingMs: () => number,
        ) => {
          remainingSeen = remainingMs();
          return Promise.reject(
            new IngestError(
              "storage_unavailable",
              "Storage did not accept the batch in time",
              503,
            ),
          );
        },
      },
    };
  });
  const response = await handleRequest(
    await requestFor("user@e3group.ai"),
    options,
  );
  assert(response.status === 503);
  assert(response.headers.get("Retry-After") === "5");
  assert((await response.json()).error.code === "storage_unavailable");
  assert(remainingSeen === REQUEST_DEADLINE_MS, `saw ${remainingSeen} ms left`);
  assert(factoryCalls === 1, "a Storage failure is not a database retry");
  assert(record.discarded === 0, "the shared database client is kept");
});

Deno.test("a busy worker answers 503 ingest_busy and every request releases its budget", async () => {
  const { MemoryBudget } = await import("./memory_budget.ts");
  const budget = new MemoryBudget(1);
  const reserved = (current: typeof budget): number => current.reservedBytes;
  const { options } = retryOptions(() => ({
    batches: { resolveAttribution: () => Promise.resolve(ATTRIBUTION) },
    service: {
      ingest: () => Promise.resolve({ batch_id: "batch" }),
    },
  }));
  const ok = await handleRequest(await requestFor("user@e3group.ai"), {
    ...options,
    memoryBudget: budget,
  });
  assert(ok.status === 200, `got ${ok.status}`);
  assert(reserved(budget) === 0, "a finished request releases its bytes");

  const held = await budget.reserve(1, 1_000);
  const busy = await handleRequest(await requestFor("user@e3group.ai"), {
    ...options,
    memoryBudget: budget,
    requestDeadlineMs: REQUEST_DEADLINE_MS,
    now: (() => {
      let clock = 0;
      return () => (clock += 5_000);
    })(),
  });
  held();
  assert(busy.status === 503, `got ${busy.status}`);
  assert(busy.headers.get("Retry-After") === "5");
  assert((await busy.json()).error.code === "ingest_busy");
  assert(reserved(budget) === 0);
});
