import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCloudActivity, capabilities } from "./src/server/cloud-activity.js";
import { FileCheckpointStore } from "./src/server/cloud-activity-store.js";
import { recoveredIntervals, mergeRecoveredTimeline } from "./src/server/thread-activity-recovery.js";
import { listUsageEvidence } from "./src/server/mcp-tools.js";

// Synthetic, offline demo. No credentials, network, production rows or raw logs.
const fixture = JSON.parse(await readFile(new URL("./fixtures/cloud-activity-demo.json", import.meta.url), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "sherlock-cloud-demo-"));
try {
  const rows = new Map(), readThread = async ({ cursor }) => fixture.pages[cursor ? 1 : 0];
  const receipt = await collectCloudActivity({ scope: fixture.scope, readThread,
    now: () => fixture.observedAt, store: new FileCheckpointStore(join(directory, "checkpoint.json")),
    sink: { commit: async ({ scope, manifestText, manifestSha256 }) => {
      rows.set(manifestSha256, { person_id: scope.personId, manifest_text: manifestText, manifest_sha256: manifestSha256, native_ids: [] });
    } } });
  const read = new Date(fixture.observedAt * 1000).toISOString();
  const payload = mergeRecoveredTimeline({ start: "2026-10-05T04:00:00.000Z", read,
    snapshot: `v4.${Buffer.from(JSON.stringify(["100:100:", read])).toString("base64url")}`,
    people: [{ id: fixture.scope.personId, name: "Synthetic operator", total: [0, 0, 0],
      buckets: Array.from({ length: 144 }, () => [0, 0, 0, 0]) }] }, recoveredIntervals([...rows.values()]));
  console.log(JSON.stringify({ capability: capabilities(readThread), receipt,
    query: listUsageEvidence(payload), firstThreeBuckets: payload.people[0].buckets.slice(0, 3) }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
