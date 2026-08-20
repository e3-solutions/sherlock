import {
  BUCKET_MS,
  DirectFlameSource,
} from "../../apps/dashboard/src/server/flame-source.js";

const [databaseUrl, workspaceId] = process.argv.slice(2);
if (!databaseUrl || !workspaceId) {
  throw new Error("database URL and workspace ID are required");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = new DirectFlameSource({ databaseUrl, workspaceId });
try {
  const now = new Date(Date.now() + 60_000);
  const day = await source.fetchDay({ now });
  const person = day.people.find(({ name }) => name === "Oversized Claude E2E");
  assert(person, "dashboard roster is missing the synthetic Claude person");
  const bucketIndex = person.buckets.findIndex((bucket) =>
    bucket[0] > 0 && bucket[1] > 0 && bucket[3] > 0
  );
  assert(bucketIndex >= 0, "dashboard has no mixed Claude activity bucket");
  const bucketStart = new Date(
    new Date(day.start).getTime() + bucketIndex * BUCKET_MS,
  ).toISOString();
  const interval = await source.fetchInterval({
    personId: person.id,
    start: bucketStart,
    snapshot: day.snapshot,
    now,
  });
  const roles = new Set(interval.work.map(({ role }) => role));
  assert(
    roles.has("agent"),
    "dashboard interval is missing primary Claude work",
  );
  assert(
    roles.has("subagent"),
    "dashboard interval is missing Claude subagent work",
  );
  assert(
    interval.prompts.some(({ content }) =>
      content === "activity after the oversized Claude record"
    ),
    "dashboard interval is missing the later primary Claude prompt",
  );
  assert(interval.prompts.length === 1, "dashboard prompt count is not exact");
  const primary = interval.work.find(({ role }) => role === "agent");
  const subagent = interval.work.find(({ role }) => role === "subagent");
  assert(primary, "dashboard interval is missing the primary work header");
  assert(subagent, "dashboard interval is missing the subagent work header");
  const detail = await source.fetchWork({
    personId: person.id,
    start: bucketStart,
    sessionId: primary.sessionId,
    role: primary.role,
    snapshot: day.snapshot,
    now,
  });
  const contents = detail.items.map(({ content }) => content);
  assert(
    contents.includes("activity after the oversized Claude record"),
    "dashboard detail is missing the later Claude user message",
  );
  assert(
    contents.includes("Claude activity survived oversized input."),
    "dashboard detail is missing the later Claude assistant message",
  );
  const subagentDetail = await source.fetchWork({
    personId: person.id,
    start: bucketStart,
    sessionId: subagent.sessionId,
    role: subagent.role,
    snapshot: day.snapshot,
    now,
  });
  const subagentContents = subagentDetail.items.map(({ content }) => content);
  assert(
    subagentContents.includes("subagent after oversized input"),
    "dashboard detail is missing the Claude subagent prompt",
  );
  assert(
    subagentContents.includes("Subagent activity survived."),
    "dashboard detail is missing the Claude subagent response",
  );
  process.stdout.write(JSON.stringify({
    personId: person.id,
    bucketStart,
    roles: [...roles].sort(),
    promptCount: interval.prompts.length,
    detailCount: detail.items.length,
    subagentDetailCount: subagentDetail.items.length,
    snapshotVersion: day.snapshot.split(".", 1)[0],
  }));
} finally {
  await source.close();
}
