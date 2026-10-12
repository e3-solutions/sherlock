// Read-only end-to-end benchmark. Never prints excerpts, tokens or SQL.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DirectFlameSource } from "../src/server/flame-source.js";
import { createMcpHttpRoute } from "../src/server/mcp-http.js";
import { createSherlockSearchSource } from "../src/server/mcp-search-source.js";
import { createBonaparteMcpProtocol } from "../src/server/mcp-server.js";

const local = process.argv.includes("--local");
const compareGrouping = process.argv.includes("--compare-grouping");
const samples = Number(process.env.SHERLOCK_BENCH_SAMPLES ?? 5);
assert(Number.isInteger(samples) && samples >= 1 && samples <= 20, "Use 1-20 samples");
const token = process.env.SHERLOCK_MCP_TOKEN;
assert(token?.length >= 32, "Set SHERLOCK_MCP_TOKEN from the secret manager");
let source, protocol, server, client;
const measurements = [];
function summary(name, values) {
  const times = values.map(x => x.ms).sort((a,b) => a-b);
  return { name, samples: values.length, medianMs: Math.round(times[Math.floor(times.length/2)]),
    p95Ms: Math.round(times[Math.ceil(times.length*0.95)-1]), maximumBytes: Math.max(...values.map(x=>x.bytes)),
    returned: values.at(-1).returned, budgetReached: values.at(-1).budgetReached ?? false,
    ...(values.at(-1).distinctExcerpts === undefined ? {} : {
      distinctExcerpts: values.at(-1).distinctExcerpts,
      groupedOccurrences: values.at(-1).groupedOccurrences,
      alternativeSources: values.at(-1).alternativeSources,
    }) };
}
try {
  let url = process.env.SHERLOCK_MCP_URL;
  if (local) {
    source = new DirectFlameSource({ databaseUrl: process.env.SUPABASE_DB_URL,
      workspaceId: process.env.SHERLOCK_WORKSPACE_ID,
      expectedEmailDomain: process.env.SHERLOCK_DASHBOARD_EMAIL_DOMAIN });
    protocol = createBonaparteMcpProtocol(createSherlockSearchSource(source));
    const route = createMcpHttpRoute({ token, protocolHandler: protocol.handler });
    server = createServer(async (request, response) => {
      if (request.url === "/mcp") await route(request, response);
      else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
  }
  assert(url, "Set SHERLOCK_MCP_URL or use --local with database configuration");
  client = new Client({ name: "sherlock-search-benchmark", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const discovery = await client.listTools();
  for (const name of ["resolve_person", "search_sessions", "get_session_evidence"]) {
    assert(discovery.tools.some(tool => tool.name === name), `Missing tool ${name}`);
  }
  async function call(name, args) {
    const start = performance.now();
    const response = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
    assert(!response.isError, `Tool failed: ${name}`);
    const result = response.structuredContent;
    assert(["sherlock.search.v1", "sherlock.search.v2"].includes(result?.schemaVersion), "Unexpected schema");
    return { result, ms: performance.now()-start, bytes: Buffer.byteLength(JSON.stringify(response)) };
  }
  const people = await call("resolve_person", { name: process.env.SHERLOCK_BENCH_PERSON ?? "Sharad" });
  assert(!people.result.ambiguous && people.result.matches.length === 1, "Benchmark requires one unambiguous person");
  const personId = people.result.matches[0].personId;
  measurements.push(summary("resolve_person", [{...people,returned:1}]));
  const cases = [
    ["rare_person", { query: "paddleocr", personId }],
    ["ocr_aliases", { query: "ocr OR paddleocr OR tesseract", personId }],
    ["experiment_context", { query: '"Google Vision"', personId }],
    ["broad_workspace", { query: "latency" }],
    ["no_hit", { query: "nonexistentzxqv491" }],
  ];
  if (compareGrouping) {
    // Same transport, identity, query, window and budget. Alternate first mode
    // to reduce cache-order bias. Corrections can still change the candidate set.
    const end = new Date().toISOString();
    for (const [name, request] of cases) {
      const modes = { individual: [], grouped: [] };
      for (let i = 0; i < samples; i++) {
        for (const mode of i % 2 ? ["grouped", "individual"] : ["individual", "grouped"]) {
          const value = await call("search_sessions", { ...request, end, limit: 10,
            groupIdenticalExcerpts: mode === "grouped" });
          const r = value.result;
          assert(r.coverage.groupIdenticalExcerpts === (mode === "grouped"), "Grouping mode ignored");
          assert(r.coverage.state === "partial", "Comparison overclaims coverage");
          assert(r.coverage.candidatesExamined <= 500 && r.results.length <= 10 && value.bytes <= 200_000,
            "Unbounded comparison output");
          if (request.personId) assert(r.results.every(x => x.personId === personId), "Person scope violation");
          if (name === "no_hit") assert(r.results.length === 0, "Synthetic no-hit returned evidence");
          const shownBySession = new Map();
          for (const hit of r.results) {
            shownBySession.set(hit.sessionId, (shownBySession.get(hit.sessionId) ?? 0) + 1);
            assert(shownBySession.get(hit.sessionId) <= 2, "Per-session limit violated");
            assert(hit.excerptGroup.alternativeSources.length <= 5, "Unbounded alternate sources");
          }
          modes[mode].push({ ...value, returned: r.results.length, budgetReached: r.budgetReached,
            distinctExcerpts: new Set(r.results.map(x => x.contentExcerpt)).size,
            groupedOccurrences: r.coverage.groupedOccurrences,
            alternativeSources: r.results.reduce((n, x) => n + x.excerptGroup.alternativeSources.length, 0) });
        }
      }
      for (const [mode, values] of Object.entries(modes)) {
        const record = summary(`${name}_${mode}`, values);
        measurements.push(record); console.log(JSON.stringify(record));
      }
    }
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), fixedEnd: end,
      transport: local ? "local_http_live_reader" : "deployed_http", samples,
      comparison: "current_code_grouping_off_vs_on",
      limitations: ["not_a_frozen_snapshot", "small_sample_not_an_sla", "diversity_not_answer_relevance"], measurements }));
  } else {
    let anchor;
    for (const [name, request] of cases) {
      const times = [];
      for (let i=0;i<samples;i++) {
        const value = await call("search_sessions", {...request,limit:20});
        const r = value.result;
        assert(r.coverage.state === "partial" && r.coverage.candidatesExamined <= 500, "Unbounded/overclaimed search");
        assert(r.results.length <= 20 && value.bytes <= 200_000, "Unbounded output");
        if (personId && request.personId) assert(r.results.every(x=>x.personId===personId), "Person scope violation");
        if (name === "no_hit") assert(r.results.length === 0, "Synthetic no-hit returned evidence");
        if (name === "experiment_context") {
          assert(r.results.length > 0, "No experiment evidence found");
          if (process.env.SHERLOCK_BENCH_EXPECT_SESSION) {
            assert(r.results.some(x=>[x,...(x.excerptGroup?.alternativeSources ?? [])]
              .some(location=>location.sessionId===process.env.SHERLOCK_BENCH_EXPECT_SESSION)), "Missing independently labelled experiment session");
          }
          anchor = r.results[0];
        }
        times.push({...value,returned:r.results.length,budgetReached:r.budgetReached});
      }
      const record = summary(name,times); measurements.push(record); console.log(JSON.stringify(record));
    }
    const contextTimes = [];
    for (let i=0;i<samples;i++) {
      const value = await call("get_session_evidence", { sessionId:anchor.sessionId,anchorEventId:anchor.eventId,limit:30 });
      assert(value.result.events.some(x=>x.isAnchor && x.eventId===anchor.eventId), "Exact source anchor lost");
      assert(value.result.events.every(x=>x.sessionId===anchor.sessionId && x.personId===personId), "Context scope violation");
      assert(value.result.events.length <= 30 && value.bytes <= 350_000, "Unbounded context");
      contextTimes.push({...value,returned:value.result.events.length});
    }
    measurements.push(summary("anchored_context",contextTimes));
    const anchorOnly = await call("get_session_evidence", { sessionId:anchor.sessionId,anchorEventId:anchor.eventId,limit:1 });
    assert(anchorOnly.result.events.length === 1, "Anchor-only bound failed");
    if (anchorOnly.result.nextCursor) {
      const next = await call("get_session_evidence", { sessionId:anchor.sessionId,cursor:anchorOnly.result.nextCursor,limit:2 });
      assert(next.result.events.every(x=>x.eventId!==anchor.eventId), "Cursor repeated anchor");
    }
    const concurrentStart = performance.now();
    const concurrent = await Promise.all(Array.from({length:4}, (_,index) => call("search_sessions", {
      query: index % 2 ? '"Google Vision"' : 'paddleocr', personId, limit:10,
    })));
    const concurrentMs = performance.now()-concurrentStart;
    const concurrency = { callers:4, totalMs:Math.round(concurrentMs),
      slowestMs:Math.round(Math.max(...concurrent.map(x=>x.ms))),
      observedCallsPerSecond:Number((4000/concurrentMs).toFixed(2)) };
    assert(concurrent.every(x => x.result.results.every(r=>r.personId===personId)), "Concurrent scope violation");
    const unauthorized = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert(unauthorized.status === 401, "Missing bearer must be refused");
    const origin = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,Origin:"https://example.invalid"},body:"{}"});
    assert(origin.status === 403, "Browser origin must be refused");
    console.log(JSON.stringify({ target:local?"local HTTP + live reader database":"deployed HTTP MCP",
      observedAt:new Date().toISOString(),tools:discovery.tools.map(x=>x.name),measurements,concurrency,
      checks:["official_client_discovery","person_scope","bounded_candidates_and_output","exact_anchor","cursor","bearer","origin"],
      inferenceLimit:"Targeted warm-cache cases, not population recall or maximum sustainable throughput." }));
  }
} finally {
  await client?.close();
  await protocol?.close();
  if (server) await new Promise(resolve=>server.close(resolve));
  await source?.close();
}
