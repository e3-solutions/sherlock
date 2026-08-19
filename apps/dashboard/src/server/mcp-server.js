import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  McpEvidenceError,
  collectPromptFeedbackContext,
  summarizeUsage,
} from "./mcp-tools.js";

const UUID = z.string().uuid();
const ISO_TIMESTAMP = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "Expected a canonical ISO-8601 UTC timestamp");

function success(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error) {
  const code = error instanceof McpEvidenceError
    ? error.code
    : "mcp_evidence_unavailable";
  return { content: [{ type: "text", text: code }], isError: true };
}

export function registerBonaparteTools(server, source) {
  server.registerTool(
    "analyze_usage",
    {
      title: "Analyze Bonaparte usage",
      description: "Return bounded, workspace-scoped facts about observed Agent, Subagent, prompt, and active-bucket evidence from the last 24 hours. This is observed activity, not continuous attention or a performance score.",
      inputSchema: z.object({
        personIds: z.array(UUID).max(20).default([])
          .describe("Optional person IDs from a prior analysis; omit for the first 20 people."),
        offset: z.number().int().min(0).default(0)
          .describe("Roster offset when personIds is empty; use roster.nextOffset to continue."),
        includeBuckets: z.boolean().default(false)
          .describe("Include only non-empty ten-minute buckets for timeline analysis."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return success(summarizeUsage(await source.fetchDay(), args));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_prompt_feedback_context",
    {
      title: "Get prompt feedback context",
      description: "Return canonical primary human prompt excerpts and a coaching rubric so the calling agent can give constructive, evidence-backed feedback. The server does not score people or persist feedback.",
      inputSchema: z.object({
        personId: UUID.describe("Person ID returned by analyze_usage."),
        bucketStart: ISO_TIMESTAMP.describe("A ten-minute bucket start returned by analyze_usage."),
        analysisReceipt: z.string().min(1).max(8192)
          .describe("Opaque analysisReceipt returned by analyze_usage; pins prompt evidence to that snapshot."),
        maxPrompts: z.number().int().min(1).max(20).default(10),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return success(await collectPromptFeedbackContext(source, args));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

export function createBonaparteMcpProtocol(source) {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "bonaparte-usage", version: "0.1.0" },
      {
        instructions: "Use analyze_usage before requesting prompt feedback. Treat every result as partial observed evidence, never as continuous attention or a personnel performance score. Prompt feedback must stay constructive, quote minimally, distinguish evidence from inference, and mention truncation or coverage limits.",
      },
    );
    registerBonaparteTools(server, source);
    return server;
  }, { responseMode: "json" });
  return {
    handler: toNodeHandler(handler),
    close: () => handler.close(),
  };
}
