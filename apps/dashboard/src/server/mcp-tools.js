import { BUCKET_COUNT, BUCKET_MS } from "./flame-source.js";

const MAX_ANALYSIS_PEOPLE = 20;
const MAX_FEEDBACK_PROMPTS = 20;
const MAX_FEEDBACK_SESSIONS = 10;

export class McpEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "McpEvidenceError";
    this.code = code;
  }
}

function finiteCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new McpEvidenceError("mcp_evidence_invalid");
  }
  return count;
}

function personSummary(person, start, includeBuckets) {
  if (!Array.isArray(person.buckets) || person.buckets.length !== BUCKET_COUNT) {
    throw new McpEvidenceError("mcp_evidence_invalid");
  }
  const startMs = new Date(start).getTime();
  const bucketFacts = person.buckets.map((bucket, index) => {
    if (!Array.isArray(bucket) || bucket.length !== 4) {
      throw new McpEvidenceError("mcp_evidence_invalid");
    }
    const [agent, subagent, unclassified, prompts] = bucket.map(finiteCount);
    return {
      start: new Date(startMs + index * BUCKET_MS).toISOString(),
      agent,
      subagent,
      unclassified,
      prompts,
    };
  });
  const activeBuckets = bucketFacts.filter(({ agent, subagent, unclassified }) =>
    agent > 0 || subagent > 0 || unclassified > 0
  );
  const total = Array.isArray(person.total) ? person.total.map(finiteCount) : [];
  if (total.length !== 3) throw new McpEvidenceError("mcp_evidence_invalid");

  const result = {
    id: String(person.id),
    name: String(person.name),
    lastActivity: person.lastActivity ?? null,
    activeSeconds: finiteCount(person.activeSeconds),
    activeBucketCount: activeBuckets.length,
    promptCount: bucketFacts.reduce((sum, bucket) => sum + bucket.prompts, 0),
    distinctSessions: {
      agent: total[0],
      subagent: total[1],
      unclassified: total[2],
    },
  };
  if (includeBuckets) {
    result.buckets = bucketFacts.filter(({ agent, subagent, unclassified, prompts }) =>
      agent > 0 || subagent > 0 || unclassified > 0 || prompts > 0
    );
  }
  return result;
}

export function summarizeUsage(
  payload,
  { personIds = [], includeBuckets = false, offset = 0 } = {},
) {
  if (!Array.isArray(personIds) || personIds.length > MAX_ANALYSIS_PEOPLE ||
      !Number.isInteger(offset) || offset < 0 ||
      (personIds.length > 0 && offset !== 0)) {
    throw new McpEvidenceError("mcp_usage_request_invalid");
  }
  const people = Array.isArray(payload?.people) ? payload.people : [];
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const selected = personIds.length === 0
    ? people.slice(offset, offset + MAX_ANALYSIS_PEOPLE)
    : personIds.map((id) => {
      const person = byId.get(String(id));
      if (!person) throw new McpEvidenceError("mcp_person_not_found");
      return person;
    });
  return {
    window: { start: payload.start, read: payload.read },
    analysisReceipt: payload.snapshot,
    coverage: payload.coverage,
    roster: {
      offset: personIds.length === 0 ? offset : 0,
      returned: selected.length,
      available: people.length,
      truncated: personIds.length === 0 && offset + selected.length < people.length,
      nextOffset: personIds.length === 0 && offset + selected.length < people.length
        ? offset + selected.length
        : null,
    },
    people: selected.map((person) => personSummary(person, payload.start, includeBuckets)),
  };
}

function validateBucketStart(bucketStart) {
  const bucketMs = new Date(bucketStart).getTime();
  if (!Number.isFinite(bucketMs) || bucketMs % BUCKET_MS !== 0 ||
      new Date(bucketMs).toISOString() !== bucketStart) {
    throw new McpEvidenceError("mcp_prompt_request_invalid");
  }
}

function promptFromItem(item, sessionId) {
  const content = String(item.content ?? "");
  return {
    id: String(item.id),
    sessionId,
    at: String(item.at),
    content,
    truncated: Boolean(item.truncated),
    measurements: {
      characters: content.length,
      words: content.trim() ? content.trim().split(/\s+/u).length : 0,
      lines: content === "" ? 0 : content.split("\n").length,
    },
  };
}

export async function collectPromptFeedbackContext(source, {
  personId,
  bucketStart,
  analysisReceipt,
  maxPrompts = 10,
}) {
  if (!Number.isInteger(maxPrompts) || maxPrompts < 1 || maxPrompts > MAX_FEEDBACK_PROMPTS) {
    throw new McpEvidenceError("mcp_prompt_request_invalid");
  }
  if (typeof analysisReceipt !== "string" || analysisReceipt.length === 0 ||
      analysisReceipt.length > 8192) {
    throw new McpEvidenceError("mcp_prompt_request_invalid");
  }
  validateBucketStart(bucketStart);
  const day = await source.fetchDay();
  const person = day.people.find((candidate) => String(candidate.id) === personId);
  if (!person) throw new McpEvidenceError("mcp_person_not_found");

  const interval = await source.fetchInterval({
    personId,
    start: bucketStart,
    snapshot: analysisReceipt,
  });
  const primaryWork = interval.work
    .filter((work) => work.role === "agent")
    .slice(0, MAX_FEEDBACK_SESSIONS);
  const pages = await Promise.all(primaryWork.map((work) => source.fetchWork({
    personId,
    start: bucketStart,
    sessionId: work.sessionId,
    role: work.role,
    snapshot: analysisReceipt,
    cursor: "",
    limit: "100",
  })));
  const allPrompts = pages.flatMap((page) => page.items
    .filter((item) => item.role === "user")
    .map((item) => promptFromItem(item, page.sessionId)))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  if (allPrompts.length === 0) {
    throw new McpEvidenceError("mcp_prompt_bucket_empty");
  }
  const prompts = allPrompts.slice(0, maxPrompts);

  return {
    person: { id: personId, name: String(person.name) },
    window: {
      start: bucketStart,
      end: new Date(new Date(bucketStart).getTime() + BUCKET_MS).toISOString(),
    },
    prompts,
    evidence: {
      source: "canonical_normalized_excerpts",
      analysisReceipt,
      coverage: day.coverage,
      storedExcerptLimitBytes: 1024,
      truncatedPromptCount: prompts.filter((prompt) => prompt.truncated).length,
      moreConversationAvailable: pages.some((page) => Boolean(page.nextCursor)) ||
        allPrompts.length > prompts.length || interval.work.length > primaryWork.length,
    },
    coaching: {
      instructions: "Give specific, constructive prompt feedback grounded only in these excerpts. Do not infer personal traits, intent, seniority, or performance. State when truncation or partial coverage limits a conclusion.",
      dimensions: [
        "goal_clarity",
        "relevant_context",
        "constraints_and_boundaries",
        "success_criteria",
        "verification_request",
      ],
      responseShape: [
        "what_worked",
        "highest_leverage_improvement",
        "example_rewrite",
        "evidence_limitations",
      ],
    },
  };
}
